import assert from 'node:assert/strict';
import test from 'node:test';
import { handleServerRequest } from '../src/interaction.mjs';

const commandApproval = 'item/commandExecution/requestApproval';
const fileApproval = 'item/fileChange/requestApproval';
const permissionsApproval = 'item/permissions/requestApproval';
const userInput = 'item/tool/requestUserInput';
const agent = { id: 'dsh-session' };
const ids = { threadId: 'codex-thread', turnId: 'codex-turn', itemId: 'item-1' };
const command = {
  ...ids, kind: 'command', command: 'npm test && npm run lint', cwd: '/workspace/current project',
  reason: 'untrusted reason', proposedExecpolicyAmendment: { command: ['npm'] },
};
const patch = {
  threadId: ids.threadId, turnId: ids.turnId, item: {
    id: ids.itemId, type: 'fileChange', changes: [
      { path: '/work/source.ts', kind: { type: 'update', move_path: '/work/renamed.ts' }, diff: '+private content' },
      { path: '/work/old.ts', kind: { type: 'delete' }, diff: '-removed' },
    ],
  },
};
const questions = [
  {
    id: 'mode', question: 'Choose a test suite.', header: 'Test suite',
    isOther: false, isSecret: false,
    options: [
      { label: 'Quick', description: 'Runs basic checks' },
      { label: 'Full', description: 'Runs all checks' },
    ],
  },
  {
    id: 'summary', question: 'What is the desired behavior?', header: '', isOther: true, isSecret: false, options: null,
  },
];
const askParams = { ...ids, questions, isBlocking: true, autoResolutionMs: null };

test('maps an exact command approval onto DSH with a single-request result and no sensitive audit details', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const ctx = { approval: { async request(req) { calls.push(req); return 'allowed-once'; } } };
  assert.deepEqual(await handleServerRequest(ctx, agent, commandApproval, command, signal, { callId: 'dsh-call' }),
    { decision: 'accept' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, agent);
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[0].callId, 'dsh-call');
  assert.equal(calls[0].toolName, 'codex_command');
  assert.equal(calls[0].reason, 'Codex command execution');
  assert.match(calls[0].displayReason.en, /once\? Command: "npm test && npm run lint"/);
  assert.match(calls[0].displayReason.en, /Working directory: "\/workspace\/current project"/);
  assert.doesNotMatch(JSON.stringify(calls[0]), /untrusted reason|Amendment/);
});

test('all non-one-shot outcomes decline or cancel and host exception details never travel to Codex', async () => {
  for (const [outcome, decision] of [
    ['rejected', 'decline'], ['unavailable', 'decline'], ['cancelled', 'cancel'],
    ['allowed-for-session', 'decline'], ['acceptForSession', 'decline'], [true, 'decline'], [undefined, 'decline'],
  ]) {
    const ctx = { approval: { request: async () => outcome } };
    assert.deepEqual(await handleServerRequest(ctx, agent, commandApproval, command), { decision });
  }
  const ctx = { approval: { request: async () => { throw new Error('private host detail'); } } };
  assert.deepEqual(await handleServerRequest(ctx, agent, commandApproval, command), { decision: 'decline' });
  assert.deepEqual(await handleServerRequest({}, agent, commandApproval, command), { decision: 'decline' });
});

test('never dispatches an unreviewable command or suggests a persistent grant', async () => {
  let calls = 0;
  const ctx = { approval: { request: async () => { calls += 1; return 'allowed-once'; } } };
  for (const extra of [
    { command: null }, { cwd: null }, { kind: 'writeStdin' }, { kind: 'humanCommand' },
    { networkApprovalContext: { host: 'public.example', protocol: 'https' } },
    { proposedNetworkPolicyAmendments: [{ host: 'public.example', action: 'allow' }] },
    { command: 'some-cli --password ExampleValue' },
    { command: 'echo example\u202e then pwd' },
    { command: 'r'.repeat(513) },
  ]) {
    assert.deepEqual(await handleServerRequest(ctx, agent, commandApproval, { ...command, ...extra }), { decision: 'decline' });
  }
  assert.equal(calls, 0);
  assert.deepEqual(await handleServerRequest(ctx, agent, commandApproval, {
    ...command, proposedNetworkPolicyAmendments: [],
  }), { decision: 'accept' });
  assert.equal(calls, 1);
});

