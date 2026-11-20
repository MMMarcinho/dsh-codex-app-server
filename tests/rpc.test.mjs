import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexRpcClient } from '../src/rpc.mjs';

function fixture(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  const writes = []; const kills = []; const spawnCalls = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString()); writes.push(message);
      if (message.method === 'initialize' && options.autoInitialize !== false)
        queueMicrotask(() => incoming({ id: message.id, result: { userAgent: 'test' } }));
      callback();
    },
    final(callback) { child.exitCode = 0; child.emit('exit', 0, null); callback(); },
  });
  child.kill = signal => { kills.push(signal); child.signalCode = signal; child.emit('exit', null, signal); return true; };
  const incoming = value => child.stdout.write(JSON.stringify(value) + '\n');
  const client = new CodexRpcClient({ requestTimeoutMs: 100, serverRequestTimeoutMs: 25,
    closeTimeoutMs: 5, ...options,
    spawnImpl: (...args) => { spawnCalls.push(args); return child; },
  });
  return { client, child, writes, kills, spawnCalls, incoming };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('spawns stdio without shell; initializes before notification and requests', async t => {
  const f = fixture(); t.after(() => f.client.close());
  await assert.rejects(f.client.request('thread/start'), { code: 'NOT_READY' });
  const init = await f.client.start();
  assert.equal(init.userAgent, 'test');
  assert.deepEqual(f.spawnCalls[0].slice(0, 2), ['codex', ['app-server', '--listen', 'stdio://']]);
  assert.equal(f.spawnCalls[0][2].shell, false);
  assert.deepEqual(f.writes.map(m => m.method), ['initialize', 'initialized']);
  assert.equal('jsonrpc' in f.writes[0], false);
  assert.deepEqual(await f.client.start(), init);
  assert.equal(f.spawnCalls.length, 1);
  await assert.rejects(f.client.request('initialize'), { code: 'INVALID_REQUEST' });
});

test('correlates interleaved requests and fragmented UTF8 notifications', async t => {
  const f = fixture(); t.after(() => f.client.close()); await f.client.start();
  const a = f.client.request('thread/read', { threadId: 'a' });
  const b = f.client.request('thread/read', { threadId: 'b' });
  const [, , requestA, requestB] = f.writes;
  f.incoming({ id: requestB.id, result: 'b' }); f.incoming({ id: requestA.id, result: 'a' });
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  const next = once(f.client, 'notification');
  const packet = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '你好' } }) + '\n');
  const at = packet.indexOf(Buffer.from('你')) + 1;
  f.child.stdout.write(packet.subarray(0, at)); f.child.stdout.write(packet.subarray(at));
  assert.deepEqual(await next, ['item/agentMessage/delta', { delta: '你好' }]);
  f.client.notify('custom/notification', { ok: true });
  assert.equal('id' in f.writes.at(-1), false);
});

test('request timeout and abort do not interrupt turns or terminate process', async t => {
  const f = fixture(); t.after(() => f.client.close()); await f.client.start();
  const request = f.client.request('turn/start', {}, { timeoutMs: 5 });
  const requestId = f.writes.at(-1).id;
  await assert.rejects(request, { code: 'TIMEOUT' });
  f.incoming({ id: requestId, result: { turn: { id: 'late' } } });
  const controller = new AbortController();
  const abort = f.client.request('thread/read', {}, { signal: controller.signal }); controller.abort();
  await assert.rejects(abort, { code: 'ABORTED' });
  assert.equal(f.client.state, 'ready'); assert.deepEqual(f.kills, []);
  assert.equal(f.writes.some(m => /interrupt|cancel|stop/.test(m.method)), false);
  assert.equal(f.client.pending.size, 0);
});

test('server error has code but does not leak server payload into logs/error', async t => {
  const f = fixture(); t.after(() => f.client.close()); await f.client.start();
  const request = f.client.request('account/read');
  f.incoming({ id: f.writes.at(-1).id, error: { code: -32000, message: 'SECRET', data: { token: 'SECRET' } } });
  await assert.rejects(request, error => error.code === -32000 && !String(error).includes('SECRET'));
  f.child.stderr.write('TOKEN SECRET');
});

