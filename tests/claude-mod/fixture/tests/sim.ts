// Test helpers: the engine's side of the bridge, in memory.
//
// `claude plugin test` runs a test where there is no process and no network, so the child host is
// the same protocol core the real fake host uses (runtime/fake-host-core.mjs), wired to the
// `process.spawn` and `http.fetch` hooks that stand for the engine beneath the plugin.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { createHostCore } from '../runtime/fake-host-core.mjs'

export const PLUGIN = 'dsh-fixture'
export const tn = (short: string): `mcp__${string}__${string}` => `mcp__${PLUGIN}__${short}`

type Core = ReturnType<typeof createHostCore>
type HostConfig = Record<string, unknown>

export type World = {
  /** Every tool the plugin registered, in order. */
  registered: { name: string; description: string; inputSchema: Record<string, unknown> }[]
  commands: { name: string; description: string }[]
  /** Lines drawn in the transcript. */
  logs: string[]
  /** Lines for the debug log only. */
  debugLogs: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  spawns: { argv: readonly string[]; cwd?: string; env?: Record<string, string> }[]
  modelCalls: Record<string, unknown>[]
  agentCalls: Record<string, unknown>[]
  asks: { question: string; options: string[]; header?: string }[]
  /** The answer the engine's AskUserQuestion dialog gives (an option label, or free text); null: dismissed. */
  answer: string | null
  /** Answers given in turn before `answer` is used (one per dialog). */
  answers: (string | null)[]
  /** The child hosts started so far (one per spawn), newest last. */
  cores: Core[]
  /** How many child loops were left while the child still ran (the engine kills the child then). */
  killed: number
  /** Ends the newest child as a crash would. */
  crash: (code: number) => void
  clock: ReturnType<typeof mock.clock>
  /** Methods the newest child received, in order. */
  methods: () => string[]
}

/**
 * Registers the hooks that stand for the engine and for the child host, and returns what they saw.
 * Call before the first call on `$`. `hostConfig` may be a function of the spawn number (1, 2, ...)
 * so a restart can differ from the first start.
 */
