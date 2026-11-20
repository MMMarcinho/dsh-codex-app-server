// Codex v2 server requests are untrusted until scoped to the active turn by
// the caller. This adapter only maps them to the host's existing interaction
// seams. Neither a missing provider nor an unrecognized answer is consent.
const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
const FILE_APPROVAL = 'item/fileChange/requestApproval';
const PERMISSIONS_APPROVAL = 'item/permissions/requestApproval';
const USER_INPUT = 'item/tool/requestUserInput';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const forbiddenText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;
const secretMaterial = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[\w-]{12,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,}|xox[baprs]-[\w-]{10,}|AKIA[A-Z0-9]{16})\b|\b(?:authorization\s*[:=]\s*(?:bearer|basic)|bearer)\s+[\w.+/=-]{8,}|(?:--(?:password|passwd|api[-_]?key|token|secret)(?:=|\s+)|\b[\w-]*(?:PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)\s*=)\s*["']?[^\s$<"'])/iu;
const secretQuestion = /\b(?:password|passphrase|api[-_ ]?key|client secret|private key|access token|refresh token|recovery (?:seed|code)|one[- ]time (?:password|code)|verification code|authentication code|security code|session cookie|secret token|pin)\b|密码|密钥|验证码|恢复码/u;
const noSecretNotice = 'Your answer goes to Codex. Do not enter passwords, tokens, or other secrets.';

const invalid = () => new Error('Invalid Codex interaction request');
const deniedInput = () => new Error('Codex user input is unavailable');
const notAborted = signal => {
  if (signal?.aborted) throw Object.assign(new Error('Codex interaction cancelled'), { name: 'AbortError' });
};
function text(value, max) {
  return typeof value === 'string' && value.length <= max && value.trim().length > 0
    && !forbiddenText.test(value) && !secretMaterial.test(value);
}
function literal(value, max) {
  return text(value, max) ? JSON.stringify(value) : null;
}
function identity(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value);
}
function route(params) {
  if (!record(params) || ![params.threadId, params.turnId, params.itemId].every(identity)) throw invalid();
}

