// Protocol logic of the synthetic child host (SPEC.md "子程序宿主的通訊協定").
// Pure JavaScript, no Node APIs: the real wrapper (fake-host.mjs) puts it behind an HTTP
// server and stdout, and the mod's tests (which run where there is no process and no
// network) wire it to `process.spawn` / `http.fetch` hooks in memory.
//
// config (all optional):
//   tools        [{ dshName, name?, description?, inputSchema?, delayMs? }]  delayMs: the tool waits that long (or until cancelled)
//   commands     [{ name, description }]
//   promptSections [{ id, text }]
//   interception boolean     pre denies any input holding "forbidden"; rewrites "rewrite-me"; post replaces results of "post-me"
//   fatal        string      send { type: "fatal", message } instead of ready, then exit 1
//   readyDelayMs number
//   reverse      "approval" | "model" | "agent" | "notify" | "ask" | "exec" | "followup" | "unknown"  what the tool "ask" sends to the mod
//                (the call's argument `params`, when it is an object, replaces the request's default params)
//   metadata     object      the ready message's metadata (default { fake: true })
//   exitAfterReadyMs number  exit unexpectedly after ready (crash test)
//   crashBeforeReady number  exit with this code before saying anything
//   noise        boolean     write non-JSON lines to stdout before ready
//
// Built-in tool behaviours (by dshName): "echo" returns its args as JSON, "fail" returns isError,
// "ask" sends the configured reverse request and returns the reply as JSON, "grow" emits
// toolsChanged with one more tool, "reprompt" emits promptChanged.

function process_noise(emit) {
  // the wrapper's emit() writes JSON lines; noise is a raw object that serialises to a non-protocol line
  emit({ __raw: 'Debugger listening on ws://127.0.0.1:9229 (not a protocol line)' })
  emit({ type: 'surprise', note: 'a message type the mod does not know' })
}

/**
 * @param {{
 *   config?: any,
 *   emit: (message: any) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   exit?: (code: number) => void,
 *   token?: string,
 *   port?: number,
 * }} options
 */