export function stage(
  on: On,
  hostConfig: HostConfig | ((spawn: number) => HostConfig) = {},
  options: {
    beforeAnswer?: () => Promise<void>
    answer?: string | null
    answers?: (string | null)[]
    chunkSize?: number
    spawnError?: string
    /** Changes a child's RPC result before the mod reads it (`spawn` as in `hostConfig`): stands for what the real host adds. */
    rewrite?: (method: string, params: Record<string, unknown>, result: unknown, spawn: number) => unknown
  } = {},
): World {
  const world: World = {
    registered: [],
    commands: [],
    logs: [],
    debugLogs: [],
    toasts: [],
    statuses: [],
    spawns: [],
    modelCalls: [],
    agentCalls: [],
    asks: [],
    answer: options.answer === undefined ? 'Approve' : options.answer,
    answers: [...(options.answers ?? [])],
    cores: [],
    killed: 0,
    crash: () => {},
    clock: mock.clock(on),
    methods: () => world.cores.at(-1)?.calls.map(c => c.method) ?? [],
  }

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => {
    world.registered.push({ name: e.name, description: e.description, inputSchema: e.inputSchema })
    return { value: { tool: tn(e.name) } }
  })
  on('command.register', (_, e) => {
    world.commands.push({ name: e.name, description: e.description })
    return { value: { command: e.name } }
  })
  on('ui.log', (_, e) => {
    ;(e.to === 'debug' ? world.debugLogs : world.logs).push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('session.model', () => ({ value: 'test-model' }))
  on('model.complete', (_, e) => {
    world.modelCalls.push({ model: e.model, prompt: e.prompt, system: e.system })
    return {
      value: {
        isAnswered: true as const,
        text: 'model says hi',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  // `$.agent.spawn`: the engine starts the subagent and answers with its id (the plugin reads it from `result`).
  on('agent.spawn', (_, e) => {
    world.agentCalls.push({ prompt: e.prompt, description: e.description, subagentType: e.subagentType })
    return { model: 'test-model', agentId: 'agent-1', result: { agentId: 'agent-1' } } as never
  })
  // The engine's AskUserQuestion dialog: the person picks `world.answer`.
  on('tool.call', { tool: 'AskUserQuestion' }, async (_, e) => {
    if (options.beforeAnswer) await options.beforeAnswer()
    const q = e.questions[0]
    world.asks.push({ question: q?.question ?? '', options: (q?.options ?? []).map(o => o.label), ...(q?.header !== undefined ? { header: q.header } : {}) })
    const answer = world.answers.length > 0 ? (world.answers.shift() ?? null) : world.answer
    return { result: { questions: e.questions, answers: answer === null ? {} : { [q?.question ?? '']: answer } } }
  })

  // The child hosts. Each spawn is a new host on its own port; a request to another port is refused.
  const hostsByPort = new Map<number, Core>()
  const crashers: ((code: number) => void)[] = []
  world.crash = code => crashers.at(-1)?.(code)

  on('process.spawn', async function* (_, e) {
    const n = world.spawns.length + 1
    if (options.spawnError !== undefined) {
      world.spawns.push({ argv: e.argv })
      return { deny: options.spawnError } // the engine could not start the command
    }
    world.spawns.push({ argv: e.argv, ...(e.cwd !== undefined ? { cwd: e.cwd } : {}), ...(e.env !== undefined ? { env: e.env } : {}) })
    const queue: string[] = []
    let wake: (() => void) | undefined
    let exited: number | undefined
    const port = 40000 + n
    const config = typeof hostConfig === 'function' ? hostConfig(n) : hostConfig
    const core = createHostCore({
      config,
      port,
      emit: message => {
        const text = `${typeof message.__raw === 'string' ? message.__raw : JSON.stringify(message)}\n`
        const size = options.chunkSize ?? text.length
        for (let i = 0; i < text.length; i += size) queue.push(text.slice(i, i + size))
        wake?.()
      },
      sleep: ms => world.clock.sleep(ms),
      exit: code => {
        exited = code
        wake?.()
      },
    })
    world.cores.push(core)
    hostsByPort.set(port, core)
    crashers.push(code => {
      exited = code
      wake?.()
    })
    core.start()
    try {
      for (;;) {
        const piece = queue.shift()
        if (piece !== undefined) {
          yield { stream: 'stdout' as const, text: piece }
          continue
        }
        if (exited !== undefined) {
          if (exited !== 0) yield { stream: 'stderr' as const, text: `host crashed with ${exited}\n` }
          return { value: { code: exited, signal: null } }
        }
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    } finally {
      hostsByPort.delete(port)
      if (exited === undefined) world.killed += 1
    }
  })
  on('http.fetch', async (_, e) => {
    const port = Number(new URL(e.url).port)
    const core = hostsByPort.get(port)
    if (core === undefined) throw new Error(`connect ECONNREFUSED 127.0.0.1:${port}`)
    const headers = e.init?.headers ?? {}
    const r = await core.rpc(headers.authorization, e.init?.body ?? '')
    const body = r.body as { result?: unknown }
    if (options.rewrite !== undefined && r.status === 200 && 'result' in body) {
      const sent = JSON.parse(e.init?.body ?? '{}') as { method?: string; params?: Record<string, unknown> }
      body.result = options.rewrite(sent.method ?? '', sent.params ?? {}, body.result, world.cores.indexOf(core) + 1)
    }
    return { value: { status: r.status, ok: r.status < 300, headers: {}, text: JSON.stringify(body) } }
  })
  return world
}

export const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

/** The toasts of a world, less the start's notice about the fixture's required key (left unfilled in most tests). */
export const toastsOf = (world: World): string[] => world.toasts.filter(t => !t.includes('（代碼：SECRET_MISSING）'))

/** Whatever a `$.tool.call` / `$.command.run` answer carries, as one string to look into. */
export function textOf(answer: unknown): string {
  return JSON.stringify(answer)
}

/** The `deny` text of an answer, or undefined when the call was answered. */
export function denyOf(answer: unknown): string | undefined {
  const d = (answer as { deny?: unknown }).deny
  return typeof d === 'string' ? d : undefined
}

/** The text blocks of a hook-answered `result`, joined. */
export function resultText(answer: unknown): string {
  const result = (answer as { result?: unknown }).result
  if (!Array.isArray(result)) return typeof result === 'string' ? result : JSON.stringify(result)
  return result.map(b => (b as { text?: string }).text ?? '').join('\n')
}

/** The facts a system prompt is composed from, for `$.prompt.compose` in a test. */
export const COMPOSE = {
  model: 'test-model',
  promptModel: 'test-model',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const

/** What `$.command.run` takes in a test: the engine's whole input. */
export const slash = (command: string, args = '') =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }) as const
