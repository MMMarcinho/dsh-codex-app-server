import { CodexRpcClient } from './rpc.mjs';

const abortError = () => Object.assign(new Error('Codex turn interrupted'), { name: 'AbortError' });
function bounded(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  })]).finally(() => clearTimeout(timer));
}

function abortable(promise, signal) {
  let onAbort;
  return Promise.race([promise, new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  })]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** Owns one persistent Codex thread for one DSH session. Never retries a turn. */
export class CodexSession {
  constructor({ cwd, threadId, saveThreadId = async () => {}, onServerRequest,
    createClient = options => new CodexRpcClient(options), model,
    requestTimeoutMs = 60_000, interruptTimeoutMs = 5_000 } = {}) {
    if (typeof cwd !== 'string' || !cwd) throw new TypeError('cwd is required');
    if (threadId != null && (typeof threadId !== 'string' || !threadId)) throw new TypeError('Invalid threadId');
    Object.assign(this, { cwd, threadId, saveThreadId, onServerRequest, createClient, model,
      requestTimeoutMs, interruptTimeoutMs });
    this.client = null;
    this.active = null;
    this.disposed = false;
  }

  async _dispose() {
    this.disposed = true;
    const client = this.client;
    this.client = null;
    if (client) await bounded(Promise.resolve().then(() => client.close()), this.interruptTimeoutMs, 'Codex close');
  }

  async close() {
    if (this.active) {
      this.active.aborted = true;
      this.active.controller.abort();
      this.active.wake();
    }
    await this._dispose();
  }

  async _prepare() {
    if (this.client) return;
    this.client = this.createClient({ cwd: this.cwd, onServerRequest: async (method, params, requestContext) => {
      const state = this.active;
      if (!state || state.aborted || state.controller.signal.aborted || this.disposed) throw new Error('No active Codex turn for server request');
      if (!this.onServerRequest) throw new Error(`Unsupported Codex server request: ${method}`);
      const transportSignal = requestContext?.signal || (requestContext instanceof AbortSignal ? requestContext : null);
      const signal = transportSignal
        ? AbortSignal.any([state.controller.signal, transportSignal]) : state.controller.signal;
      if (signal.aborted) throw abortError();
      if (params?.threadId != null && params.threadId !== this.threadId) throw new Error('Mismatched approval thread');
      if (params?.turnId != null && !state.turnId && state.starting) {
        await abortable(bounded(state.ack, this.requestTimeoutMs, 'Codex turn acknowledgement'), signal);
      }
      if (params?.turnId != null && params.turnId !== state.turnId) throw new Error('Mismatched approval turn');
      if (state.terminal || this.active !== state || signal.aborted) throw new Error('No active Codex turn for server request');
      const fileChange = method === 'item/fileChange/requestApproval'
        && params?.threadId === this.threadId && params?.turnId === state.turnId
        ? state.fileChanges.get(params.itemId) : undefined;
      try { return await this.onServerRequest(method, params, signal, { fileChange }); }
      finally { if (fileChange) state.fileChanges.delete(params.itemId); }
    } });
    const client = this.client;
    client.on('notification', (method, params) => this._notification(method, params));
    client.on('closed', error => {
      this.disposed = true;
      const state = this.active;
      if (state && !state.terminal) {
        state.error = error instanceof Error ? error : new Error('Codex transport closed before turn completion');
        state.wake();
      }
    });
    await bounded(client.start({ capabilities: { experimentalApi: true, requestAttestation: false } }),
      this.requestTimeoutMs, 'Codex startup');
    if (this.disposed || this.active?.aborted) throw abortError();
    const common = { cwd: this.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user',
      ...(this.model ? { model: this.model } : {}) };
    const previousId = this.threadId;
    const response = await this._request(previousId ? 'thread/resume' : 'thread/start', previousId
      ? { ...common, threadId: previousId, excludeTurns: true }
      : { ...common, ephemeral: false });
    if ((response?.approvalPolicy != null && response.approvalPolicy !== 'on-request')
      || (response?.approvalsReviewer != null && response.approvalsReviewer !== 'user')
      || (response?.sandbox != null && response.sandbox.type !== 'workspaceWrite')) {
      throw new Error('Codex returned different approval or sandbox settings');
    }
    const id = response?.thread?.id;
    if (typeof id !== 'string' || !id || (previousId && previousId !== id)) {
      throw new Error('Codex returned an invalid or mismatched thread ID');
    }
    if (this.disposed || this.active?.aborted) throw abortError();
    if (response.thread.status?.type === 'active' || response.thread.status?.type === 'systemError') {
      throw new Error('Cannot start a turn on an active or unhealthy Codex thread');
    }
    this.threadId = id;
    if (!previousId) await this.saveThreadId(id);
  }

