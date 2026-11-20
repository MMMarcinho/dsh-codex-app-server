// Opt-in official DSH host smoke. Run with DSH_CLI=/path/to/dsh node tests/host-smoke.mjs.
// All auth, sessions, config and fake Codex state are isolated in a temporary directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const cli = process.env.DSH_CLI || 'dsh';
const root = await mkdtemp(join(tmpdir(), 'dsh-codex-smoke-'));
const cwd = join(root, 'work');
const home = join(root, 'home');
const bin = join(root, 'bin');
const project = fileURLToPath(new URL('../', import.meta.url));
const answer = 'Synthetic Codex response for official DSH smoke.';
const prompt = 'Synthetic prompt sent through the native DSH composer API.';
const trace = join(root, 'fake-codex-methods.log');
let host;
const retained = new Set(['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
  'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_HTTP_PROXY', 'NPM_CONFIG_PROXY']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => retained.has(key)));
Object.assign(env, { PATH: bin + ':' + (env.PATH || '/usr/bin:/bin'), HOME: home,
  DSH_HOME: join(root, 'dsh'), XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
  CODEX_HOME: join(root, 'codex'), npm_config_cache: process.env.DSH_SMOKE_NPM_CACHE || join(root, 'npm'),
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function collect(command, args, { directory = cwd, limitMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { env, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], timeout: limitMs });
    let out = '';
    p.stdout.on('data', chunk => { if (out.length < 400_000) out += chunk; });
    p.stderr.resume();
    p.once('error', reject);
    p.once('close', code => code === 0 ? resolve(out) : reject(new Error('Setup command failed: ' + args[0] + ' (' + code + ')')));
  });
}

