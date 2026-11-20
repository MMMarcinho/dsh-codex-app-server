import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

// Protocol: https://developers.openai.com/codex/app-server/ (JSONL, no jsonrpc header).
// Also checked against `codex app-server generate-ts` on the installed CLI.
const SERVER_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput',
  'mcpServer/elicitation/request', 'item/tool/call',
  'account/chatgptAuthTokens/refresh', 'attestation/generate',
  'applyPatchApproval', 'execCommandApproval',
]);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const validId = id => typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class RpcError extends Error {
  constructor(message, code = 'RPC_ERROR') { super(message); this.name = 'RpcError'; this.code = code; }
}

/** A single owned stdio process. Never logs payloads, credentials or raw stderr.
 * onServerRequest(method, params, {id, signal}) must explicitly provide a result.
 * No handler, unknown method, undefined result, exception or timeout => RPC error,
 * never consent. The integrating UI remains responsible for obtaining consent.
 * A local request timeout/abort does NOT interrupt a Codex turn or kill the process.
 */
export class CodexRpcClient extends EventEmitter {
  constructor({ command = 'codex', args = ['app-server', '--listen', 'stdio://'],
    cwd, env, spawnImpl = spawn, requestTimeoutMs = 30_000,
    serverRequestTimeoutMs = 30_000, closeTimeoutMs = 2_000,
    maxLineBytes = 16 * 1024 * 1024, onServerRequest } = {}) {
    super();
    for (const n of [requestTimeoutMs, serverRequestTimeoutMs, closeTimeoutMs, maxLineBytes]) {
      if (!Number.isFinite(n) || n <= 0) throw new TypeError('Limits must be positive finite numbers');
    }
    Object.assign(this, { command, args, cwd, env, spawnImpl, requestTimeoutMs,
      serverRequestTimeoutMs, closeTimeoutMs, maxLineBytes, onServerRequest });
    this.state = 'new'; this.pending = new Map(); this.incoming = new Map();
    this.nextId = 1; this.buffer = ''; this.decoder = new StringDecoder('utf8');
  }