  _request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.client || this.disposed) return Promise.reject(new Error('Codex session is closed'));
    return bounded(this.client.request(method, params, { timeoutMs,
      ...(method !== 'turn/interrupt' ? { signal: this.active?.controller.signal } : {}) }), timeoutMs, method);
  }

  _notification(method, params) {
    const state = this.active;
    if (!state || !params || params.threadId !== this.threadId) return;
    // Approval needs only path/change metadata; never retain the patch body.
    if (method === 'item/started' && params.item?.type === 'fileChange') {
      params = { ...params, item: { id: params.item.id, type: 'fileChange',
        changes: Array.isArray(params.item.changes) ? params.item.changes.map((change) => ({ path: change?.path, kind: change?.kind })) : [] } };
    }
    if (!state.turnId) {
      if (!state.starting) return;
      if (state.preAck.length >= 4096) {
        state.error = new Error('Too many Codex notifications before turn acknowledgement');
        state.wake();
      } else state.preAck.push([method, params]);
      return;
    }
    const turnId = method === 'turn/completed' ? params.turn?.id : params.turnId;
    if (turnId !== state.turnId || state.terminal) return;
    try {
      const append = (type, key, text, final = false) => {
        if (typeof text !== 'string' || state.finalItems.has(key)) return;
        const seen = state.text.get(key) || '';
        if (final && !text.startsWith(seen)) throw new Error('Codex final output differs from streamed output');
        const delta = final ? text.slice(seen.length) : text;
        state.text.set(key, final ? text : seen + text);
        if (final) state.finalItems.add(key);
        if (delta && !state.aborted) state.queue.push({ type, text: delta });
      };
      const itemFinal = item => {
        if (!item || typeof item.id !== 'string') return;
        if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type) && !state.finalItems.has(`progress:${item.id}`)) {
          state.finalItems.add(`progress:${item.id}`);
          const label = { commandExecution: 'Command', fileChange: 'File change', mcpToolCall: 'MCP tool' }[item.type];
          const status = ['completed', 'failed', 'declined'].includes(item.status) ? item.status : 'finished';
          const count = item.type === 'fileChange' && Array.isArray(item.changes) ? ` (${item.changes.length} files)` : '';
          if (!state.aborted) state.queue.push({ type: 'progress', text: `${label} ${status}${count}` });
          state.fileChanges.delete(item.id);
        }
        if (item.type === 'agentMessage') append('text', `text:${item.id}`, item.text, true);
        // Only public summaries, never item.content or reasoning/textDelta.
        if (item.type === 'reasoning' && Array.isArray(item.summary)) {
          item.summary.forEach((text, index) => append('reasoning', `summary:${item.id}:${index}`, text, true));
        }
      };
      if (method === 'item/started' && params.item?.type === 'fileChange' && typeof params.item.id === 'string') {
        state.fileChanges.set(params.item.id, params);
      } else if (method === 'item/agentMessage/delta' && typeof params.itemId === 'string') {
        append('text', `text:${params.itemId}`, params.delta);
      } else if (method === 'item/reasoning/summaryTextDelta' && typeof params.itemId === 'string') {
        append('reasoning', `summary:${params.itemId}:${params.summaryIndex}`, params.delta);
      } else if (method === 'item/completed') itemFinal(params.item);
      else if (method === 'turn/completed') {
        for (const item of params.turn.items || []) itemFinal(item);
        state.terminal = params.turn;
        state.resolveDone();
        state.controller.abort();
      } else if (method === 'error' && !params.willRetry) {
        state.error = new Error('Codex turn failed (server error)');
      }
      if (state.queue.length > 4096) throw new Error('Codex output queue limit exceeded');
    } catch (error) { state.error = error; }
    state.wake();
  }

  _stop(state) {
    if (state.stopPromise) return state.stopPromise;
    state.stopPromise = (async () => {
      if (state.terminal) return;
      if (!state.turnId || this.disposed) { await this._dispose(); return; }
      try {
        // Interrupt acknowledgement alone does not prove the turn is quiescent.
        await Promise.all([
          this._request('turn/interrupt', { threadId: this.threadId, turnId: state.turnId }, this.interruptTimeoutMs),
          bounded(state.done, this.interruptTimeoutMs, 'Codex interruption completion'),
        ]);
      } catch { await this._dispose(); }
    })();
    // The generator awaits it in finally; mark handled if caller is paused on a yield.
    state.stopPromise.catch(() => {});
    return state.stopPromise;
  }

  async *turn(input, { signal } = {}) {
    if (this.active) throw new Error('A Codex turn is already active for this session');
    if (this.disposed) throw new Error('Codex session is closed');
    if (signal?.aborted) throw abortError();
    const content = typeof input === 'string' ? [{ type: 'text', text: input, text_elements: [] }] : input;
    if (!Array.isArray(content) || !content.length) throw new TypeError('Codex input must be text or a non-empty UserInput array');
    let resolveDone, resolveAck;
    const state = { controller: new AbortController(), turnId: null, starting: false, preAck: [], queue: [],
      fileChanges: new Map(), ack: new Promise(resolve => { resolveAck = resolve; }),
      text: new Map(), finalItems: new Set(), terminal: null, error: null, aborted: false,
      wake: () => {}, done: new Promise(resolve => { resolveDone = resolve; }), resolveDone: () => resolveDone() };
    this.active = state;
    const onAbort = () => {
      state.aborted = true;
      state.controller.abort();
      state.wake();
      void this._stop(state);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await abortable(this._prepare(), state.controller.signal);
      if (state.aborted || this.disposed) throw abortError();
      state.starting = true;
      const response = await abortable(this._request('turn/start', { threadId: this.threadId, input: content }), state.controller.signal);
      if (state.aborted || this.disposed) throw abortError();
      const turn = response?.turn;
      if (typeof turn?.id !== 'string' || !turn.id) throw new Error('Codex returned an invalid turn ID');
      state.turnId = turn.id;
      for (const [method, params] of state.preAck.splice(0)) this._notification(method, params);
      resolveAck();
      // Some servers complete a trivial turn in the start response itself.
      if (['completed', 'failed', 'interrupted'].includes(turn.status) && !state.terminal) {
        this._notification('turn/completed', { threadId: this.threadId, turn });
      }
      while (true) {
        if (state.aborted) throw abortError();
        if (state.error) throw state.error;
        if (state.queue.length) { yield state.queue.shift(); continue; }
        if (state.terminal) {
          if (state.terminal.status !== 'completed') {
            throw state.terminal.status === 'interrupted' ? abortError()
              : new Error(state.terminal.status === 'failed' ? 'Codex turn failed (provider failure)' : 'Codex turn ended without completion');
          }
          yield { type: 'completed' };
          return;
        }
        await new Promise(resolve => { state.wake = resolve; });
        state.wake = () => {};
      }
    } catch (error) {
      if (!state.aborted && !state.terminal) await this._dispose().catch(() => {});
      throw state.aborted ? abortError() : error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      state.controller.abort();
      try { if (!state.terminal) await this._stop(state); }
      finally {
        state.fileChanges.clear();
        resolveAck();
        this.active = null;
      }
    }
  }
}
