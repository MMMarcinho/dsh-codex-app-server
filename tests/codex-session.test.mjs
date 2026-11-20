import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexSession } from '../src/codex-session.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const finish = (client, status = 'completed', items = [], id = 'turn-1', threadId = 'thread-1') =>
  client.emit('notification', 'turn/completed', { threadId, turn: { id, status, items, error: status === 'failed' ? { message: 'provider failed' } : null } });
class Fake extends EventEmitter {
  constructor(options, behavior = {}) { super(); this.options = options; this.behavior = behavior; this.calls = []; this.pending = new Set(); this.closeCount = 0; }
  async start() { if (this.behavior.start) return this.behavior.start(this); }
  request(method, params, options) {
    this.calls.push({ method, params, options });
    return new Promise((resolve, reject) => {
      const rejectClosed = () => reject(new Error('Transport closed'));
      this.pending.add(rejectClosed);
      const done = (fn, value) => { this.pending.delete(rejectClosed); fn(value); };
      Promise.resolve().then(() => {
        if (this.behavior[method]) return this.behavior[method](this, params);
        if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1', status: { type: 'idle' } } };
        if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
        if (method === 'turn/interrupt') { finish(this, 'interrupted'); return {}; }
        throw Error(method);
      }).then(value => done(resolve, value), error => done(reject, error));
    });
  }
  async close() { this.closeCount++; for (const reject of this.pending) reject(); this.pending.clear(); this.emit('closed'); }
}
function setup(behavior = {}, options = {}) {
  let client;
  const saved = [];
  const session = new CodexSession({ cwd: '/workspace', saveThreadId: id => saved.push(id),
    createClient: config => (client = new Fake(config, behavior)), requestTimeoutMs: 100,
    interruptTimeoutMs: 20, ...options });
  return { session, saved, get client() { return client; } };
}
const collect = async generator => { const events = []; for await (const event of generator) events.push(event); return events; };

test('persistent thread, policy, pre-ACK buffering and exact thread/turn routing', async () => {
  const s = setup({ 'turn/start': client => {
    client.emit('notification', 'item/agentMessage/delta', { threadId: 'wrong', turnId: 'turn-1', itemId: 'a', delta: 'wrong' });
    client.emit('notification', 'item/agentMessage/delta', { threadId: 'thread-1', turnId: 'wrong', itemId: 'a', delta: 'wrong' });
    client.emit('notification', 'item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a', delta: 'Hello' });
    finish(client, 'completed', [{ type: 'agentMessage', id: 'a', text: 'Hello world' }]);
    return { turn: { id: 'turn-1', status: 'inProgress' } };
  } });
  assert.deepEqual(await collect(s.session.turn('hi')), [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }, { type: 'completed' }]);
  assert.deepEqual(s.saved, ['thread-1']);
  assert.deepEqual(s.client.calls[0].params, { cwd: '/workspace', approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user', ephemeral: false });
  assert.equal(s.client.calls[1].params.input[0].text, 'hi');
  await s.session.close();
});

test('completed items and final turn payload do not repeat text; raw reasoning never exposed', async () => {
  const s = setup({ 'turn/start': client => {
    const ids = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'r' };
    client.emit('notification', 'item/reasoning/textDelta', { ...ids, delta: 'private' });
    client.emit('notification', 'item/reasoning/summaryTextDelta', { ...ids, delta: 'Public', summaryIndex: 0 });
    client.emit('notification', 'item/completed', { ...ids, item: { id: 'r', type: 'reasoning', summary: ['Public summary'], content: ['private'] } });
    client.emit('notification', 'item/completed', { ...ids, item: { id: 'a', type: 'agentMessage', text: 'Answer' } });
    finish(client, 'completed', [{ id: 'a', type: 'agentMessage', text: 'Answer' }]);
    return { turn: { id: 'turn-1', status: 'inProgress' } };
  } });
  assert.deepEqual(await collect(s.session.turn('hi')), [
    { type: 'reasoning', text: 'Public' }, { type: 'reasoning', text: ' summary' }, { type: 'text', text: 'Answer' }, { type: 'completed' },
  ]);
  await s.session.close();
});