  start({ clientInfo = { name: 'dsh_codex_app_server', title: 'DSH Codex', version: '0.1.0' },
    capabilities = null } = {}) {
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'new') return Promise.reject(new RpcError('Client is closed', 'CLOSED'));
    this.state = 'starting';
    this.startPromise = this._start({ clientInfo, capabilities });
    return this.startPromise;
  }

  async _start(params) {
    try {
      this.child = this.spawnImpl(this.command, this.args, {
        cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      });
      const child = this.child;
      this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
      child.on('error', (error) => {
        this._fail(error?.code === 'ENOENT'
          ? new RpcError('Codex CLI not found on the DSH host PATH', 'CODEX_NOT_FOUND')
          : new RpcError('Codex process failed', 'PROCESS_ERROR'));
        this.resolveExit();
      });
      child.on('exit', () => { this._fail(new RpcError('Codex process exited', 'PROCESS_EXIT')); this.resolveExit(); });
      child.on('close', () => { this._fail(new RpcError('Codex process closed', 'PROCESS_EXIT')); this.resolveExit(); });
      if (!child.stdin || !child.stdout) throw new RpcError('Missing stdio streams', 'PROCESS_ERROR');
      child.stdin.on('error', () => this._transportFailure('Codex input failed'));
      child.stdout.on('error', () => this._transportFailure('Codex output failed'));
      child.stdout.on('data', chunk => this._data(chunk));
      child.stdout.on('end', () => this._fail(new RpcError('Codex output ended', 'PROCESS_EXIT')));
      // Drain, but deliberately never expose stderr (it can contain sensitive input).
      child.stderr?.on('data', () => {});
      child.stderr?.on('error', () => {});
      const result = await this._request('initialize', params, {});
      if (this.state !== 'starting') throw new RpcError('Client is closed', 'CLOSED');
      this._send({ method: 'initialized', params: {} });
      this.state = 'ready';
      return result;
    } catch (error) {
      await this.close();
      throw error instanceof RpcError ? error : new RpcError('Could not start Codex', 'PROCESS_ERROR');
    }
  }

  request(method, params = {}, options = {}) {
    if (this.state !== 'ready') return Promise.reject(new RpcError('Client is not ready', 'NOT_READY'));
    if (method === 'initialize') return Promise.reject(new RpcError('Already initialized', 'INVALID_REQUEST'));
    return this._request(method, params, options);
  }

  _request(method, params, { timeoutMs = this.requestTimeoutMs, signal } = {}) {
    if (typeof method !== 'string' || !method || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new TypeError('Invalid request method or timeout'));
    if (signal?.aborted) return Promise.reject(new RpcError('Request aborted locally', 'ABORTED'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const done = (error, result) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id); clearTimeout(entry.timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => done(new RpcError('Request aborted locally; remote work may continue', 'ABORTED'));
      const timer = setTimeout(() => done(new RpcError('Request timed out; remote work may continue', 'TIMEOUT')), timeoutMs);
      this.pending.set(id, { done, timer });
      signal?.addEventListener('abort', abort, { once: true });
      try { this._send({ id, method, params }); } catch (error) { done(error); }
    });
  }

  notify(method, params = {}) {
    if (this.state !== 'ready') throw new RpcError('Client is not ready', 'NOT_READY');
    if (typeof method !== 'string' || !method || ['initialize', 'initialized'].includes(method))
      throw new TypeError('Invalid notification method');
    this._send({ method, params });
  }

  _send(message) {
    if (['closed', 'closing'].includes(this.state)) throw new RpcError('Client is closed', 'CLOSED');
    let line;
    try { line = JSON.stringify(message); } catch { throw new RpcError('Message is not JSON serializable', 'INVALID_MESSAGE'); }
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new RpcError('Message exceeds size limit', 'INVALID_MESSAGE');
    try {
      this.child.stdin.write(line + '\n', error => {
        if (error) this._transportFailure('Codex write failed');
      });
    } catch { this._transportFailure('Codex write failed'); throw new RpcError('Codex write failed', 'IO_ERROR'); }
  }

  _data(chunk) {
    if (['closing', 'closed'].includes(this.state)) return;
    this.buffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line) > this.maxLineBytes) return this._protocolFailure();
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { return this._protocolFailure(); }
      if (!this._message(message)) return;
    }
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) this._protocolFailure();
  }

  _message(message) {
    if (!object(message) || (own(message, 'jsonrpc') && message.jsonrpc !== '2.0')) return this._protocolFailure();
    if (own(message, 'method')) {
      if (typeof message.method !== 'string' || !message.method || own(message, 'result') || own(message, 'error')) return this._protocolFailure();
      if (own(message, 'id')) {
        if (!validId(message.id)) return this._protocolFailure();
        this._serverRequest(message);
      } else {
        if (message.method === 'serverRequest/resolved') {
          const { requestId, threadId } = message.params ?? {};
          const active = validId(requestId) ? this.incoming.get(requestId) : undefined;
          if (active && typeof threadId === 'string' && threadId === active.threadId) {
            this.incoming.delete(requestId);
            clearTimeout(active.timer);
            active.controller.abort();
          }
        }
        this.emit('notification', message.method, message.params);
      }
      return true;
    }
    if (!validId(message.id) || own(message, 'result') === own(message, 'error')) return this._protocolFailure();
    if (own(message, 'error') && (!object(message.error) || !Number.isInteger(message.error.code))) return this._protocolFailure();
    const pending = this.pending.get(message.id);
    if (pending) pending.done(own(message, 'error')
      ? new RpcError(`Codex rejected request (${message.error.code})`, message.error.code) : null, message.result);
    return true; // Late responses after a timeout are ignored, not turn cancellation.
  }

  _serverRequest({ id, method, params }) {
    if (this.incoming.has(id)) return this._protocolFailure();
    const controller = new AbortController();
    const finish = (result, error) => {
      const current = this.incoming.get(id);
      if (current?.controller !== controller) return;
      this.incoming.delete(id); clearTimeout(current.timer); controller.abort();
      try { this._send(error ? { id, error } : { id, result }); } catch {
        if (this.state === 'ready') {
          try { this._send({ id, error: { code: -32603, message: 'Client response could not be encoded' } }); } catch { /* closed */ }
        }
      }
    };
    const denied = () => finish(null, { code: -32603, message: 'Client request failed closed' });
    const timer = setTimeout(denied, this.serverRequestTimeoutMs);
    this.incoming.set(id, { timer, controller, threadId: params?.threadId });
    if (this.state !== 'ready' || !SERVER_METHODS.has(method) || typeof this.onServerRequest !== 'function') {
      finish(null, { code: -32601, message: 'Client method not supported' }); return;
    }
    Promise.resolve().then(() => this.onServerRequest(method, params, { id, signal: controller.signal }))
      .then(result => {
        // Never turn an absent/boolean return value into an approval response.
        if (!object(result)) return denied();
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
          // Deliberately support only explicit one-request consent or denial; no persistent grants.
          if (!['accept', 'decline', 'cancel'].includes(result.decision)) return denied();
        }
        try { JSON.stringify(result); } catch { return denied(); }
        finish(result);
      }, denied);
  }

  _transportFailure(message) {
    this._fail(new RpcError(message, 'IO_ERROR'));
    void this.close();
  }

  _protocolFailure() {
    this._fail(new RpcError('Invalid app-server protocol frame', 'PROTOCOL_ERROR'));
    void this.close();
    return false;
  }

  _fail(error) {
    if (this.state === 'closed') return;
    this.state = 'closed'; this.buffer = '';
    for (const entry of [...this.pending.values()]) entry.done(error);
    for (const entry of this.incoming.values()) { clearTimeout(entry.timer); entry.controller.abort(); }
    this.incoming.clear();
    this.emit('closed', error);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this._close();
    return this.closePromise;
  }

  async _close() {
    this._fail(new RpcError('Client closed', 'CLOSED'));
    const child = this.child;
    if (!child) return;
    child.stdin?.end();
    const wait = ms => new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      this.exitPromise.then(() => { clearTimeout(timer); resolve(); });
    });
    await wait(this.closeTimeoutMs);
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
      await wait(this.closeTimeoutMs);
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }
  }
}