test('withdrawn approval cannot be granted by a late host answer', async () => {
  const controller = new AbortController();
  let calls = 0;
  const ctx = { approval: { async request(req) {
    calls += 1;
    assert.equal(req.signal, controller.signal);
    controller.abort(new Error('private cause'));
    return 'allowed-once';
  } } };
  assert.deepEqual(await handleServerRequest(ctx, agent, commandApproval, command, controller.signal), { decision: 'cancel' });
  assert.deepEqual(await handleServerRequest(ctx, agent, commandApproval, command, controller.signal), { decision: 'cancel' });
  assert.equal(calls, 1);
});

test('presents file changes only when scoped to the matching item; does not copy raw diffs or reason', async () => {
  const calls = [];
  const ctx = { approval: { async request(req) { calls.push(req); return 'allowed-once'; } } };
  const params = { ...ids, reason: 'untrusted reason', grantRoot: null };
  assert.deepEqual(await handleServerRequest(ctx, agent, fileApproval, params, undefined, { fileChange: patch }),
    { decision: 'accept' });
  assert.equal(calls[0].toolName, 'codex_file_change');
  assert.equal(calls[0].reason, 'Codex file change');
  assert.match(calls[0].displayReason.en, /move "\/work\/source.ts" to "\/work\/renamed.ts"/);
  assert.match(calls[0].displayReason.en, /delete "\/work\/old.ts"/);
  assert.doesNotMatch(JSON.stringify(calls[0]), /private content|untrusted reason/);
  for (const [p, fileChange] of [
    [params, undefined], [params, { ...patch, turnId: 'different-turn' }],
    [params, { ...patch, threadId: 'different-thread' }], [params, { ...patch, item: { ...patch.item, id: 'different-item' } }],
    [{ ...params, grantRoot: '/work' }, patch],
    [params, { ...patch, item: { ...patch.item, changes: [] } }],
    [params, { ...patch, item: { ...patch.item, changes: [{ path: '/work/a', kind: { type: 'unexpected' } }] } }],
  ]) {
    assert.deepEqual(await handleServerRequest(ctx, agent, fileApproval, p, undefined, { fileChange }), { decision: 'decline' });
  }
  assert.equal(calls.length, 1);
});

test('responds to permission-profile requests without granting a path, network, or session access', async () => {
  const ctx = { approval: { request() { assert.fail('a broad permission must not be offered'); } } };
  assert.deepEqual(await handleServerRequest(ctx, agent, permissionsApproval, {
    ...ids, permissions: { network: { enabled: true }, fileSystem: { write: ['/'] } },
  }), { permissions: {}, scope: 'turn' });
});

test('questions use the exact DSH request and encode choices, custom text and skips in Codex form', async () => {
  const signal = new AbortController().signal;
  const ctx = { userQuestions: { async ask(request) {
    assert.equal(request.agent, agent);
    assert.equal(request.signal, signal);
    assert.equal(request.wait, undefined);
    assert.deepEqual(request.questions, [
      { id: 'mode', question: 'Choose a test suite.', header: 'Test suite', options: questions[0].options,
        detail: 'Your answer goes to Codex. Do not enter passwords, tokens, or other secrets.', multiSelect: false },
      { id: 'summary', question: 'What is the desired behavior?',
        detail: 'Your answer goes to Codex. Do not enter passwords, tokens, or other secrets.', multiSelect: false },
    ]);
    return { answers: [{ id: 'summary', selected: [], custom: 'Keep the existing layout' }, { id: 'mode', selected: ['Quick'] }] };
  } } };
  assert.deepEqual(await handleServerRequest(ctx, agent, userInput, askParams, signal), { answers: {
    mode: { answers: ['Quick'] }, summary: { answers: ['Keep the existing layout'] },
  } });
  ctx.userQuestions.ask = async () => ({ answers: [{ id: 'mode', selected: [] }, { id: 'summary', selected: [] }] });
  assert.deepEqual(await handleServerRequest(ctx, agent, userInput, askParams), { answers: {
    mode: { answers: [] }, summary: { answers: [] },
  } });
});