test('resume uses saved identity and never starts replacement on failure', async () => {
  const s = setup({ 'thread/resume': () => { throw Error('missing thread'); } }, { threadId: 'saved-id' });
  await assert.rejects(collect(s.session.turn('hi')), /missing thread/);
  assert.deepEqual(s.client.calls.map(c => c.method), ['thread/resume']);
  assert.equal(s.client.calls[0].params.threadId, 'saved-id');
  assert.equal(s.client.closeCount, 1);
  await assert.rejects(collect(s.session.turn('again')), /closed/);
});

test('resume mismatched identity and existing active thread fail closed', async () => {
  for (const thread of [{ id: 'other' }, { id: 'saved-id', status: { type: 'active' } }]) {
    const s = setup({ 'thread/resume': () => ({ thread }) }, { threadId: 'saved-id' });
    await assert.rejects(collect(s.session.turn('hi')), /mismatched|active/);
    assert.equal(s.client.calls.length, 1);
    assert.equal(s.client.closeCount, 1);
  }
});

test('one active turn; known cancellation waits for matching completion', async () => {
  const s = setup();
  const controller = new AbortController();
  const pending = collect(s.session.turn('hi', { signal: controller.signal }));
  await tick();
  await assert.rejects(collect(s.session.turn('overlap')), /already active/);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const interrupt = s.client.calls.find(c => c.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: 'thread-1', turnId: 'turn-1' });
  assert.equal(s.client.closeCount, 0);
  await s.session.close();
});

test('interrupt ACK without completion disposes process within deadline', async () => {
  const s = setup({ 'turn/interrupt': () => ({}) });
  const controller = new AbortController();
  const pending = collect(s.session.turn('hi', { signal: controller.signal }));
  await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(s.client.closeCount, 1);
  await assert.rejects(collect(s.session.turn('again')), /closed/);
});