export function createHostCore(options) {
  const config = options.config ?? {}
  const emit = options.emit
  const sleep = options.sleep ?? (() => new Promise(() => {}))
  const exit = options.exit ?? (() => {})
  const token = options.token ?? 'fake-token-0123456789abcdef0123456789abcdef'
  let port = options.port ?? 40123
  const calls = []
  const cancelled = new Map()
  const pendingReplies = new Map()
  let nextRequest = 1
  let tools = (config.tools ?? [{ dshName: 'echo', description: 'Echo the arguments' }]).map(normalizeTool)

  function normalizeTool(t) {
    return {
      dshName: t.dshName,
      name: t.name ?? t.dshName,
      description: t.description ?? `Fake tool ${t.dshName}`,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      delayMs: t.delayMs,
    }
  }

  const publicTools = () => tools.map(({ delayMs, ...rest }) => rest)

  function start() {
    const go = () => {
      if (config.noise === true) process_noise(emit)
      if (typeof config.crashBeforeReady === 'number') {
        exit(config.crashBeforeReady)
        return
      }
      if (typeof config.fatal === 'string') {
        emit({ type: 'fatal', code: 'FAKE_FATAL', message: config.fatal })
        exit(1)
        return
      }
      emit({
        type: 'ready',
        port,
        token,
        tools: publicTools(),
        commands: config.commands ?? [],
        promptSections: config.promptSections ?? [],
        interception: config.interception === true,
        metadata: config.metadata ?? { fake: true },
      })
      if (typeof config.exitAfterReadyMs === 'number') {
        void sleep(config.exitAfterReadyMs).then(() => exit(3))
      }
    }
    if (typeof config.readyDelayMs === 'number' && config.readyDelayMs > 0) void sleep(config.readyDelayMs).then(go)
    else go()
  }

  const text = (s, isError = false) => ({ content: [{ type: 'text', text: s }], isError })

  async function callTool({ name, args, callId }) {
    const tool = tools.find(t => t.dshName === name)
    if (!tool) return text(`unknown tool ${name}`, true)
    if (tool.delayMs !== undefined) {
      const gate = new Promise(resolve => cancelled.set(callId, () => resolve('cancelled')))
      const outcome = await Promise.race([gate, sleep(tool.delayMs).then(() => 'done')])
      cancelled.delete(callId)
      return outcome === 'cancelled' ? text(`cancelled ${name}`, true) : text(`finished ${name}`)
    }
    switch (name) {
      case 'echo':
        return text(JSON.stringify({ name, args }))
      case 'fail':
      case 'post_fail':
        return text('the tool failed on purpose', true)
      case 'ask': {
        const method = { approval: 'approval.request', model: 'model.complete', agent: 'agent.spawn', notify: 'ui.notify', ask: 'ui.ask', exec: 'exec.check', followup: 'prompt.submit', ui: 'ui.execute', unknown: 'nothing.known' }[
          config.reverse ?? 'approval'
        ]
        const params = {
          // the shape lib/modules/claude/approval.mjs sends: { toolName, callId, reason, argumentSummary }
          'approval.request': { toolName: 'ask', callId: 'call-1', reason: 'Run the dangerous thing', argumentSummary: args },
          'model.complete': { prompt: 'say hi', system: 'be brief', model: 'deepseek-chat' },
          'agent.spawn': { prompt: 'do a thing', description: 'fake task' },
          'ui.execute': { name: 'post_comment', args: { bvid: 'TEST-ONLY', text: 'synthetic comment' } },
          'ui.notify': { text: 'hello from the host', level: 'info' },
          // the shape lib/modules/claude/user-questions.mjs sends: one question per request
          'ui.ask': { question: 'Which colour?', header: 'Colour', options: ['Red', 'Blue'] },
          // SECURITY-PLAN.md 約定 4
          'exec.check': { tool: 'Bash', command: 'git status', cwd: '/work', why: 'Fixture plugin: the status feature' },
          // the shape lib/modules/claude/conversation.mjs sends for agent.followup
          'prompt.submit': { text: 'a thought of my own', source: { kind: 'mate' } },
        }[method] ?? {}
        const sent = args !== null && typeof args === 'object' && args.params !== null && typeof args.params === 'object' ? args.params : params
        const id = `req-${nextRequest++}`
        const reply = new Promise(resolve => pendingReplies.set(id, resolve))
        emit({ type: 'request', id, method, params: sent })
        if(method==='ui.execute'&&config.cancelUiRequest)emit({type:'requestCanceled',id})
        return text(JSON.stringify({ method, reply: await reply }))
      }
      case 'grow':
        tools = [...tools, normalizeTool({ dshName: `extra${tools.length}`, description: 'Added later' })]
        emit({ type: 'toolsChanged', tools: publicTools() })
        return text('grown')
      case 'shrink':
        tools = tools.filter(t => t.dshName !== 'echo')
        emit({ type: 'toolsChanged', tools: publicTools() })
        return text('shrunk')
      case 'reprompt':
        emit({ type: 'promptChanged', promptSections: [{ id: 'later', text: 'Changed prompt text.' }] })
        return text('reprompted')
      default:
        return text(`ran ${name} with ${JSON.stringify(args)}`)
    }
  }

  async function handle(method, params) {
    calls.push({ method, params })
    switch (method) {
      case 'tools.call':
        return callTool(params)
      case 'tools.cancel':
        cancelled.get(params.callId)?.()
        return {}
      case 'commands.run':
        return { text: `ran command ${params.name} with args "${params.args ?? ''}"` }
      case 'interception.pre': {
        const raw = JSON.stringify(params.input ?? {})
        if (raw.includes('forbidden')) return { decision: 'deny', reason: `blocked by the fake host: ${params.tool}` }
        if (raw.includes('rewrite-me')) return { decision: 'allow', input: { ...params.input, command: 'echo rewritten' } }
        return { decision: 'allow' }
      }
      case 'session.event':
        return { turn: 1 }
      case 'interception.post':
        return String(params.result).includes('post-me') ? { result: 'the fake host saw post-me' } : {}
      case 'reply': {
        const resolve = pendingReplies.get(params.id)
        pendingReplies.delete(params.id)
        resolve?.(params.error !== undefined ? { error: params.error } : { result: params.result })
        return {}
      }
      case 'ui.open':
        return {url:'http://127.0.0.1:45678/'};
      case 'status':
        return { state: 'ready', plugin: { name: 'fake' }, tools: tools.length, services: ['fake-service'], unsupported: [] }
      case 'dispose':
        void sleep(10).then(() => exit(0))
        return {}
      default:
        throw Object.assign(new Error(`unknown method ${method}`), { code: 'NO_METHOD' })
    }
  }

  /** One HTTP POST /rpc as the server sees it. */
  async function rpc(authorization, bodyText) {
    if (authorization !== `Bearer ${token}`) return { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'missing or wrong token' } } }
    let body
    try {
      body = JSON.parse(bodyText)
    } catch {
      return { status: 400, body: { error: { code: 'BAD_JSON', message: 'body is not JSON' } } }
    }
    try {
      return { status: 200, body: { result: await handle(body.method, body.params ?? {}) } }
    } catch (e) {
      return { status: 200, body: { error: { code: e.code ?? 'ERROR', message: String(e.message ?? e) } } }
    }
  }

  return { start, rpc, token, calls, handle, setPort: p => { port = p } }
}