test('unsupported or absent server request handler fails closed', async t => {
  const f = fixture(); t.after(() => f.client.close()); await f.client.start();
  f.incoming({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
  f.incoming({ id: 'unknown', method: 'future/requestApproval', params: {} });
  assert.deepEqual(f.writes.slice(-2).map(m => [m.id, m.error.code, own(m, 'result')]),
    [['approval', -32601, false], ['unknown', -32601, false]]);
});
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

test('explicit single-action approval response is supported, not implicit or persistent approval', async t => {
  let response = { decision: 'decline' };
  const f = fixture({ onServerRequest: async () => response }); t.after(() => f.client.close()); await f.client.start();
  for (const [i, value, valid] of [[1, { decision: 'decline' }, true], [2, { decision: 'accept' }, true],
    [3, undefined, false], [4, true, false], [5, { decision: 'acceptForSession' }, false]]) {
    response = value;
    f.incoming({ id: i, method: 'item/fileChange/requestApproval', params: {} }); await tick();
    assert.equal(own(f.writes.at(-1), 'result'), valid);
    if (valid) assert.deepEqual(f.writes.at(-1).result, value);
    else assert.equal(f.writes.at(-1).error.code, -32603);
  }
});

test('hung/throwing server handler fails closed and late result cannot approve', async t => {
  let complete; let signal;
  const f = fixture({ serverRequestTimeoutMs: 5, onServerRequest: (_method, _params, ctx) => {
    signal = ctx.signal; return new Promise(resolve => { complete = resolve; });
  } }); t.after(() => f.client.close()); await f.client.start();
  f.incoming({ id: 'hung', method: 'item/commandExecution/requestApproval', params: {} });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.writes.at(-1).error.code, -32603); assert.equal(signal.aborted, true);
  const count = f.writes.length; complete({ decision: 'accept' }); await tick(); assert.equal(f.writes.length, count);
  f.client.onServerRequest = () => { throw new Error('PRIVATE'); };
  f.incoming({ id: 'throws', method: 'item/tool/call', params: {} }); await tick();
  assert.equal(f.writes.at(-1).error.message.includes('PRIVATE'), false);
});

test('all in-flight requests reject on process exit; close is idempotent', async () => {
  const f = fixture(); await f.client.start();
  const a = f.client.request('thread/read'); const b = f.client.request('turn/start');
  f.child.exitCode = 1; f.child.emit('exit', 1, null);
  await assert.rejects(a, { code: 'PROCESS_EXIT' }); await assert.rejects(b, { code: 'PROCESS_EXIT' });
  await f.client.close(); await f.client.close(); assert.equal(f.client.pending.size, 0);
});

test('malformed JSON or oversized frames close fail-closed without leaking contents', async () => {
  for (const data of ['SECRET invalid\n', 'x'.repeat(513)]) {
    const f = fixture({ maxLineBytes: 512 }); await f.client.start();
    const pending = f.client.request('thread/read'); f.child.stdout.write(data);
    await assert.rejects(pending, error => error.code === 'PROTOCOL_ERROR' && !error.message.includes('SECRET'));
    await f.client.close(); assert.equal(f.client.state, 'closed');
  }
});

test('spawn errors and initialize timeouts reject start and clean up', async () => {
  const bad = new CodexRpcClient({ spawnImpl() { throw new Error('SECRET PATH'); } });
  await assert.rejects(bad.start(), error => error.code === 'PROCESS_ERROR' && !error.message.includes('SECRET'));
  const f = fixture({ autoInitialize: false, requestTimeoutMs: 5 });
  await assert.rejects(f.client.start(), { code: 'TIMEOUT' });
  assert.equal(f.client.state, 'closed'); assert.equal(f.child.stdin.writableEnded, true);
});

test('duplicate active server IDs fail the connection rather than answering twice', async () => {
  const f = fixture({ onServerRequest: () => new Promise(() => {}) }); await f.client.start();
  f.incoming({ id: 1, method: 'item/tool/call', params: {} });
  f.incoming({ id: 1, method: 'item/tool/call', params: {} });
  assert.equal(f.client.state, 'closed'); await f.client.close();
});

test('explicit close escalates only its own unresponsive subprocess', async () => {
  const f = fixture(); await f.client.start();
  // A server that ignores EOF must not keep the owned subprocess alive forever.
  f.child.stdin.end = () => {};
  await f.client.close();
  assert.deepEqual(f.kills, ['SIGTERM']);
});

test('I/O failures reject pending requests and clean up process', async () => {
  const f = fixture(); await f.client.start();
  const pending = f.client.request('thread/read');
  f.child.stdin.emit('error', new Error('SECRET'));
  await assert.rejects(pending, { code: 'IO_ERROR' });
  await f.client.close();
  assert.equal(f.child.stdin.writableEnded, true);
});

test('oversized server handler response becomes an explicit error', async t => {
  const f = fixture({ maxLineBytes: 512, onServerRequest: () => ({ value: 'x'.repeat(1024) }) });
  t.after(() => f.client.close()); await f.client.start();
  f.incoming({ id: 'big', method: 'item/tool/call', params: {} }); await tick();
  assert.equal(f.writes.at(-1).id, 'big');
  assert.equal(f.writes.at(-1).error.code, -32603);
});

test('server-resolved approval withdraws its UI signal without sending a stale reply', async t => {
  const approvals = [];
  const f = fixture({ onServerRequest: (_method, _params, { signal }) =>
    new Promise(resolve => approvals.push({ signal, resolve })) });
  t.after(() => f.client.close()); await f.client.start();
  const incoming = { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 't' } };
  f.incoming(incoming); await tick();
  f.incoming({ method: 'serverRequest/resolved', params: { threadId: 'other', requestId: 'approval' } });
  assert.equal(approvals[0].signal.aborted, false);
  f.incoming({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 'approval' } });
  assert.equal(approvals[0].signal.aborted, true);
  f.incoming(incoming); await tick();
  approvals[0].resolve({ decision: 'accept' }); await tick();
  assert.equal(f.writes.length, 2);
  assert.equal(approvals[1].signal.aborted, false);
  approvals[1].resolve({ decision: 'decline' }); await tick();
  assert.deepEqual(f.writes.at(-1), { id: 'approval', result: { decision: 'decline' } });
});