test('abort before turn ACK closes process rather than guessing turn ID or retrying', async () => {
  const s = setup({ 'turn/start': () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = collect(s.session.turn('hi', { signal: controller.signal }));
  await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(s.client.closeCount, 1);
  assert.equal(s.client.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(s.client.calls.some(c => c.method === 'turn/interrupt'), false);
});

test('consumer stops streaming early: interrupt before accepting another turn', async () => {
  const s = setup();
  const stream = s.session.turn('hi'); const pending = stream.next(); await tick();
  s.client.emit('notification', 'item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a', delta: 'partial' });
  assert.equal((await pending).value.text, 'partial');
  await stream.return();
  assert.equal(s.client.calls.at(-1).method, 'turn/interrupt');
  await s.session.close();
});

test('terminal provider failure remains explicit after partial text', async () => {
  const s = setup(); const stream = s.session.turn('hi'); const pending = stream.next(); await tick();
  s.client.emit('notification', 'item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a', delta: 'partial' });
  assert.equal((await pending).value.text, 'partial');
  finish(s.client, 'failed');
  await assert.rejects(stream.next(), /provider failure/);
  await s.session.close();
});

test('transport death never produces completed and disallows automatic reconnect', async () => {
  const s = setup(); const pending = collect(s.session.turn('hi')); await tick();
  s.client.emit('closed', new Error('wire lost'));
  await assert.rejects(pending, /wire lost/);
  await assert.rejects(collect(s.session.turn('again')), /closed/);
});

test('server requests use current turn signal and deny unsupported handlers', async () => {
  let signal;
  const s = setup({}, { onServerRequest: async (method, params, activeSignal) => { signal = activeSignal; return { decision: 'decline' }; } });
  const controller = new AbortController();
  const pending = collect(s.session.turn('hi', { signal: controller.signal })); await tick();
  const result = await s.client.options.onServerRequest('approval', {}, { signal: new AbortController().signal });
  assert.equal(result.decision, 'decline'); assert.equal(signal.aborted, false);
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(signal.aborted, true);
  await s.session.close();
});

test('two successful turns share one started thread and persist once', async () => {
  let n = 0;
  const s = setup({ 'turn/start': () => ({ turn: { id: `t-${++n}`, status: 'completed', items: [{ id: `a-${n}`, type: 'agentMessage', text: `${n}` }] } }) });
  assert.equal((await collect(s.session.turn('one')))[0].text, '1');
  assert.equal((await collect(s.session.turn('two')))[0].text, '2');
  assert.equal(s.client.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.deepEqual(s.saved, ['thread-1']); await s.session.close();
});

test('file approvals wait for ACK and match exact item; only path metadata retained', async () => {
  let approval, received;
  const ids = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'f' };
  const s = setup({ 'turn/start': client => {
    client.emit('notification', 'item/started', { ...ids, item: { id: 'f', type: 'fileChange', changes: [{ path: '/workspace/a', kind: { type: 'update', move_path: null }, diff: 'secret patch' }] } });
    approval = client.options.onServerRequest('item/fileChange/requestApproval', ids, {});
    return { turn: { id: 'turn-1', status: 'inProgress' } };
  } }, { onServerRequest: async (method, params, signal, context) => { received = context; return { decision: 'decline' }; } });
  const pending = collect(s.session.turn('hi')); await tick(); await approval;
  assert.deepEqual(received.fileChange, { ...ids, item: { id: 'f', type: 'fileChange', changes: [{ path: '/workspace/a', kind: { type: 'update', move_path: null } }] } });
  assert.equal(s.session.active.fileChanges.size, 0);
  await assert.rejects(s.client.options.onServerRequest('item/fileChange/requestApproval', { ...ids, turnId: 'wrong' }, {}), /Mismatched approval turn/);
  await assert.rejects(s.client.options.onServerRequest('item/fileChange/requestApproval', { ...ids, threadId: 'wrong' }, {}), /Mismatched approval thread/);
  await s.client.options.onServerRequest('item/fileChange/requestApproval', { ...ids, itemId: 'absent' }, {});
  assert.equal(received.fileChange, undefined);
  finish(s.client); await pending; await s.session.close();
});

test('approval signal follows per-request cancellation without aborting turn', async () => {
  let signal;
  const s = setup({}, { onServerRequest: async (m, p, activeSignal) => { signal = activeSignal; return {}; } });
  const pending = collect(s.session.turn('hi')); await tick();
  const request = new AbortController();
  await s.client.options.onServerRequest('approval', {}, { signal: request.signal });
  request.abort(); assert.equal(signal.aborted, true); assert.equal(s.session.active.controller.signal.aborted, false);
  finish(s.client); await pending; await s.session.close();
});

test('progress is generic, deduplicated and never exposes command output, arguments or patch', async () => {
  const items = [{ id: 'c', type: 'commandExecution', status: 'completed', command: 'secret command', aggregatedOutput: 'secret output' },
    { id: 'f', type: 'fileChange', status: 'failed', changes: [{ path: 'secret path', diff: 'secret patch' }] },
    { id: 'm', type: 'mcpToolCall', status: 'completed', arguments: 'secret args', result: 'secret result' }];
  const s = setup({ 'turn/start': client => {
    for (const item of items) client.emit('notification', 'item/completed', { threadId: 'thread-1', turnId: 'turn-1', item });
    finish(client, 'completed', items); return { turn: { id: 'turn-1', status: 'inProgress' } };
  } });
  assert.deepEqual(await collect(s.session.turn('hi')), [{ type: 'progress', text: 'Command completed' }, { type: 'progress', text: 'File change failed (1 files)' }, { type: 'progress', text: 'MCP tool completed' }, { type: 'completed' }]);
  await s.session.close();
});

test('server errors and failed turn payload never echo untrusted diagnostic secrets', async () => {
  for (const notification of ['error', 'turn/completed']) {
    const s = setup(); const pending = collect(s.session.turn('hi')); await tick();
    s.client.emit('notification', notification, { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error: { message: 'SECRET' }, turn: { id: 'turn-1', status: 'failed', error: { message: 'SECRET' } } });
    await assert.rejects(pending, error => /Codex turn failed/.test(error.message) && !error.message.includes('SECRET'));
    await s.session.close();
  }
});