test('does not present secret, credential, malformed, prototype or non-blocking questions', async () => {
  const ctx = { userQuestions: { ask() { assert.fail('unsafe input must not be shown'); } } };
  for (const q of [
    { ...questions[0], isSecret: true }, { ...questions[0], isSecret: 'false' },
    { ...questions[0], question: 'Enter your API key' }, { ...questions[0], question: '请输入密码' },
    { ...questions[0], options: [{ label: 'sign in', description: 'Enter your password' }] },
    { ...questions[0], id: '__proto__' }, { ...questions[0], options: [{ label: 'x' }, { label: 'x' }] },
  ]) {
    await assert.rejects(handleServerRequest(ctx, agent, userInput, { ...askParams, questions: [q] }),
      /unsupported|Invalid Codex interaction request/);
  }
  await assert.rejects(handleServerRequest(ctx, agent, userInput, { ...askParams, questions: [questions[0], questions[0]] }),
    /Invalid Codex interaction request/);
  await assert.rejects(handleServerRequest(ctx, agent, userInput, { ...askParams, isBlocking: false }), /Non-blocking/);
});

test('rejects unexpected answers without returning raw text from an answerer', async () => {
  for (const response of [
    { answers: [{ id: 'mode', selected: ['Not Offered'] }] },
    { answers: [{ id: 'mode', selected: ['Quick', 'Full'] }] },
    { answers: [{ id: 'mode', selected: [], custom: 'not an available choice' }] },
    { answers: [{ id: 'unknown', selected: ['Quick'] }] },
  ]) {
    const ctx = { userQuestions: { ask: async () => response } };
    await assert.rejects(handleServerRequest(ctx, agent, userInput, { ...askParams, questions: [questions[0]] }),
      /Codex user input is unavailable/);
  }
  const secret = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const ctx = { userQuestions: { ask: async () => ({ answers: [{ id: 'summary', selected: [], custom: secret }] }) } };
  await assert.rejects(handleServerRequest(ctx, agent, userInput, { ...askParams, questions: [questions[1]] }),
    error => error.message === 'Codex user input is unavailable' && !String(error).includes(secret));
});

test('missing or failed answerers and aborted questions fail closed', async () => {
  const failing = { userQuestions: { ask: async () => { throw new Error('private host detail'); } } };
  for (const ctx of [{}, failing]) {
    await assert.rejects(handleServerRequest(ctx, agent, userInput, askParams),
      error => error.message === 'Codex user input is unavailable');
  }
  const controller = new AbortController();
  const waiting = { userQuestions: { ask() { return new Promise(() => {}); } } };
  const pending = handleServerRequest(waiting, agent, userInput, askParams, controller.signal);
  await Promise.resolve();
  controller.abort(new Error('private cause'));
  await assert.rejects(pending, { name: 'AbortError', message: 'Codex interaction cancelled' });
});

test('rejects unsupported methods and bad routing without copying untrusted parameters', async () => {
  for (const method of ['execCommandApproval', 'applyPatchApproval', 'item/tool/call', 'mcpServer/elicitation/request',
    'account/chatgptAuthTokens/refresh', 'unknown-mask']) {
    await assert.rejects(handleServerRequest({}, agent, method, { text: 'private' }), {
      message: 'Unsupported Codex interaction request',
    });
  }
  await assert.rejects(handleServerRequest({}, agent, commandApproval, { ...command, turnId: ' ' }), {
    message: 'Invalid Codex interaction request',
  });
});
