import { isAbsolute } from 'node:path'

export const PRESET = 'codex'
export const PROVIDER = 'codex-app-server'
export const MODEL = 'default'
export const BINDING = 'plugin:dsh-codex-app-server/thread'
const selection = Object.freeze({ provider: PROVIDER, model: MODEL })
const isCodexRoute = (value) => value?.provider === PROVIDER && value.model === MODEL
const isUserInput = (message) => ['user', 'retry'].includes(message?.source?.kind)
const isUuid = (value) => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

function errors(code, message) {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

// Only the inputs claimed for this exact DSH step go to Codex; its own thread
// already holds history. Auxiliary LLM calls must never create or advance it.
export function createBridge(ctx, { createRuntime, appendRecord }) {
  const captured = new WeakMap()
  const entries = new Map()
  let stopping = false
  const isCodex = (agent) => ctx.agentPresets.presetForSession(agent.session) === PRESET

  function selectRoute(agent) {
    if (isCodex(agent) && !isCodexRoute(agent.model.current())) {
      agent.model.select(selection)
    }
  }

  async function preStep({ agent, messages, signal, modelSelection }, next) {
    if (!isCodex(agent)) return next()
    captured.delete(signal)
    if (agent.session.header.parentSession !== undefined || agent.session.inheritedEventCount > 0) {
      throw new Error('Codex 模式暂不支持从 DSH 分叉，请新建 Codex 会话。')
    }
    if (!isCodexRoute(modelSelection)) {
      // Refresh the route for the next user action; never fall through to another model.
      selectRoute(agent)
      throw new Error('Codex 模式不能使用其他模型入口。已恢复 Codex 入口，请重新发送。')
    }
    // Native DSH may propose another step after the external turn, e.g. from
    // approval notices. Those are not new human turns and must not be forwarded.
    const input = messages.filter(isUserInput)
    if (input.length > 0) captured.set(signal, { agent, input })
    return { kind: 'enter', messages: input }
  }

  function loadThread(agent, cwd) {
    let binding
    let hasCodexAnswer = false
    for (const event of agent.session.snapshotEvents(agent.session.inheritedEventCount)) {
      if (event.type === 'assistant/message' && event.data?.message?.source?.provider === PROVIDER) {
        hasCodexAnswer = true
      }
      if (event.type !== BINDING) continue
      const value = event.data
      if (binding !== undefined || value?.version !== 1 || value.sessionId !== agent.id
        || value.cwd !== cwd || !isUuid(value.threadId)) {
        throw new Error('Codex 会话绑定无效；为避免串会话，不会另开线程。')
      }
      binding = value.threadId
    }
    if (!binding && hasCodexAnswer) throw new Error('历史记录中的 Codex 会话绑定已丢失，不会另开线程。')
    return binding
  }

  async function runtimeFor(agent, cwd) {
    if (stopping) throw new Error('Codex 插件正在卸载。')
    let entry = entries.get(agent.id)
    if (entry?.agent === agent && !entry.runtime.disposed) return entry.runtime
    if (entry) {
      entries.delete(agent.id)
      await entry.runtime.close()
    }
    if (stopping || ctx.agents.get(agent.id) !== agent) throw new Error('Codex 会话已经关闭。')
    const threadId = loadThread(agent, cwd)
    const runtime = createRuntime({
      agent, cwd, threadId,
      saveThreadId: async (id) => {
        if (!isUuid(id)) throw new Error('Codex 返回了无效的会话 ID。')
        appendRecord(agent.session, BINDING, { version: 1, sessionId: agent.id, cwd, threadId: id })
        if (!await ctx.sessions.flush(agent.session)) throw new Error('DSH 会话存储不能确认 Codex 绑定，已停止。')
      },
    })
    entries.set(agent.id, { agent, runtime })
    return runtime
  }

  async function* stream(options) {
    const { signal, sessionId, purpose } = options
    const current = ctx.agents.currentInitiator()
    const claim = signal && captured.get(signal)
    if (!current || !claim || current !== claim.agent || current.id !== sessionId
      || !isCodex(current) || !isCodexRoute(options) || purpose !== undefined) {
      yield errors('CODEX_ROUTE_OUTSIDE_PRESET', 'Codex 入口只处理 Codex 模式的主会话，不处理辅助请求。')
      return
    }
    captured.delete(signal)
    const cwd = current.session.header.cwd
    if (!cwd || !isAbsolute(cwd)) {
      yield errors('CODEX_WORKSPACE_REQUIRED', '请在本机工作区中创建 Codex 会话。')
      return
    }
    // A DSH retry can be ambiguous after a transport error: Codex may already
    // have accepted the old turn. Do not automatically repeat it.
    if (claim.input.some((message) => message.source.kind === 'retry')) {
      yield errors('CODEX_EXPLICIT_RETRY_REQUIRED', '无法确认上一轮是否已在 Codex 执行；请明确输入下一条消息，不会自动重放。')
      return
    }
    const input = await toCodexInput(claim.input, (ref) => ctx.get('attachments')?.readImage(ref, signal))
    if (input.length === 0) {
      yield errors('CODEX_EMPTY_INPUT', '请输入提示词后再发送。')
      return
    }
    signal?.throwIfAborted()
    const runtime = await runtimeFor(current, cwd)
    signal?.throwIfAborted()
    yield* toDshStream(runtime.turn(input, { signal }))
  }

  async function disposeAgent(agent) {
    const entry = entries.get(agent.id)
    if (entry?.agent !== agent) return
    entries.delete(agent.id)
    await entry.runtime.close()
  }

  async function close() {
    stopping = true
    const all = [...entries.values()]
    entries.clear()
    await Promise.allSettled(all.map(({ runtime }) => runtime.close()))
  }

  return { selectRoute, preStep, stream, disposeAgent, close }
}

export async function toCodexInput(messages, readImage) {
  const input = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text.trim()) input.push({ type: 'text', text: block.text, text_elements: [] })
      } else if (block.type === 'image' && readImage) {
        const image = await readImage(block.attachment)
        const mediaType = image?.ref?.mediaType
        if (!image?.data || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
          throw new Error('无法读取这张图片，请重试或从工作区引用。')
        }
        input.push({ type: 'image', url: `data:${mediaType};base64,${Buffer.from(image.data).toString('base64')}` })
      } else {
        throw new Error('该附件类型暂不支持，请把文件放进工作区，在提示词里填写相对路径。')
      }
    }
  }
  return input
}

export async function* toDshStream(events) {
  let block
  let index = 0
  let complete = false
  for await (const event of events) {
    if (event.type === 'completed') { complete = true; break }
    const type = event.type === 'progress' ? 'reasoning' : event.type
    if ((type !== 'reasoning' && type !== 'text') || !event.text) continue
    const text = event.type === 'progress' ? `\n• ${event.text}\n` : event.text
    if (block?.type !== type) {
      if (block) yield { type: 'block-end', index: index++, block }
      block = { type, text: '' }
      yield { type: 'block-start', index, blockType: type }
    }
    block.text += text
    yield { type: `${type}-delta`, index, text }
  }
  if (block) yield { type: 'block-end', index, block }
  if (!complete) throw new Error('Codex 没有确认此轮完成。')
  yield { type: 'finish', reason: { kind: 'stop' } }
}
