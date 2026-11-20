import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { createBridge, MODEL, PROVIDER, PRESET } from './bridge.mjs'
import { CodexSession } from './codex-session.mjs'
import { CodexRpcClient } from './rpc.mjs'
import { handleServerRequest } from './interaction.mjs'

export const inject = ['agents', 'agentPresets', 'llm', 'sessions']

const inheritedEnv = /^(PATH|PATHEXT|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|SystemRoot|WINDIR|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_.*|XDG_.*|CODEX_HOME|OPENAI_API_KEY|CODEX_API_KEY|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS|SSH_AUTH_SOCK)$/i
function codexEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => inheritedEnv.test(key)))
}

export function apply(ctx) {
  const bridge = createBridge(ctx, {
    appendRecord: appendPluginRecord,
    createRuntime: ({ agent, cwd, threadId, saveThreadId }) => new CodexSession({
      cwd, threadId, saveThreadId,
      createClient: (options) => new CodexRpcClient({
        ...options, env: codexEnv(), serverRequestTimeoutMs: 10 * 60_000,
      }),
      onServerRequest: (method, params, signal, details) => handleServerRequest(ctx, agent, method, params, signal, details),
    }),
  })
  class CodexAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Codex App Server' } }
    async listModels(provider) {
      return [{ provider, id: MODEL, name: 'Codex default', inputModalities: ['text', 'image'] }]
    }
    async resolveModel(provider, id) {
      return { provider, id, name: 'Codex default', inputModalities: ['text', 'image'] }
    }
    stream(options) { return bridge.stream(options) }
  }
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new CodexAdapter()))
  ctx.on('agent/created', ({ agent }) => { bridge.selectRoute(agent) }, { global: true })
  ctx.on('agent-preset/selected', (id, preset) => {
    const agent = ctx.agents.get(id)
    if (!agent) return
    if (preset === PRESET) bridge.selectRoute(agent)
    else if (agent.model.current()?.provider === PROVIDER) {
      // Restore a real native route if one was available before mode selection.
      const previous = [...agent.session.snapshotEvents()].reverse().find(
        (event) => event.type === 'model/selection' && event.data.provider !== PROVIDER,
      )
      const route = previous?.data ?? ctx.get('agentDefaultModel')?.currentSelection()
      if (route && route.provider !== PROVIDER) agent.model.select(route)
    }
  })
  ctx.on('agent/pre-step', bridge.preStep, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    void bridge.disposeAgent(agent).catch(() => ctx.logger.warn('Codex app-server process cleanup failed.'))
  }, { global: true })
  ctx.effect(() => () => bridge.close())
}