async function approve(ctx, agent, toolName, display, signal, callId) {
  if (signal?.aborted) return { decision: 'cancel' };
  if (!agent || typeof ctx?.approval?.request !== 'function') return { decision: 'decline' };
  let outcome;
  try {
    outcome = await ctx.approval.request({
      agent,
      toolName,
      // This fixed audit reason is durable. Specific command/path details
      // are only delivered to the live answerer, not to the approval log.
      reason: toolName === 'codex_command' ? 'Codex command execution' : 'Codex file change',
      displayReason: { en: display },
      ...(callId === undefined ? {} : { callId }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    if (signal?.aborted) return { decision: 'cancel' };
    // Do not expose host exceptions or their data on the Codex RPC wire.
    return { decision: 'decline' };
  }
  if (signal?.aborted || outcome === 'cancelled') return { decision: 'cancel' };
  return { decision: outcome === 'allowed-once' ? 'accept' : 'decline' };
}

function commandDescription(params) {
  // Neither a network request nor sending input to an existing process is
  // equivalent to approving a concrete command invocation.
  if ((params.kind != null && params.kind !== 'command')
    || params.networkApprovalContext != null) return null;
  const networkAmendments = params.proposedNetworkPolicyAmendments;
  if (networkAmendments != null && (!Array.isArray(networkAmendments) || networkAmendments.length !== 0)) return null;
  const command = literal(params.command, 512);
  const cwd = literal(params.cwd, 256);
  if (command === null || cwd === null) return null;
  const environment = params.environmentId == null ? '' : literal(params.environmentId, 128);
  if (environment === null) return null;
  return `Allow Codex to run this command once? Command: ${command}. Working directory: ${cwd}.`
    + (environment ? ` Environment: ${environment}.` : '');
}

function fileDescription(params, notification) {
  // The RPC request itself includes no patch paths. Use only matching
  // item/started data already seen in the owning thread and turn.
  if (params.grantRoot != null || !record(notification) || notification.threadId !== params.threadId
    || notification.turnId !== params.turnId) return null;
  const item = notification.item;
  if (!record(item) || item.type !== 'fileChange' || item.id !== params.itemId
    || !Array.isArray(item.changes) || item.changes.length === 0 || item.changes.length > 12) return null;
  const paths = [];
  for (const change of item.changes) {
    if (!record(change) || !record(change.kind)) return null;
    const path = literal(change.path, 320);
    if (path === null) return null;
    const { type, move_path } = change.kind;
    if (!['add', 'delete', 'update'].includes(type)) return null;
    if (move_path != null) {
      const destination = literal(move_path, 320);
      if (type !== 'update' || destination === null) return null;
      paths.push(`move ${path} to ${destination}`);
    } else {
      paths.push(`${type} ${path}`);
    }
  }
  const description = `Allow this Codex file change once? ${paths.join('; ')}.`;
  return description.length <= 3500 ? description : null;
}

function readQuestions(params) {
  if (params.isBlocking === false || (params.isBlocking != null && params.isBlocking !== true)) {
    throw new Error('Non-blocking Codex user input is unsupported');
  }
  if (!Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > 10) throw invalid();
  const questions = [];
  const offered = new Map();
  for (const q of params.questions) {
    if (!record(q)) throw invalid();
    // rc.5 has no masked question field or secret answer transport.
    if (q.isSecret === true) throw new Error('Secret Codex user input is unsupported');
    if (q.isSecret != null && q.isSecret !== false) throw invalid();
    if (q.isOther != null && typeof q.isOther !== 'boolean') throw invalid();
    if (!identity(q.id) || offered.has(q.id) || !text(q.question, 2000)
      || (q.header != null && q.header !== '' && !text(q.header, 160))) throw invalid();
    if (secretQuestion.test(q.question.toLowerCase()) || secretQuestion.test(q.header?.toLowerCase() ?? '')) {
      throw new Error('Credential questions are unsupported');
    }
    if (q.options != null && (!Array.isArray(q.options) || q.options.length > 12)) throw invalid();
    const labels = new Set();
    const options = (q.options ?? []).map(option => {
      if (!record(option) || !text(option.label, 160) || labels.has(option.label)
        || (option.description != null && option.description !== '' && !text(option.description, 500))) throw invalid();
      if (secretQuestion.test(option.label.toLowerCase())
        || secretQuestion.test(option.description?.toLowerCase() ?? '')) {
        throw new Error('Credential questions are unsupported');
      }
      labels.add(option.label);
      return { label: option.label, ...(option.description ? { description: option.description } : {}) };
    });
    offered.set(q.id, { labels, allowCustom: q.isOther === true || options.length === 0 });
    questions.push({
      id: q.id, question: q.question, ...(q.header ? { header: q.header } : {}),
      detail: noSecretNotice, ...(options.length ? { options } : {}), multiSelect: false,
    });
  }
  return { questions, offered };
}

async function ask(ctx, request) {
  const { signal } = request;
  if (signal === undefined) return ctx.userQuestions.ask(request);
  let onAbort;
  try {
    notAborted(signal);
    const abort = new Promise((_, reject) => {
      onAbort = () => {
        try { notAborted(signal); } catch (error) { reject(error); }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([abort, Promise.resolve().then(() => {
      notAborted(signal);
      return ctx.userQuestions.ask(request);
    })]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function encodeAnswers(result, offered) {
  if (!record(result) || !Array.isArray(result.answers) || result.answers.length !== offered.size) throw deniedInput();
  const encoded = new Map();
  for (const answer of result.answers) {
    if (!record(answer) || encoded.has(answer.id)) throw deniedInput();
    const spec = offered.get(answer.id);
    if (!spec || !Array.isArray(answer.selected) || answer.selected.length > 1
      || !answer.selected.every(value => spec.labels.has(value))) throw deniedInput();
    if (answer.custom !== undefined && (answer.selected.length !== 0 || !spec.allowCustom || !text(answer.custom, 8000))) {
      throw deniedInput();
    }
    encoded.set(answer.id, { answers: answer.custom === undefined ? [...answer.selected] : [answer.custom] });
  }
  return { answers: Object.fromEntries(encoded) };
}

/** Map one active Codex server request onto DSH rc.5. The optional local
 * context is supplied by the host, not read out of the remote request:
 * - fileChange: matched Codex item/started notification params;
 * - callId: exact already-presented DSH tool call, when the host has one.
 * Unsupported protocols throw, and unreviewable approval scopes are denied.
 */
export async function handleServerRequest(ctx, agent, method, params, signal, { fileChange, callId } = {}) {
  switch (method) {
    case COMMAND_APPROVAL: {
      route(params);
      const display = commandDescription(params);
      return display === null ? { decision: 'decline' } : approve(ctx, agent, 'codex_command', display, signal, callId);
    }
    case FILE_APPROVAL: {
      route(params);
      const display = fileDescription(params, fileChange);
      return display === null ? { decision: 'decline' } : approve(ctx, agent, 'codex_file_change', display, signal, callId);
    }
    case PERMISSIONS_APPROVAL:
      route(params);
      return { permissions: {}, scope: 'turn' };
    case USER_INPUT: {
      route(params);
      notAborted(signal);
      const { questions, offered } = readQuestions(params);
      if (!agent || typeof ctx?.userQuestions?.ask !== 'function') throw deniedInput();
      let result;
      try {
        result = await ask(ctx, { agent, questions, ...(signal === undefined ? {} : { signal }) });
      } catch {
        notAborted(signal);
        throw deniedInput();
      }
      notAborted(signal);
      return encodeAnswers(result, offered);
    }
    default:
      throw new Error('Unsupported Codex interaction request');
  }
}