try {
  await Promise.all([cwd, home, bin].map(directory => mkdir(directory)));
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const readline = require('node:readline');
const assert = require('node:assert/strict');
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (process.argv[2] !== 'app-server') process.exit(2);
const threadId = 'a75c629c-cdef-4114-877a-491593c939c1';
const trace = ${JSON.stringify(trace)};
const observed = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\\n') : [];
const record = method => appendFileSync(trace, method + '\\n');
let initialized = false;
const approvalId = 'fixture-approval';
const approvalTurn = 'fixture-turn-4';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  const send = result => emit({ id: row.id, result });
  if (row.method === 'initialize') send({ userAgent: 'isolated fixture' });
  else if (row.method === 'initialized') initialized = true;
  else if (row.method === 'thread/start' || row.method === 'thread/resume') {
    assert.equal(initialized, true);
    assert.equal(row.params.cwd, process.cwd());
    assert.equal(row.params.approvalPolicy, 'on-request');
    assert.equal(row.params.sandbox, 'workspace-write');
    if (row.method === 'thread/start') assert.deepEqual(observed(), []);
    else assert.equal(row.params.threadId, threadId);
    record(row.method);
    send({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' },
      thread: { id: threadId, status: { type: 'idle' } } });
  }
  else if (row.method === 'turn/start') {
    assert.equal(row.params.threadId, threadId);
    const count = observed().filter(method => method === 'turn/start').length + 1;
    assert.ok(count <= 4, 'Auxiliary requests must not advance the Codex thread');
    assert.deepEqual(row.params.input, [{ type: 'text', text: ${JSON.stringify(prompt)} + ' #' + count, text_elements: [] }]);
    record(row.method);
    const id = 'fixture-turn-' + count;
    const item = { type: 'agentMessage', id: 'fixture-message-' + count, text: ${JSON.stringify(answer)} + ' #' + count };
    send({ turn: { id, status: 'inProgress', items: [] } });
    if (id === approvalTurn) {
      setTimeout(() => {
        emit({ id: approvalId, method: 'item/commandExecution/requestApproval',
          params: { threadId, turnId: id, itemId: 'fixture-command', command: 'printf smoke', cwd: process.cwd() } });
      }, 30);
      return;
    }
    setTimeout(() => {
      emit({ method: 'item/agentMessage/delta', params: { threadId, turnId: id, itemId: item.id, delta: item.text } });
      emit({ method: 'item/completed', params: { threadId, turnId: id, item } });
      emit({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed', items: [item] } } });
    }, 400);
  } else if (row.method === 'turn/interrupt') {
    assert.deepEqual(row.params, { threadId, turnId: approvalTurn });
    record('turn/interrupt');
    send({});
    emit({ method: 'serverRequest/resolved', params: { threadId, requestId: approvalId } });
    emit({ method: 'turn/completed', params: { threadId,
      turn: { id: approvalTurn, status: 'interrupted', items: [] } } });
  } else if (row.id === approvalId) {
    assert.ok(row.error || ['decline', 'cancel'].includes(row.result?.decision), 'Fixture command must never be auto-approved');
    record('approval/refused');
  } else if (row.id !== undefined) emit({ id: row.id, error: { code: -32601, message: 'not implemented by fixture' } });
});
`, { mode: 0o700 });
  const pack = await collect('npm', ['pack', '--quiet', '--pack-destination', root], { directory: project });
  const file = pack.trim().split(/\r?\n/).at(-1);
  assert.match(file, /^dsh-codex-app-server-.+\.tgz$/);
  await collect(cli, ['plugin', '--profile', 'web', 'add', join(root, file), '--store-dir', join(root, 'store')]);
  async function launch() {
    host = spawn(cli, ['web', '--host', '127.0.0.1', '--port', process.env.DSH_SMOKE_PORT || '0', '--no-open'], {
      env, cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = new URL(await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('DSH host did not advertise a launch URL')), 90_000);
      const receive = chunk => {
        if (out.length > 50_000) out = out.slice(-5000);
        out += chunk;
        const match = out.match(/https?:\/\/127\.0\.0\.1:\d+\/\S*[?&]token=[^\s\x1b]+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      };
      host.stdout.on('data', receive); host.stderr.on('data', receive);
      host.once('error', () => { clearTimeout(timer); reject(new Error('DSH host failed to spawn')); });
      host.once('close', code => { clearTimeout(timer); reject(new Error('DSH host exited before startup (' + code + ')')); });
    }));
    // Exchange the isolated host's launch token into its native browser cookie.
    const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const cookie = login.headers.getSetCookie().map(line => line.split(';')[0]).join('; ');
    assert.ok(cookie, 'DSH browser login yielded no cookie');
    return async function rpc(method, args = {}) {
      const result = await fetch(new URL('/api/' + method, url.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: url.origin },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(result.status, 200, method + ' HTTP status');
      const { result: row } = await result.json();
      assert.ok(row?.ok, method + ' failed: ' + (row?.error?.code || 'unknown'));
      return row.value;
    };
  }
  let rpc = await launch();
  const presets = await rpc('agentPresets/list');
  assert.ok(presets.presets.some(preset => preset.id === 'codex'), 'Codex preset missing');
  const session = await rpc('session/create', { request: { cwd, agentPreset: 'codex' } });
  assert.equal(session.agentPreset, 'codex');
  const { sessionId } = session;
  async function turn(n) {
    const expectedPrompt = prompt + ' #' + n;
    const expectedAnswer = answer + ' #' + n;
    const receipt = await rpc('session/prompt', { request: {
      sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: expectedPrompt }],
    } });
    assert.equal(receipt.accepted, true);
    let running = false, history, state;
    for (let n = 0; n < 50; n++) {
      state = await rpc('session/state', { request: { sessionId } });
      running ||= state.running;
      history = await rpc('session/page', { request: { address: { kind: 'session', sessionId } } });
      if (!state.running && JSON.stringify(history.records).includes(expectedAnswer)) break;
      await pause(100);
    }
    assert.ok(running, 'Native running status not observed');
    assert.equal(state.running, false);
    const records = JSON.stringify(history.records);
    assert.ok(records.includes(expectedPrompt), 'Native history is missing user prompt');
    const events = history.records.map(record => record.event);
    assert.ok(events.some(event => event.type === 'model/selection'
      && event.data.provider === 'codex-app-server'), 'Native model selection did not use Codex');
    if (!records.includes(expectedAnswer)) {
      const exits = events.filter(event => event.type === 'turn/end').map(event => event.data.reason);
      console.error('Fixture turn exit:', JSON.stringify(exits));
    }
    assert.ok(records.includes(expectedAnswer), 'Native history is missing the assistant response');
    assert.ok(events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'),
      'Native history is missing a successful turn exit');
    assert.equal(events.filter(event => event.type === 'plugin:dsh-codex-app-server/thread').length, 1,
      'Exactly one durable Codex thread binding is expected');
  }
  await turn(1);
  await turn(2);
  await stop();
  rpc = await launch();
  await turn(3);
  const methods = async () => (await readFile(trace, 'utf8')).trim().split('\n');
  assert.deepEqual(await methods(), ['thread/start', 'turn/start', 'turn/start', 'thread/resume', 'turn/start']);
  assert.equal((await rpc('session/prompt', { request: {
    sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: prompt + ' #4' }],
  } })).accepted, true);
  for (let n = 0; n < 50 && !(await methods()).includes('approval/refused'); n++) await pause(100);
  assert.ok((await methods()).includes('approval/refused'), 'Unanswered command approval did not fail closed');
  await rpc('session/cancel', { request: { sessionId } });
  for (let n = 0; n < 50; n++) {
    const state = await rpc('session/state', { request: { sessionId } });
    if (!state.running && !state.pendingInput.length) break;
    await pause(100);
  }
  assert.ok((await methods()).includes('turn/interrupt'), 'Native Stop did not interrupt the Codex turn');
  const stopped = await rpc('session/state', { request: { sessionId } });
  assert.equal(stopped.running, false);
  assert.deepEqual(stopped.pendingInput, []);
  console.log('Official DSH smoke passed: tarball, preset, prompts, status/history, restart/resume, unattended approval denial and Stop.');
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}

async function stop() {
  if (!host || host.exitCode != null || host.signalCode != null) return;
  const closed = once(host, 'close').catch(() => {});
  host.kill('SIGTERM');
  await Promise.race([closed, pause(2000)]);
  if (host.exitCode == null && host.signalCode == null) {
    host.kill('SIGKILL');
    await Promise.race([closed, pause(2000)]);
  }
}
