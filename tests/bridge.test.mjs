import test from 'node:test'
import assert from 'node:assert/strict'
import { BINDING, createBridge, MODEL, PROVIDER, toCodexInput, toDshStream } from '../src/bridge.mjs'

const collect = async (stream) => Array.fromAsync(stream)
const text = (value, kind = 'user') => ({ source: { kind }, content: [{ type: 'text', text: value }] })
const id = 'a6a640dc-97c8-404c-9b2f-22b93188714e'
const route = { provider: PROVIDER, model: MODEL }
const native = { provider: 'deepseek', model: 'native' }

function world() {
  let current = native
  let active
  const events = []
  const runtimes = []
  const agent = { id: 'dsh1', preset: 'codex', model: { current: () => current, select: route => { current = route } } }
  agent.session = { agent, header: { cwd: '/tmp' }, inheritedEventCount: 0, snapshotEvents: (offset = 0) => events.slice(offset) }
  active = agent
  const calls = []
  const api = createBridge({
    agentPresets: { presetForSession: (session) => session.agent.preset },
    agents: { currentInitiator: () => active, get: () => agent },
    sessions: { flush: async () => { calls.push('flush'); return true } },
  }, {
    appendRecord(_session, type, data) { events.push({ type, data }) },
    createRuntime({ threadId, saveThreadId }) {
      const runtime = {
        threadId, closed: 0,
        async close() { this.closed++ },
        async *turn(input) {
          if (!this.threadId) {
            await saveThreadId(id)
            this.threadId = id
          }
          calls.push(input)
          yield { type: 'text', text: 'answer' }
          yield { type: 'completed' }
        },
      }
      runtimes.push(runtime)
      return runtime
    },
  })
  const pre = (signal, messages) => api.preStep({ agent, signal, messages, modelSelection: agent.model.current() }, () => 'native')
  const run = (signal, options = {}) => collect(api.stream({ ...route, sessionId: agent.id, signal, ...options }))
  return { api, agent, pre, run, calls, events, runtimes, setActive: (value) => { active = value } }
}

test('other presets keep the built-in route and do not send to Codex', async () => {
  const w = world()
  w.agent.preset = 'standard'
  w.api.selectRoute(w.agent)
  assert.deepEqual(w.agent.model.current(), native)
  const signal = new AbortController().signal
  assert.equal(await w.pre(signal, [text('private')]), 'native')
  assert.equal((await w.run(signal))[0].reason.kind, 'error')
  assert.deepEqual(w.calls, [])
})

test('Codex sees only captured input, not DSH system context or previous history', async () => {
  const w = world()
  w.api.selectRoute(w.agent)
  const signal = new AbortController().signal
  const prompt = text('new request')
  assert.deepEqual(await w.pre(signal, [text('private context', 'runtime-context'), prompt]),
    { kind: 'enter', messages: [prompt] })
  await w.run(signal, { purpose: 'session-title' })
  w.setActive({ id: w.agent.id })
  await w.run(signal)
  w.setActive(w.agent)
  const result = await w.run(signal, { messages: [text('old DSH history')] })
  assert.deepEqual(result.map(event => event.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  assert.deepEqual(w.calls, ['flush', [{ type: 'text', text: 'new request', text_elements: [] }]])
  assert.deepEqual(w.events, [{ type: BINDING, data: { version: 1, sessionId: 'dsh1', cwd: '/tmp', threadId: id } }])
  assert.equal((await w.run(signal))[0].reason.kind, 'error')
  await w.api.disposeAgent(w.agent)
  assert.equal(w.runtimes[0].closed, 1)
})

test('binding is reused on reconstructed runtime, and foreign or forked bindings fail closed', async () => {
  const w = world()
  w.api.selectRoute(w.agent)
  const signal = new AbortController().signal
  w.events.push({ type: BINDING, data: { version: 1, sessionId: 'dsh1', cwd: '/tmp', threadId: id } })
  await w.pre(signal, [text('follow-up')])
  await w.run(signal)
  assert.equal(w.runtimes[0].threadId, id)
  assert.equal(w.calls.length, 1)
  await w.api.disposeAgent(w.agent)
  w.events[0].data.sessionId = 'dsh2'
  await w.pre(signal, [text('do not send')])
  await assert.rejects(w.run(signal), /绑定无效/)
  w.events.splice(0, w.events.length, { type: 'assistant/message', data: { message: { source: { provider: PROVIDER } } } })
  await w.pre(signal, [text('do not start replacement')])
  await assert.rejects(w.run(signal), /绑定已丢失/)
  w.agent.session.header.parentSession = 'parent'
  await assert.rejects(w.pre(signal, [text('do not fork')]), /分叉/)
  assert.equal(w.calls.length, 1)
})

test('explicit route mis-selection fails closed and DSH retry is not replayed', async () => {
  const w = world()
  const signal = new AbortController().signal
  await assert.rejects(w.pre(signal, [text('bad route')]), /重新发送/)
  assert.deepEqual(w.agent.model.current(), route)
  await w.pre(signal, [text('old prompt', 'retry')])
  assert.equal((await w.run(signal))[0].reason.failure.code, 'CODEX_EXPLICIT_RETRY_REQUIRED')
  assert.deepEqual(w.calls, [])
})

test('supports explicit normalized raster attachments; unsupported inputs are not silently ignored', async () => {
  const ref = { id: 'a' }
  const image = { source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] }
  assert.deepEqual(await toCodexInput([text('caption'), image], (seen) => {
    assert.equal(seen, ref)
    return { ref: { mediaType: 'image/png' }, data: Uint8Array.of(1, 2) }
  }), [{ type: 'text', text: 'caption', text_elements: [] }, { type: 'image', url: 'data:image/png;base64,AQI=' }])
  await assert.rejects(toCodexInput([{ content: [{ type: 'file' }] }]), /附件类型/)
})

test('output block ordering and terminal response do not synthesize DSH tool invocations', async () => {
  const stream = await collect(toDshStream([
    { type: 'reasoning', text: 'Summary' }, { type: 'progress', text: ' progress' },
    { type: 'tool-call', name: 'do-not-execute' },
    { type: 'text', text: 'Done' }, { type: 'completed' },
  ]))
  assert.deepEqual(stream.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block),
    [{ type: 'reasoning', text: 'Summary\n•  progress\n' }, { type: 'text', text: 'Done' }])
  assert.equal(stream.at(-1).reason.kind, 'stop')
  await assert.rejects(collect(toDshStream([{ type: 'text', text: 'unfinished' }])), /没有确认/)
})
