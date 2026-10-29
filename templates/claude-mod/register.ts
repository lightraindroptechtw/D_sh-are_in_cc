// DSH -> Claude Code bridge: the hooks module every converted DSH plugin ships.
//
// This module runs inside Claude Code (no Node, no DOM; everything goes through `$`).
// The real DSH plugin runs in a child process (`node <plugin root>/runtime/claude-host.mjs`)
// that this module starts at `session.start`, talks to over stdout JSON lines (child -> module)
// and HTTP on 127.0.0.1 (module -> child). The protocol is written in SPEC.md of the converter.
//
// The converter replaces the string literal below (quotes included) with the JSON config.

import type { EngineInterface, Register, ToolCallResult } from 'claude-code'
import { rewriteCommandRun, rewritePromptCompose, rewritePromptSubmit, rewriteSessionEnd, rewriteSessionStart, rewriteToolCall, rewriteTurnComplete } from './rewrite-shared.ts'

const RAW_CONFIG: unknown = "__DSH_BRIDGE_CONFIG__"

// ---------------------------------------------------------------------------
// Types and config
// ---------------------------------------------------------------------------

type Engine = EngineInterface
type Rec = Record<string, unknown>

type BridgeTool = {
  dshName: string
  name: string
  description: string
  inputSchema: Rec
}

/** A tool of the plugin that sends something outside (a comment, a message, a mail, a post): SECURITY-PLAN.md, 約定 2. */
type OutboundTool = {
  name: string
  dshName: string
  kind: string
  targetFields: string[]
  textFields: string[]
  summary: string
}

/** A key the plugin needs, kept in a sensitive userConfig field `option` and handed to the host as `env`. */
type SecretOption = {
  option: string
  env: string
  title: string
  features: string
  required: boolean
}

type BridgeConfig = {
  pluginName: string
  displayName: string
  hostEntry: string
  node: string
  startupTimeoutMs: number
  callTimeoutMs: number
  features: { tools: boolean; commands: boolean; systemPrompt: boolean; interception: boolean; ui?: boolean }
  staticTools: BridgeTool[]
  env: Record<string, string>
  outboundTools: OutboundTool[]
  secretOptions: SecretOption[]
  configError: string | undefined
}

type PromptSection = { id: string; text: string }
type DshCommand = { name: string; description: string }

type ReadyInfo = {
  port: number
  token: string
  tools: BridgeTool[]
  commands: DshCommand[]
  promptSections: PromptSection[]
  interception: boolean
  metadata: unknown
}

type Phase = 'starting' | 'ready' | 'fatal' | 'stopped'

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }

type Chunk = { stream: 'stdout' | 'stderr'; text: string }
type Exit = { code: number | null; signal: string | null }

type Host = {
  generation: number
  phase: Phase
  startedAt: number
  port: number | undefined
  token: string | undefined
  info: ReadyInfo | undefined
  error: string | undefined
  errorCode: string | undefined
  buffer: string
  stderrTail: string
  isStopping: boolean
  ready: Deferred
  /** Settles when the tools and commands of the ready message are registered (or the start failed). */
  setup: Deferred
  stream: AsyncGenerator<Chunk, Exit> | undefined
  startTimer: { cancel: () => void } | undefined
  /** Settles when the read loop ended, that is when the child process is gone. */
  loop: Promise<void> | undefined
}

type ToolEntry = {
  shortName: string
  fullName: string | undefined
  dshName: string
  specKey: string
  isActive: boolean
}

class RpcError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const posInt = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function cleanName(raw: string, fallback: string): string {
  const n = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return n === '' ? fallback : n
}

function normalizeTool(raw: unknown): BridgeTool | undefined {
  if (!isRec(raw)) return undefined
  const dshName = str(raw.dshName, str(raw.name))
  if (dshName === '') return undefined
  // A tool's input schema must describe an object: {} (a static tool whose parameters are unknown) becomes {type:'object'}.
  const given = isRec(raw.inputSchema) ? raw.inputSchema : {}
  const schema: Rec = typeof given.type === 'string' ? given : { ...given, type: 'object' }
  return {
    dshName,
    name: str(raw.name, dshName),
    description: str(raw.description).trim() === '' ? `DSH tool ${dshName}` : str(raw.description),
    inputSchema: schema,
  }
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])

function normalizeOutbound(raw: unknown): OutboundTool | undefined {
  if (!isRec(raw)) return undefined
  const name = str(raw.name)
  const dshName = str(raw.dshName)
  if (name === '' && dshName === '') return undefined
  return {
    name,
    dshName,
    kind: str(raw.kind, 'other'),
    targetFields: strList(raw.targetFields),
    textFields: strList(raw.textFields),
    summary: str(raw.summary),
  }
}

// The host's own control variables (DSH_CLAUDE_*) and anything that is not a plain name cannot be a key's variable.
const SECRET_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function normalizeSecret(raw: unknown): SecretOption | undefined {
  if (!isRec(raw)) return undefined
  const option = str(raw.option)
  const env = str(raw.env)
  if (option === '' || !SECRET_ENV_NAME.test(env) || env.startsWith('DSH_CLAUDE_')) return undefined
  return { option, env, title: str(raw.title, option), features: str(raw.features), required: raw.required === true }
}

function normalizeConfig(raw: unknown): BridgeConfig {
  const base: BridgeConfig = {
    pluginName: 'dsh-plugin',
    displayName: 'DSH plugin',
    hostEntry: 'runtime/claude-host.mjs',
    node: 'node',
    startupTimeoutMs: 120000,
    callTimeoutMs: 60000,
    features: { tools: true, commands: true, systemPrompt: true, interception: false },
    staticTools: [],
    env: {},
    outboundTools: [],
    secretOptions: [],
    configError: undefined,
  }
  if (!isRec(raw)) {
    return {
      ...base,
      configError:
        'the bridge config was not substituted into hooks/register.ts (it still holds the template placeholder)',
    }
  }
  const f = isRec(raw.features) ? raw.features : {}
  const env: Record<string, string> = {}
  if (isRec(raw.env)) for (const [k, v] of Object.entries(raw.env)) if (typeof v === 'string') env[k] = v
  const staticTools: BridgeTool[] = []
  if (Array.isArray(raw.staticTools)) {
    for (const t of raw.staticTools) {
      const n = normalizeTool(t)
      if (n !== undefined) staticTools.push(n)
    }
  }
  const pluginName = str(raw.pluginName, base.pluginName)
  return {
    pluginName,
    displayName: str(raw.displayName, pluginName),
    hostEntry: str(raw.hostEntry, base.hostEntry),
    node: str(raw.node, base.node),
    startupTimeoutMs: posInt(raw.startupTimeoutMs, base.startupTimeoutMs),
    callTimeoutMs: posInt(raw.callTimeoutMs, base.callTimeoutMs),
    features: {
      tools: f.tools !== false,
      commands: f.commands !== false,
      systemPrompt: f.systemPrompt !== false,
      interception: f.interception === true,
      ui: f.ui === true,
    },
    staticTools,
    env,
    outboundTools: (Array.isArray(raw.outboundTools) ? raw.outboundTools : [])
      .map(normalizeOutbound)
      .filter((o): o is OutboundTool => o !== undefined),
    secretOptions: (Array.isArray(raw.secretOptions) ? raw.secretOptions : [])
      .map(normalizeSecret)
      .filter((s): s is SecretOption => s !== undefined),
    configError: undefined,
  }
}

const CFG = normalizeConfig(RAW_CONFIG)

// Limits of this mod (not part of the protocol).
const SESSION_START_WAIT_MS = 7000 // a hook's own budget is 10 s; waiting on a timer counts against it
const HOOK_READY_WAIT_MS = 6000
const SLASH_WAIT_MS = 8000
const DISPOSE_WAIT_MS = 1500
// The host enforces callTimeoutMs itself (settings.json carries the same number) and answers with a precise error
// (and a notification); the mod's own limit is later so that answer arrives first.
const HOST_TIMEOUT_GRACE_MS = 5000
// When Claude Code exits (a `-p` run done, /exit) it ends the child before session.end; on Windows that reads as
// exit code 1. An exit is shown only if the session did not end within this time.
const EXIT_NOTICE_DELAY_MS = 3000
const MAX_STDOUT_BUFFER = 8 * 1024 * 1024
const STDERR_TAIL = 4000
const UI_NAME = `${cleanName(CFG.pluginName, 'dsh-plugin').slice(0, 56)}-ui`
const STATUS_NAME = `${cleanName(CFG.pluginName, 'dsh-plugin').slice(0, 56)}-status`
const RESTART_NAME = `${cleanName(CFG.pluginName, 'dsh-plugin').slice(0, 55)}-restart`
const TRUST_NAME = `${cleanName(CFG.pluginName, 'dsh-plugin').slice(0, 57)}-trust`
const APPROVE = 'Approve'
const DENY = 'Deny'
// Labels of the outbound confirmation (SECURITY-PLAN.md 第 4 項).
const SEND_ONCE = '這次送出'
const SEND_ALWAYS = '以後都自動發'
const SEND_NO = '不要送出'
const SEND_ALWAYS_CONFIRM = '確定，以後都自動發'
const SEND_ONLY_THIS = '只送這一次'
const EXEC_ALLOW = '允許這次執行'
const EXEC_DENY = '不允許'
// Labels of the trust question when the plugin starts a program by itself (same effect as the allowDirectExec option).
const TRUST_YES = '完全信任這個插件（它可以開任何程式、讀寫任何檔案）'
const TRUST_NO = '先不要'
const UNTRUST_YES = '取消信任'
const UNTRUST_NO = '保持信任'
const TRUST_KEY = 'trust-direct-exec'
/** Blocks of the Node permission model that the trust (or allowDirectExec) lifts: lib/modules/claude/blocked.mjs kinds. */
const DIRECT_EXEC_KINDS = new Set(['exec', 'addon', 'worker', 'wasi'])
const MASK = '[已遮蔽]'
/** A key shorter than this is not masked: replacing a short string everywhere would garble ordinary text. */
const MIN_MASK_LENGTH = 6
const OUTBOUND_LOG_KEY = 'outbound-log'
const OUTBOUND_LOG_MAX = 1000
const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

// ---------------------------------------------------------------------------
// Module state. It resets when the module reloads; the child is killed with the
// module (the spawn loop ends with it) and `session.start` fires again, so nothing
// here has to outlive a reload and no `$.state` contract is needed. The one thing
// that must outlive a session, the outbound log (and so its hourly/daily counts),
// is kept in `$.store`.
// ---------------------------------------------------------------------------

type OutboundMode = 'ask' | 'auto' | 'deny'
type OutboundRecord = { at: number; tool: string; target: string; preview: string }

let generation = 0
let host: Host | undefined
const reverseControllers = new Map<Host, Map<string, AbortController>>()
const toolsByShort = new Map<string, ToolEntry>()
const toolsByFull = new Map<string, ToolEntry>()
const commandsBySlash = new Map<string, string>()
let promptText = ''
let asksInFlight = 0
let reverseInFlight = 0
let registerChain: Promise<unknown> = Promise.resolve()
let lastError: string | undefined
let sessionCwd: string | undefined
let agentRequests = 0
const agentWaiters = new Map<string, (answer: string) => void>()
const agentAnswers = new Map<string, string>()

// The plugin's options (userConfig; SECURITY-PLAN.md 約定 1), read in `register`.
let optionAllowModel = true
let optionAllowAgents = true
let optionAllowInterception = false
let optionOutboundMode: OutboundMode = 'ask'
let optionHourlyLimit = 10
let optionDailyLimit = 50
let optionAllowDirectExec = false
/** "完全信任這個插件" chosen in the trust question, kept in `$.store` so it holds across sessions. */
let trustedExec = false
/** The trust question was put (or is up) in this load: a later block does not ask again. */
let trustAsked = false
/** The trust question while it is up: a tool call blocked meanwhile waits for the same answer. */
let trustPending: Promise<boolean> | undefined
/** Tool calls under way, by call id: a block notice raised inside one is left to that call. */
const callsInFlight = new Set<string>()
/** The block notices (first line) of calls under way, by call id. */
const callNotices = new Map<string, string>()
/** session.end has started (not a /clear): the child ending now is no crash. */
let sessionEnding = false
const directExecAllowed = (): boolean => optionAllowDirectExec || trustedExec
let optionExtraFolders = ''
let optionShareConversation = true
let optionAllowFollowups = false
/** env name -> the key's value, for the keys the person filled in. Never logged. */
const secretValues = new Map<string, string>()
/** The values masked in everything shown to Claude or the person, longest first. */
let maskList: string[] = []

/** "以後都自動發" chosen in this session while the option itself could not be changed. */
let sessionAutoOutbound = false
let outboundPersistNote: string | undefined
/** Sends under way in auto mode, counted against the limits before they are logged. */
let outboundInFlight = 0
let outboundChain: Promise<unknown> = Promise.resolve()
/** The log as last read or written; the only copy when `$.store` does not work. */
let outboundMemory: OutboundRecord[] = []
let storeError: string | undefined
const recentNotices: string[] = []
let secretNoticeShown = false
let interceptionNoticeShown = false
let conversationNoticeShown = false
let followupNoticeShown = false
/** The Claude Code session the conversation events belong to, and its model, read at the session's start. */
let sessionId = ''
let sessionModel = ''
/** Conversation events go to the host one after another, in the order they happened. */
let conversationChain: Promise<unknown> = Promise.resolve()
let toolCallSequence = 0

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const firstLine = (s: string): string => s.split('\n').find(l => l.trim() !== '')?.trim() ?? s
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}... (${s.length - n} more characters)` : s)
const head = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

/** Replaces every known key value (and its JSON-escaped spelling) with [已遮蔽]. */
function mask(text: string): string {
  let out = text
  for (const v of maskList) if (out.includes(v)) out = out.split(v).join(MASK)
  return out
}

function setSecrets(values: Map<string, string>): void {
  secretValues.clear()
  const list = new Set<string>()
  for (const [k, v] of values) {
    secretValues.set(k, v)
    if (v.length < MIN_MASK_LENGTH) continue
    list.add(v)
    const escaped = JSON.stringify(v).slice(1, -1)
    if (escaped !== v) list.add(escaped)
  }
  maskList = [...list].sort((a, b) => b.length - a.length)
}

/** The four-part message of a blocked action (SECURITY-PLAN.md 約定 5). */
function blocked(what: string, why: string, how: string, impact: string, code: string): string {
  return `[被擋下] ${what}\n原因：${why}\n怎麼放行：${how}\n影響：${impact}\n（代碼：${code}）`
}

function remember(text: string): void {
  recentNotices.push(text)
  if (recentNotices.length > 10) recentNotices.shift()
}

/** Every toast of this mod goes through here: masked, and remembered for the status command. */
function toast($: Engine, text: string): void {
  const shown = clip(mask(text), 1900)
  remember(shown)
  try {
    $.ui.toast(shown, { timeoutMs: 8000 })
  } catch {
    // a toast must never break the bridge
  }
}

/** `$.ui.ask` with the text masked; our own dialogs are not intercepted (see `intercept`). */
async function askUser($: Engine, question: string, options: { options: string[]; header: string }, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('操作已取消。')
  const aborted = abortPromise(signal)
  asksInFlight += 1
  try {
    return await Promise.race([$.ui.ask(mask(question), options), aborted.promise])
  } finally {
    aborted.cancel()
    asksInFlight -= 1
  }
}

async function nowMs($: Engine): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

function deferred(): Deferred {
  let resolve: () => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function debug($: Engine, text: string): void {
  try {
    $.ui.log(mask(`${CFG.displayName}: ${text}`), { to: 'debug' })
  } catch {
    // logging must never break the bridge
  }
}

function say($: Engine, text: string): void {
  try {
    $.ui.log(mask(`${CFG.displayName}: ${text}`))
  } catch {
    // ignore
  }
}

/** A timer that rejects after `ms` and re-arms while `isBusy()` (a person is deciding something). */
function deadline(
  $: Engine,
  ms: number,
  message: string,
  isBusy?: () => boolean,
): { promise: Promise<never>; cancel: () => void } {
  let timer: { cancel: () => void } | undefined
  let isCancelled = false
  const promise = new Promise<never>((_, reject) => {
    const arm = (): void => {
      timer = $.clock.after(ms, () => {
        if (isCancelled) return
        if (isBusy !== undefined && isBusy()) {
          arm()
          return
        }
        reject(new Error(message))
      })
    }
    arm()
  })
  promise.catch(() => {})
  return {
    promise,
    cancel: () => {
      isCancelled = true
      timer?.cancel()
    },
  }
}

/** Waits for `p`, but at most `ms`; resolves `false` on timeout, never rejects. */
async function settleWithin($: Engine, p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: { cancel: () => void } | undefined
  const timeout = new Promise<boolean>(resolve => {
    timer = $.clock.after(ms, () => resolve(false))
  })
  try {
    return await Promise.race([p.then(() => true, () => true), timeout])
  } finally {
    timer?.cancel()
  }
}

function abortPromise(signal: AbortSignal | undefined): { promise: Promise<never>; cancel: () => void } {
  if (signal === undefined) return { promise: new Promise<never>(() => {}), cancel: () => {} }
  let onAbort: () => void = () => {}
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('the call was cancelled'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  promise.catch(() => {})
  return { promise, cancel: () => signal.removeEventListener('abort', onAbort) }
}

// ---------------------------------------------------------------------------
// RPC to the child (module -> child)
// ---------------------------------------------------------------------------

type RpcOptions = { timeoutMs?: number; signal?: AbortSignal; isBusy?: () => boolean }

async function rpc($: Engine, h: Host, method: string, params: unknown, options: RpcOptions = {}): Promise<unknown> {
  if (h.port === undefined || h.token === undefined) throw new Error('the plugin host is not ready')
  const request = $.http.fetch(`http://127.0.0.1:${h.port}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  request.catch(() => {})
  const waits: Promise<unknown>[] = [request]
  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : deadline($, options.timeoutMs, `${method} timed out after ${options.timeoutMs} ms`, options.isBusy)
  if (timeout !== undefined) waits.push(timeout.promise)
  const aborted = abortPromise(options.signal)
  waits.push(aborted.promise)
  let response: { status: number; ok: boolean; text: string }
  try {
    response = (await Promise.race(waits)) as typeof response
  } finally {
    timeout?.cancel()
    aborted.cancel()
  }
  let body: unknown
  try {
    body = JSON.parse(response.text)
  } catch {
    body = undefined
  }
  if (isRec(body) && isRec(body.error)) {
    throw new RpcError(str(body.error.code, 'ERROR'), str(body.error.message, 'the plugin host reported an error'))
  }
  if (!response.ok) throw new Error(`the plugin host answered HTTP ${response.status}`)
  if (!isRec(body)) throw new Error('the plugin host answered with something that is not JSON')
  return body.result
}

// ---------------------------------------------------------------------------
// Starting, stopping and reading the child
// ---------------------------------------------------------------------------

function failHost($: Engine, h: Host, message: string, code?: string): void {
  for (const controller of reverseControllers.get(h)?.values() ?? []) controller.abort()
  reverseControllers.delete(h)
  if (h.phase === 'fatal') return
  h.phase = 'fatal'
  h.error = message
  h.errorCode = code
  h.startTimer?.cancel()
  lastError = message
  h.ready.reject(new Error(message))
  h.setup.resolve()
  try {
    $.ui.status(mask(`${CFG.displayName}: ${clip(firstLine(message), 300)}`))
  } catch {
    // ignore
  }
  say($, `${code !== undefined ? `[${code}] ` : ''}${clip(message, 1500)} (run /${STATUS_NAME} for details, /${RESTART_NAME} to retry)`)
}

function parseReady(msg: Rec): ReadyInfo | string {
  const port = msg.port
  const token = msg.token
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return 'the plugin host sent a ready message without a valid port'
  }
  if (typeof token !== 'string' || token === '') return 'the plugin host sent a ready message without a token'
  const tools: BridgeTool[] = []
  if (Array.isArray(msg.tools)) {
    for (const t of msg.tools) {
      const n = normalizeTool(t)
      if (n !== undefined) tools.push(n)
    }
  }
  const commands: DshCommand[] = []
  if (Array.isArray(msg.commands)) {
    for (const c of msg.commands) {
      if (isRec(c) && str(c.name) !== '') commands.push({ name: str(c.name), description: str(c.description, str(c.name)) })
    }
  }
  const promptSections: PromptSection[] = []
  if (Array.isArray(msg.promptSections)) {
    for (const s of msg.promptSections) {
      if (isRec(s) && str(s.text).trim() !== '') promptSections.push({ id: str(s.id, 'section'), text: str(s.text) })
    }
  }
  return { port, token, tools, commands, promptSections, interception: msg.interception === true, metadata: msg.metadata }
}

function setPrompt(sections: readonly PromptSection[]): void {
  promptText = sections.map(s => s.text.trim()).filter(t => t !== '').join('\n\n')
}

function enqueue(job: () => Promise<void>): Promise<unknown> {
  registerChain = registerChain.then(job, job)
  return registerChain
}

function handleLine($: Engine, h: Host, line: string): void {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    debug($, `non-protocol output from the host: ${clip(line, 200)}`)
    return
  }
  if (!isRec(msg) || typeof msg.type !== 'string') {
    debug($, `unrecognised host message: ${clip(line, 200)}`)
    return
  }
  switch (msg.type) {
    case 'ready': {
      if (h.phase !== 'starting') return
      const info = parseReady(msg)
      if (typeof info === 'string') {
        failHost($, h, info, 'BAD_READY')
        return
      }
      h.info = info
      h.port = info.port
      h.token = info.token
      h.phase = 'ready'
      h.error = undefined
      lastError = undefined
      h.startTimer?.cancel()
      setPrompt(info.promptSections)
      h.ready.resolve()
      try {
        $.ui.status(undefined)
      } catch {
        // ignore
      }
      noticeInterceptionOff($)
      noticeConversation($)
      // The model of this session, for agentDefaultModel.currentSelection() (one call, whatever the plugin follows).
      if (sessionModel !== '') {
        void rpc($, h, 'session.event', { kind: 'model', model: sessionModel, ...(sessionId !== '' ? { sessionId } : {}) }, { timeoutMs: 5000 }).catch(e =>
          debug($, `could not tell the plugin the model: ${errText(e)}`),
        )
      }
      void enqueue(async () => {
        await syncTools($, info.tools)
        await syncCommands($, info.commands)
      })
        .catch(e => debug($, `registering the plugin's tools/commands failed: ${errText(e)}`))
        .finally(() => h.setup.resolve())
      return
    }
    case 'fatal': {
      const message = str(msg.message).trim() || `the plugin host reported ${str(msg.code, 'a fatal error')} without a message`
      failHost($, h, message, str(msg.code) || undefined)
      return
    }
    case 'toolsChanged': {
      if (h.info === undefined || !Array.isArray(msg.tools)) return
      const tools = msg.tools.map(normalizeTool).filter((t): t is BridgeTool => t !== undefined)
      h.info.tools = tools
      void enqueue(() => syncTools($, tools)).catch(e => debug($, `re-registering tools failed: ${errText(e)}`))
      return
    }
    case 'promptChanged': {
      if (!Array.isArray(msg.promptSections)) return
      const sections: PromptSection[] = []
      for (const s of msg.promptSections) {
        if (isRec(s) && str(s.text).trim() !== '') sections.push({ id: str(s.id, 'section'), text: str(s.text) })
      }
      if (h.info !== undefined) h.info.promptSections = sections
      setPrompt(sections)
      return
    }
    case 'requestCanceled': {
      reverseControllers.get(h)?.get(str(msg.id))?.abort()
      return
    }
    case 'request': {
      void answerRequest($, h, msg)
      return
    }
    case 'log': {
      debug($, `[${str(msg.level, 'info')}] ${clip(str(msg.text), 1000)}`)
      return
    }
    default:
      debug($, `unknown host message type "${msg.type}" ignored`)
  }
}

function feed($: Engine, h: Host, text: string): void {
  h.buffer += text
  for (;;) {
    const at = h.buffer.indexOf('\n')
    if (at < 0) break
    const line = h.buffer.slice(0, at).replace(/\r$/, '')
    h.buffer = h.buffer.slice(at + 1)
    if (line.trim() !== '') handleLine($, h, line)
  }
  if (h.buffer.length > MAX_STDOUT_BUFFER) {
    debug($, 'the host wrote more than 8 MB without a newline; the unread part was dropped')
    h.buffer = ''
  }
}

async function runHost($: Engine, h: Host): Promise<void> {
  const root = $.plugin.root
  const secrets: Record<string, string> = {}
  for (const [name, value] of secretValues) secrets[name] = value
  const stream = $.process.spawn({
    argv: [CFG.node, `${root}/${CFG.hostEntry}`],
    cwd: root,
    // The names the child host reads (lib/claude-host/README.md, SECURITY-PLAN.md 約定 3): its working area is
    // the session's directory; the keys the person filled in, and their names so the host passes them on.
    env: {
      ...CFG.env,
      ...secrets,
      DSH_CLAUDE_SECRET_NAMES: Object.keys(secrets).join(','),
      DSH_CLAUDE_ALLOW_DIRECT_EXEC: directExecAllowed() ? '1' : '0',
      DSH_CLAUDE_EXTRA_FOLDERS: optionExtraFolders,
      DSH_CLAUDE_ALLOW_INTERCEPTION: optionAllowInterception ? '1' : '0',
      DSH_CLAUDE_BRIDGE: '1',
      DSH_CLAUDE_PLUGIN_ROOT: root,
      DSH_CLAUDE_PLUGIN_NAME: CFG.pluginName,
      ...(sessionCwd !== undefined && sessionCwd !== '' ? { DSH_CLAUDE_WORKSPACE: sessionCwd } : {}),
    },
  }) as AsyncGenerator<Chunk, Exit>
  h.stream = stream
  let exit: Exit | undefined
  try {
    for (;;) {
      const step = await stream.next()
      if (step.done === true) {
        exit = step.value
        break
      }
      const chunk = step.value
      if (host !== h) break
      if (chunk.stream === 'stdout') {
        feed($, h, chunk.text)
      } else {
        h.stderrTail = (h.stderrTail + chunk.text).slice(-STDERR_TAIL)
        debug($, `host stderr: ${clip(chunk.text.trimEnd(), 500)}`)
      }
    }
  } catch (e) {
    if (host === h && !h.isStopping) {
      failHost($, h, `could not run "${CFG.node} ${CFG.hostEntry}": ${errText(e)}`, 'SPAWN_FAILED')
    }
    return
  }
  for (const controller of reverseControllers.get(h)?.values() ?? []) controller.abort()
  reverseControllers.delete(h)
  if (host !== h) return
  if (h.buffer.trim() !== '') {
    const rest = h.buffer
    h.buffer = ''
    handleLine($, h, rest.trim())
  }
  h.startTimer?.cancel()
  if (h.phase === 'fatal') return
  if (h.isStopping) {
    h.phase = 'stopped'
    return
  }
  const how =
    exit === undefined
      ? 'no exit status'
      : exit.signal !== null
        ? `signal ${exit.signal}`
        : `exit code ${String(exit.code)}`
  const tail = h.stderrTail
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
    .slice(-5)
    .join(' | ')
  const base =
    h.phase === 'ready'
      ? `the plugin host exited unexpectedly (${how})`
      : `the plugin host exited before it was ready (${how})`
  const message = tail === '' ? base : `${base}: ${tail}`
  if (h.phase === 'ready') {
    h.phase = 'stopped'
    h.error = message
    lastError = message
    h.ready.reject(new Error(message))
    // Calls get the reason at once; the person sees it only if the session is not ending (see EXIT_NOTICE_DELAY_MS).
    $.clock.after(EXIT_NOTICE_DELAY_MS, () => {
      if (sessionEnding || host !== h) {
        debug($, `the plugin host ended (${how}) while the session ended or after a restart; not shown`)
        return
      }
      try {
        $.ui.status(mask(`${CFG.displayName}: ${firstLine(message)}`))
      } catch {
        // ignore
      }
      say($, `${message} (run /${RESTART_NAME} to start it again)`)
    })
  } else {
    failHost($, h, message, 'EXITED')
  }
}

function startHost($: Engine): Host {
  generation += 1
  const h: Host = {
    generation,
    phase: 'starting',
    startedAt: Date.now(),
    port: undefined,
    token: undefined,
    info: undefined,
    error: undefined,
    errorCode: undefined,
    buffer: '',
    stderrTail: '',
    isStopping: false,
    ready: deferred(),
    setup: deferred(),
    stream: undefined,
    startTimer: undefined,
    loop: undefined,
  }
  host = h
  if (CFG.configError !== undefined) {
    failHost($, h, CFG.configError, 'BAD_CONFIG')
    return h
  }
  h.startTimer = $.clock.after(CFG.startupTimeoutMs, () => {
    if (host !== h || h.phase !== 'starting') return
    failHost(
      $,
      h,
      `the plugin host did not send "ready" within ${CFG.startupTimeoutMs} ms${h.stderrTail.trim() === '' ? '' : `; last stderr: ${clip(h.stderrTail.trim().split('\n').slice(-3).join(' | '), 600)}`}`,
      'STARTUP_TIMEOUT',
    )
    stopStream(h)
  })
  h.loop = runHost($, h).catch(e => {
    if (host === h) failHost($, h, `the plugin host loop failed: ${errText(e)}`, 'LOOP_FAILED')
  })
  return h
}

function stopStream(h: Host): void {
  const stream = h.stream
  if (stream === undefined) return
  h.stream = undefined
  // Leaving the spawn loop kills the child (reference: `return()` on the stream). It is not awaited:
  // on a generator with a pull pending, return() waits for that pull.
  stream.return({ code: null, signal: null }).catch(() => {})
}

async function stopHost($: Engine, h: Host, waitMs: number): Promise<void> {
  h.isStopping = true
  for (const controller of reverseControllers.get(h)?.values() ?? []) controller.abort()
  reverseControllers.delete(h)
  h.startTimer?.cancel()
  if (h.phase === 'ready') {
    await settleWithin($, rpc($, h, 'dispose', {}, { timeoutMs: waitMs }), waitMs)
    // dispose answers first and the child shuts down a moment later (plugin cleanup, state writes);
    // killing it at once would cut that short, so give it the time to leave on its own.
    if (h.loop !== undefined) await settleWithin($, h.loop, waitMs)
  }
  if (h.phase !== 'fatal') h.phase = 'stopped'
  h.ready.reject(new Error('the plugin host was stopped'))
  h.setup.resolve()
  stopStream(h)
}

/** The running host, waiting up to `waitMs` for a starting one; throws the real reason otherwise. */
async function usableHost($: Engine, waitMs: number): Promise<Host> {
  const h = host
  if (h === undefined) throw new Error('the plugin host has not been started in this session')
  if (h.phase === 'starting') await settleWithin($, h.ready.promise, waitMs)
  if (h.phase === 'ready') return h
  if (h.phase === 'starting') {
    const seconds = Math.round((Date.now() - h.startedAt) / 1000)
    throw new Error(
      `the plugin host is still starting (${seconds} s so far, limit ${Math.round(CFG.startupTimeoutMs / 1000)} s); try again shortly`,
    )
  }
  throw new Error(h.error ?? 'the plugin host is not running')
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function shortNameFor(tool: BridgeTool): string {
  const existing = [...toolsByShort.values()].find(t => t.dshName === tool.dshName)
  if (existing !== undefined) return existing.shortName
  const base = cleanName(tool.name === '' ? tool.dshName : tool.name, 'tool')
  let name = base
  let i = 2
  while (toolsByShort.has(name)) {
    const suffix = `_${i}`
    name = `${base.slice(0, 64 - suffix.length)}${suffix}`
    i += 1
  }
  return name
}

async function syncTools($: Engine, tools: readonly BridgeTool[]): Promise<void> {
  const seen = new Set<string>()
  for (const tool of tools) {
    const shortName = shortNameFor(tool)
    seen.add(shortName)
    const specKey = JSON.stringify([tool.description, tool.inputSchema])
    const entry = toolsByShort.get(shortName) ?? {
      shortName,
      fullName: undefined,
      dshName: tool.dshName,
      specKey: '',
      isActive: true,
    }
    toolsByShort.set(shortName, entry)
    entry.dshName = tool.dshName
    entry.isActive = true
    if (entry.fullName !== undefined && entry.specKey === specKey) continue
    try {
      const done = await $.tool.register({ name: shortName, description: tool.description, inputSchema: tool.inputSchema })
      entry.fullName = done.tool
      entry.specKey = specKey
      toolsByFull.set(done.tool, entry)
    } catch (e) {
      debug($, `could not register tool "${tool.dshName}" as "${shortName}": ${errText(e)}`)
    }
  }
  for (const entry of toolsByShort.values()) {
    // There is no way to unregister a tool: it stays listed, and a call says it is gone.
    if (!seen.has(entry.shortName)) entry.isActive = false
  }
}

function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  const parts: string[] = []
  for (const b of content) {
    if (isRec(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (isRec(b) && typeof b.type === 'string') parts.push(`[${b.type} block omitted]`)
  }
  return parts.join('\n')
}

function toolArgs(e: unknown): Rec {
  const args: Rec = {}
  if (!isRec(e)) return args
  for (const [k, v] of Object.entries(e)) {
    if (k === 'tool' || k === 'tool_use_id' || k === 'agentId' || k === 'requestMeta') continue
    args[k] = v
  }
  return args
}

/** A tool's answer as Claude gets it: every known key value masked. */
function maskAnswer(answer: { deny: string } | { result: { type: 'text'; text: string }[] }): unknown {
  if ('deny' in answer) return { deny: mask(answer.deny) }
  return { result: answer.result.map(b => ({ ...b, text: mask(b.text) })) }
}

async function callOwnTool($: Engine, e: unknown, signal: AbortSignal, entry: ToolEntry): Promise<unknown> {
  const rec = isRec(e) ? e : {}
  const label = `${CFG.displayName}: ${entry.dshName}`
  if (!entry.isActive) return maskAnswer({ deny: `${label} is no longer provided by the plugin (its tool list changed).` })
  const args = toolArgs(e)
  if (signal.aborted) return maskAnswer({ deny: '操作已取消，工具沒有執行。' })
  // Outbound tools are told apart by name alone: no argument (a `force`, a mode) can take a call past this gate.
  const outbound = findOutbound(entry)
  let send: OutboundSend | undefined
  if (outbound !== undefined) {
    const gate = await gateOutbound($, outbound, entry, args, signal)
    if ('deny' in gate) return maskAnswer(gate)
    send = gate
  }
  const callId = str(rec.tool_use_id, `call-${Date.now()}`)
  callsInFlight.add(callId)
  try {
    if (signal.aborted) return maskAnswer({ deny: '操作已取消，工具沒有執行。' })
    let answer = await callHost($, entry, args, callId, signal)
    const notice = directExecBlock(answer, callId)
    if (notice !== undefined && (await trustForCall($, notice))) {
      // Trusted: the host restarted with the permission. The same call runs once more, on the new host once its tools are listed.
      const h = host
      if (h !== undefined) await settleWithin($, h.setup.promise, CFG.startupTimeoutMs)
      if (!entry.isActive) return maskAnswer({ deny: `${label} is no longer provided by the plugin (its tool list changed).` })
      debug($, `running ${entry.dshName} again now that the plugin is trusted`)
      answer = await callHost($, entry, args, `${callId}-again`, signal)
    }
    if ('deny' in answer) return maskAnswer(answer)
    const r = answer.result
    const text = textOfBlocks(r.content).trim()
    if (r.isError === true) return maskAnswer({ deny: text === '' ? `${label} reported an error without a message` : text })
    if (send !== undefined) await afterSend($, send, entry)
    return maskAnswer({ result: [{ type: 'text', text: text === '' ? '(no output)' : text }] })
  } finally {
    if (send?.isCounted === true) outboundInFlight -= 1
    callsInFlight.delete(callId)
    // A notice that came after the call looked (the call already answered): asked as any other block.
    const late = callNotices.get(callId)
    callNotices.delete(callId)
    if (late !== undefined) void offerTrust($, late)
  }
}

type HostAnswer = { deny: string } | { result: Rec }

/** One `tools.call` on the running host. */
async function callHost($: Engine, entry: ToolEntry, args: Rec, callId: string, signal: AbortSignal): Promise<HostAnswer> {
  const label = `${CFG.displayName}: ${entry.dshName}`
  let h: Host
  try {
    h = await usableHost($, HOOK_READY_WAIT_MS)
  } catch (err) {
    return { deny: `${label} cannot run: ${errText(err)}` }
  }
  try {
    const result = await rpc(
      $,
      h,
      'tools.call',
      { name: entry.dshName, args, callId },
      { timeoutMs: CFG.callTimeoutMs + HOST_TIMEOUT_GRACE_MS, signal, isBusy: () => reverseInFlight > 0 },
    )
    return { result: isRec(result) ? result : {} }
  } catch (err) {
    // Tell the child to stop working on it (cancellation, timeout or a lost answer).
    void rpc($, h, 'tools.cancel', { callId }, { timeoutMs: 5000 }).catch(() => {})
    const reason = h.phase === 'ready' ? errText(err) : (h.error ?? errText(err))
    return { deny: `${label} failed: ${reason}` }
  }
}

/**
 * The block of this call that the trust lifts, as its first line: from the answer's `blocked` (the worker keeps the
 * blocks of each call), else from a notice the call raised; undefined when there is none.
 */
function directExecBlock(answer: HostAnswer, callId: string): string | undefined {
  const notice = callNotices.get(callId)
  callNotices.delete(callId)
  if ('result' in answer && Array.isArray(answer.result.blocked)) {
    const hit = answer.result.blocked.find(b => isRec(b) && DIRECT_EXEC_KINDS.has(str(b.kind)))
    if (isRec(hit)) return str(hit.what, notice ?? '')
  }
  return notice
}

// ---------------------------------------------------------------------------
// Outbound tools (SECURITY-PLAN.md 第 4 項, 約定 2)
// ---------------------------------------------------------------------------

type OutboundSend = { target: string; text: string; makeAuto: boolean; isCounted: boolean }

function findOutbound(entry: ToolEntry): OutboundTool | undefined {
  return CFG.outboundTools.find(
    o =>
      (o.name !== '' && (o.name === entry.shortName || o.name === entry.fullName)) ||
      (o.dshName !== '' && o.dshName === entry.dshName),
  )
}

const fieldText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v))

/** The destination and the full text of a send, from the fields the converter named; all arguments when none is there. */
function describeSend(o: OutboundTool, args: Rec): { target: string; text: string; all: string } {
  const target = o.targetFields
    .filter(f => args[f] !== undefined)
    .map(f => `${f}=${fieldText(args[f])}`)
    .join('、')
  const text = o.textFields
    .filter(f => args[f] !== undefined)
    .map(f => fieldText(args[f]))
    .join('\n')
  return { target, text, all: JSON.stringify(args, null, 2) }
}

function currentOutboundMode(): OutboundMode {
  return sessionAutoOutbound && optionOutboundMode === 'ask' ? 'auto' : optionOutboundMode
}

async function gateOutbound($: Engine, o: OutboundTool, entry: ToolEntry, args: Rec, signal?: AbortSignal): Promise<{ deny: string } | OutboundSend> {
  const { target, text, all } = describeSend(o, args)
  const doing = o.summary !== '' ? o.summary : '對外發文'
  const where = target !== '' ? `（目的地：${target}）` : ''
  const mode = currentOutboundMode()
  if (mode === 'deny') {
    const msg = blocked(
      `${CFG.displayName} 想${doing}${where}（工具 ${entry.dshName}）`,
      '這個插件的對外發文模式設為「不准發」，所以沒有送出。',
      '到插件選項把 outboundMode 改成 ask（每次確認）或 auto（自動發）。',
      `「${doing}」這個功能無法使用。`,
      'OUTBOUND_DENIED',
    )
    toast($, msg)
    return { deny: msg }
  }
  if (mode === 'auto') {
    // Counted before the check, so two calls at once cannot both take the last place.
    outboundInFlight += 1
    const limit = await checkLimits($)
    if (limit !== undefined) {
      outboundInFlight -= 1
      const msg = blocked(
        `${CFG.displayName} ${limit.what}，暫停發文${where}（工具 ${entry.dshName}）`,
        '自動發文有數量上限，避免大量發文被平台當成垃圾訊息。',
        `到插件選項調整 ${limit.option}（0 表示不限），或等一段時間再試。`,
        `這則「${doing}」沒有送出。`,
        limit.code,
      )
      toast($, msg)
      return { deny: msg }
    }
    return { target, text, makeAuto: false, isCounted: true }
  }
  // ask
  const body = target === '' && text === '' ? `全部參數：\n${clip(all, 3000)}` : `${target !== '' ? `目的地：${target}\n` : ''}${text !== '' ? `全文：\n${clip(text, 3000)}` : `全部參數：\n${clip(all, 3000)}`}`
  const rejected = (): { deny: string } => {
    const msg = blocked(
      `使用者拒絕了 ${CFG.displayName} 的這則「${doing}」${where}，沒有送出`,
      '對外發文需要使用者確認，這次沒有同意。',
      '如果要送出，請再要求一次並在確認視窗選「這次送出」；或到插件選項把 outboundMode 改成 auto。',
      `這則「${doing}」沒有送出。`,
      'OUTBOUND_REJECTED',
    )
    toast($, `${CFG.displayName}：這則「${doing}」沒有送出（使用者沒有同意）。`)
    return { deny: msg }
  }
  let answer: string
  try {
    answer = await askUser($, `${CFG.displayName} 想${doing}（工具 ${entry.dshName}）。\n${body}\n\n要送出嗎？`, {
      options: [SEND_ONCE, SEND_ALWAYS, SEND_NO],
      header: '對外發文',
    }, signal)
  } catch {
    return rejected()
  }
  if (answer === SEND_ONCE) return { target, text, makeAuto: false, isCounted: false }
  if (answer !== SEND_ALWAYS) return rejected()
  // Said once, in the dialog, before anything turns automatic.
  let confirm: string
  try {
    confirm = await askUser(
      $,
      `提醒：平台可能把大量自動發文視為垃圾訊息而限制帳號。改成自動發以後，${CFG.displayName} 發文不再先問你（仍有每小時 ${limitText(optionHourlyLimit)}、每天 ${limitText(optionDailyLimit)} 的上限，發出後會通知並記錄）。確定以後都自動發？`,
      { options: [SEND_ALWAYS_CONFIRM, SEND_ONLY_THIS, SEND_NO], header: '自動發文' },
      signal,
    )
  } catch {
    return rejected()
  }
  if (confirm === SEND_ALWAYS_CONFIRM) return { target, text, makeAuto: true, isCounted: false }
  if (confirm === SEND_ONLY_THIS) return { target, text, makeAuto: false, isCounted: false }
  return rejected()
}

const limitText = (n: number): string => (n > 0 ? `${n} 則` : '不限')

async function checkLimits($: Engine): Promise<{ what: string; option: string; code: string } | undefined> {
  const now = await nowMs($)
  const log = await readOutboundLog($)
  // `outboundInFlight` includes the call being checked: the others under way are counted as sent.
  const hour = log.filter(r => now - r.at < HOUR_MS).length + outboundInFlight - 1
  const day = log.filter(r => now - r.at < DAY_MS).length + outboundInFlight - 1
  if (optionHourlyLimit > 0 && hour >= optionHourlyLimit) {
    return { what: `這一小時已發 ${hour} 則，達到每小時上限 ${optionHourlyLimit} 則`, option: 'outboundHourlyLimit', code: 'OUTBOUND_HOURLY_LIMIT' }
  }
  if (optionDailyLimit > 0 && day >= optionDailyLimit) {
    return { what: `這 24 小時已發 ${day} 則，達到每天上限 ${optionDailyLimit} 則`, option: 'outboundDailyLimit', code: 'OUTBOUND_DAILY_LIMIT' }
  }
  return undefined
}

function cleanLog(raw: unknown): OutboundRecord[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isRec)
    .filter(r => typeof r.at === 'number')
    .map(r => ({ at: r.at as number, tool: str(r.tool), target: str(r.target), preview: str(r.preview) }))
}

async function readOutboundLog($: Engine): Promise<OutboundRecord[]> {
  try {
    outboundMemory = cleanLog(await $.store.get(OUTBOUND_LOG_KEY))
    storeError = undefined
  } catch (e) {
    storeError = errText(e)
  }
  return outboundMemory
}

/** Appends one record (read, append, write, one at a time), keeping the last 24 hours and at least 20 records. */
function logSend($: Engine, record: OutboundRecord): Promise<unknown> {
  outboundChain = outboundChain.then(async () => {
    const log = [...(await readOutboundLog($)), record]
    const recent = log.filter(r => record.at - r.at < DAY_MS).length
    const kept = log.slice(-Math.min(OUTBOUND_LOG_MAX, Math.max(20, recent)))
    outboundMemory = kept
    try {
      await $.store.set(OUTBOUND_LOG_KEY, kept)
      storeError = undefined
    } catch (e) {
      storeError = errText(e)
    }
  })
  outboundChain.catch(() => {})
  return outboundChain
}

async function afterSend($: Engine, send: OutboundSend, entry: ToolEntry): Promise<void> {
  const target = send.target !== '' ? send.target : '（未標示目的地）'
  const preview = mask(head(send.text, 60))
  await logSend($, { at: await nowMs($), tool: entry.dshName, target: mask(target), preview })
  toast($, `已發出：${target}：${preview === '' ? '（沒有文字內容）' : preview}`)
  if (send.makeAuto) {
    sessionAutoOutbound = true
    // Changing the option reloads the module; done after this call has answered, not in the middle of it.
    $.clock.after(0, () => {
      void persistAutoMode($)
    })
  }
}

/** "以後都自動發": change the plugin option itself (persistent); failing that, this session only, and say so. */
async function persistAutoMode($: Engine): Promise<void> {
  let reason: string
  try {
    const rows = await $.config.list()
    const own = `${CFG.pluginName}.outboundMode`
    const row =
      rows.find(r => r.key === own || r.key === `${CFG.pluginName}@inline.outboundMode`) ??
      rows.find(r => r.key.endsWith('.outboundMode') && r.provider.plugin.startsWith(CFG.pluginName))
    const done = await $.config.set({ key: row?.key ?? own, value: 'auto' })
    if (done.deny === undefined) {
      outboundPersistNote = undefined
      toast($, `${CFG.displayName}：已把插件選項 outboundMode 改成 auto，以後發文不再先問（每小時 ${limitText(optionHourlyLimit)}、每天 ${limitText(optionDailyLimit)} 的上限仍有效）。`)
      return
    }
    reason = done.deny
  } catch (e) {
    reason = errText(e)
  }
  outboundPersistNote = `只在這次 Claude Code 工作階段有效（無法自動修改插件選項：${reason}）`
  toast(
    $,
    `${CFG.displayName}：這次工作階段內以後都自動發文。要永久生效，請到插件選項把 outboundMode 改成 auto（自動修改沒有成功：${clip(reason, 200)}）。`,
  )
}

// ---------------------------------------------------------------------------
// Interception (DSH hooks around other tools)
// ---------------------------------------------------------------------------

/** Interception runs only when the person turned on `allowInterception` and the host has guards to run. */
function interceptionOn(): boolean {
  if (!optionAllowInterception) return false
  const known = host?.info?.interception
  return known !== undefined ? known : CFG.features.interception
}

/** Whether the plugin has guards over Claude's tools at all (whatever the option says). */
function pluginHasInterceptors(): boolean {
  const info = host?.info
  if (info?.interception === true || CFG.features.interception) return true
  const meta = isRec(info?.metadata) ? info.metadata : {}
  const listeners = isRec(meta.listeners) ? meta.listeners : {}
  const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return count(listeners.preExecute) + count(listeners.postExecute) > 0
}

/** How many listeners of a DSH event the plugin has (the host counts them at start). */
function listenerCount(name: 'sessionEvent' | 'agentCreated'): number {
  const meta = isRec(host?.info?.metadata) ? host.info.metadata : {}
  const listeners = isRec(meta.listeners) ? meta.listeners : {}
  const v = listeners[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** The plugin follows the chat (`ctx.on('session/event')`) and the person lets it. */
function followsChat(): boolean {
  return optionShareConversation && host?.phase === 'ready' && listenerCount('sessionEvent') > 0
}

const CONVERSATION_HOW = '不想讓插件知道，到插件選項關閉 shareConversation'

/** Once per load: the plugin gets what happens in this conversation. */
function noticeConversation($: Engine): void {
  if (conversationNoticeShown || !followsChat()) return
  conversationNoticeShown = true
  toast($, `${CFG.displayName} 會收到這個對話裡發生的事（你的訊息、Claude 的回答、工具呼叫和結果），這是它原本在 DSH 就有的功能。${CONVERSATION_HOW}`)
}

/** One thing that happened in the conversation, for the plugin (lib/modules/claude/conversation.mjs). Never holds up the turn. */
function tellHost($: Engine, params: Rec): void {
  const h = host
  if (h === undefined || !followsChat()) return
  conversationChain = conversationChain
    .then(() => rpc($, h, 'session.event', { ...(sessionId !== '' ? { sessionId } : {}), ...params }, { timeoutMs: 5000 }))
    .catch(e => debug($, `could not tell the plugin about the conversation: ${errText(e)}`))
}

/** A tool's answer as text for the plugin, with every known key value masked. */
function toolResultText(r: unknown): { text: string; isError: boolean } {
  if (!isRec(r)) return { text: '', isError: false }
  if (typeof r.deny === 'string') return { text: mask(r.deny), isError: true }
  let text = typeof r.text === 'string' ? r.text : textOfBlocks(r.result)
  if (text === '' && r.result !== undefined) {
    try {
      text = typeof r.result === 'string' ? r.result : (JSON.stringify(r.result) ?? '')
    } catch {
      text = ''
    }
  }
  return { text: mask(clip(text, 20000)), isError: r.isError === true }
}

const INTERCEPTION_OFF = '這個插件有監督 Claude 工具使用的功能，目前關閉'
const INTERCEPTION_HOW = '到插件選項開啟 allowInterception（開啟後插件只能擋下 Claude 的工具呼叫，不能改寫內容）'

/** Once per load, at the session's start: a plugin with guards whose option is off. Never per tool call. */
function noticeInterceptionOff($: Engine): void {
  if (interceptionNoticeShown || optionAllowInterception || !pluginHasInterceptors()) return
  interceptionNoticeShown = true
  toast($, `${CFG.displayName}：${INTERCEPTION_OFF}。${INTERCEPTION_HOW}。`)
}

async function intercept(
  $: Engine,
  e: Rec,
  next: (e: never) => Promise<unknown>,
): Promise<unknown> {
  const tool = str(e.tool)
  if (tool === 'AskUserQuestion' && asksInFlight > 0) return next(e as never) // our own dialog
  if (!interceptionOn()) return next(e as never)
  const h = await usableHost($, HOOK_READY_WAIT_MS)
  const pre = await rpc($, h, 'interception.pre', { tool, input: toolArgs(e) }, { timeoutMs: CFG.callTimeoutMs, isBusy: () => reverseInFlight > 0 })
  const verdict = isRec(pre) ? pre : {}
  if (verdict.decision === 'deny') {
    return { deny: mask(str(verdict.reason).trim() || `${CFG.displayName} denied this ${tool} call`) }
  }
  if (verdict.decision !== undefined && verdict.decision !== 'allow') {
    throw new Error(`interception.pre answered an unknown decision "${String(verdict.decision)}"`)
  }
  // A guard may only stop a call (SECURITY-PLAN.md 第 5 項): a rewritten input from the host is ignored.
  if (verdict.input !== undefined) debug($, `interception.pre for ${tool} sent a rewritten input; ignored (guards may only deny)`)
  const call: Rec = e
  const ran = (await next(call as never)) as Rec
  if (ran.deny !== undefined) return ran
  const text = typeof ran.text === 'string' ? ran.text : JSON.stringify(ran.result ?? null)
  const post = await rpc(
    $,
    h,
    'interception.post',
    { tool, input: toolArgs(call), result: clip(text ?? '', 200000) },
    { timeoutMs: CFG.callTimeoutMs, isBusy: () => reverseInFlight > 0 },
  )
  const changed = isRec(post) ? post.result : undefined
  if (changed === undefined || changed === null) return ran
  // The child host answers { result: { content: [{ type: 'text', text }], isError } }.
  const note =
    typeof changed === 'string'
      ? changed
      : isRec(changed) && typeof changed.text === 'string'
        ? changed.text
        : isRec(changed) && Array.isArray(changed.content)
          ? textOfBlocks(changed.content)
          : JSON.stringify(changed)
  // A tool's own record cannot be rewritten safely, so the hook's replacement is added as a note
  // the model reads after the result.
  const context = Array.isArray(ran.context) ? (ran.context as unknown[]) : []
  return { ...ran, context: [...context, mask(`${CFG.displayName} (after ${tool}): ${clip(note, 20000)}`)] }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function syncCommands($: Engine, commands: readonly DshCommand[]): Promise<void> {
  for (const c of commands) {
    const wanted = cleanName(c.name.replace(/^\//, ''), 'command')
    if ([...commandsBySlash.entries()].some(([slash, dsh]) => dsh === c.name && slash !== '')) continue
    const candidates = [wanted, cleanName(`${CFG.pluginName}-${wanted}`, 'command')]
    for (const slash of candidates) {
      if (slash === UI_NAME || slash === STATUS_NAME || slash === RESTART_NAME || slash === TRUST_NAME) continue
      try {
        await $.command.register({ name: slash, description: clip(c.description === '' ? c.name : c.description, 200), argumentHint: '[arguments]' })
        commandsBySlash.set(slash, c.name)
        break
      } catch (e) {
        debug($, `command "${slash}" was refused (${errText(e)})`)
      }
    }
  }
}

async function statusText($: Engine): Promise<string> {
  const h = host
  const lines: string[] = [`${CFG.displayName} (${CFG.pluginName})`]
  if (h === undefined) {
    lines.push('host: never started in this session')
  } else {
    lines.push(`host: ${h.phase}${h.port !== undefined ? ` on 127.0.0.1:${h.port}` : ''}, started ${Math.round((Date.now() - h.startedAt) / 1000)} s ago`)
    if (h.phase === 'ready') {
      try {
        const s = await rpc($, h, 'status', {}, { timeoutMs: 5000 })
        if (isRec(s)) {
          lines.push(`state: ${str(s.state, 'unknown')}`)
          for (const k of ['plugin', 'tools', 'services', 'unsupported']) {
            if (s[k] !== undefined) lines.push(`${k}: ${clip(typeof s[k] === 'string' ? (s[k] as string) : JSON.stringify(s[k]), 1500)}`)
          }
        }
      } catch (e) {
        lines.push(`status request failed: ${errText(e)}`)
      }
    }
  }
  lines.push(`tools registered: ${[...toolsByShort.values()].filter(t => t.isActive && t.fullName !== undefined).length}`)
  lines.push(`commands registered: ${commandsBySlash.size}`)
  lines.push(`system prompt text: ${promptText === '' ? 'none' : `${promptText.length} characters`}`)
  lines.push(`interception: ${interceptionOn() ? 'on' : 'off'}`)
  lines.push(`programs started by the plugin itself: ${optionAllowDirectExec ? 'allowed (allowDirectExec)' : trustedExec ? `allowed (trusted; /${TRUST_NAME} to withdraw)` : `blocked (/${TRUST_NAME} to trust the plugin)`}`)
  lines.push(`model calls from the plugin: ${optionAllowModel ? 'allowed' : 'blocked (allowModelCalls)'}; subagents: ${optionAllowAgents ? 'allowed' : 'blocked (allowAgents)'}`)
  lines.push(`conversation shared with the plugin: ${followsChat() ? 'yes' : listenerCount('sessionEvent') > 0 ? 'no (shareConversation)' : 'no (the plugin does not follow the chat)'}; messages of its own: ${optionAllowFollowups ? 'allowed' : 'blocked (allowFollowups)'}`)
  const err = h?.error ?? lastError
  lines.push(err === undefined ? 'last error: none' : `last error: ${clip(err, 2000)}`)
  lines.push('', '目前受限的功能：')
  const limits = restrictions()
  if (limits.length === 0) lines.push('  （沒有）')
  for (const r of limits) lines.push(`  - ${r.what}\n    原因：${r.why}\n    怎麼放行：${r.how}`)
  if (CFG.outboundTools.length > 0) {
    const mode = currentOutboundMode()
    const modeText = { ask: '每次確認（ask）', auto: '自動發（auto）', deny: '不准發（deny）' }[mode]
    lines.push('', `對外發文：${modeText}${sessionAutoOutbound && outboundPersistNote !== undefined ? `，${outboundPersistNote}` : ''}；上限每小時 ${limitText(optionHourlyLimit)}、每天 ${limitText(optionDailyLimit)}`)
    const log = await readOutboundLog($)
    const now = await nowMs($)
    lines.push(`  最近 1 小時已發 ${log.filter(r => now - r.at < HOUR_MS).length} 則，最近 24 小時 ${log.filter(r => now - r.at < DAY_MS).length} 則`)
    if (storeError !== undefined) lines.push(`  （發文紀錄無法存進 Claude Code 的插件儲存區，只記在這次工作階段：${clip(storeError, 200)}）`)
    const recent = log.slice(-5).reverse()
    lines.push(recent.length === 0 ? '  最近的發文紀錄：（沒有）' : '  最近的發文紀錄：')
    for (const r of recent) lines.push(`    ${new Date(r.at).toISOString()}  ${r.tool}  ${r.target}：${r.preview}`)
  }
  if (recentNotices.length > 0) {
    lines.push('', '最近的通知：')
    for (const n of recentNotices.slice(-5)) lines.push(`  - ${clip(n.replace(/\n/g, ' / '), 300)}`)
  }
  return mask(lines.join('\n'))
}

/** Each thing the plugin cannot do now, why, and how the person lets it (SECURITY-PLAN.md 阻礙通知). */
function restrictions(): { what: string; why: string; how: string }[] {
  const out: { what: string; why: string; how: string }[] = []
  if (!optionAllowModel) out.push({ what: '插件呼叫模型', why: '插件選項 allowModelCalls 關閉', how: '到插件選項開啟 allowModelCalls' })
  if (!optionAllowAgents) out.push({ what: '插件開子代理', why: '插件選項 allowAgents 關閉', how: '到插件選項開啟 allowAgents' })
  if (!optionAllowInterception && pluginHasInterceptors()) {
    out.push({ what: INTERCEPTION_OFF, why: '插件選項 allowInterception 預設關閉', how: INTERCEPTION_HOW })
  }
  if (CFG.outboundTools.length > 0) {
    const mode = currentOutboundMode()
    const names = CFG.outboundTools.map(o => o.summary || o.dshName || o.name).join('、')
    if (mode === 'deny') out.push({ what: `對外發文（${names}）`, why: '插件選項 outboundMode 設為 deny（不准發）', how: '到插件選項把 outboundMode 改成 ask 或 auto' })
    if (mode === 'ask') out.push({ what: `對外發文（${names}）每次都要確認`, why: '插件選項 outboundMode 設為 ask（預設）', how: '在確認視窗選「以後都自動發」，或到插件選項把 outboundMode 改成 auto' })
  }
  if (!optionShareConversation && host?.info !== undefined && listenerCount('sessionEvent') > 0) {
    out.push({ what: '插件知道對話裡發生的事', why: '插件選項 shareConversation 關閉', how: '到插件選項開啟 shareConversation' })
  }
  if (!optionAllowFollowups && host?.info !== undefined && listenerCount('agentCreated') > 0) {
    out.push({ what: '插件自己送出訊息（主動說話）', why: '插件選項 allowFollowups 預設關閉', how: '到插件選項開啟 allowFollowups' })
  }
  if (!directExecAllowed()) {
    out.push({ what: '插件自己直接開程式', why: '安全限制：插件自己開的程式不經過 Claude Code 的權限檢查，也不受讀寫範圍限制', how: `被擋下時在詢問視窗選「完全信任這個插件」，或執行 /${TRUST_NAME}（插件選項 allowDirectExec 效果相同）` })
  }
  if (optionExtraFolders.trim() === '') {
    out.push({ what: '讀寫插件資料夾、狀態資料夾、工作資料夾以外的檔案', why: '安全限制：插件只能讀寫這些資料夾', how: '到插件選項的 extraFolders 加上資料夾（以 ; 分隔的絕對路徑）' })
  }
  for (const s of CFG.secretOptions) {
    if (secretValues.has(s.env)) continue
    out.push({
      what: `${s.features !== '' ? s.features : '需要金鑰的功能'}（缺少「${s.title}」）`,
      why: `插件選項 ${s.option} 沒有填`,
      how: `到插件選項填入 ${s.option}`,
    })
  }
  return out
}

async function restartText($: Engine): Promise<string> {
  const old = host
  if (old !== undefined) await stopHost($, old, DISPOSE_WAIT_MS)
  const h = startHost($)
  await settleWithin($, h.setup.promise, SLASH_WAIT_MS)
  if (h.phase === 'ready') return `${CFG.displayName}: restarted, the plugin host is ready.`
  if (h.phase === 'starting') return `${CFG.displayName}: restarting; the plugin host is not ready yet (run /${STATUS_NAME}).`
  return `${CFG.displayName}: restart failed: ${h.error ?? 'unknown error'}`
}

// ---------------------------------------------------------------------------
// Trust: the person lets this one plugin start programs by itself
// ---------------------------------------------------------------------------

async function readTrust($: Engine): Promise<boolean> {
  try {
    return (await $.store.get(TRUST_KEY)) === true
  } catch (e) {
    debug($, `could not read the trust from the store: ${errText(e)}`)
    return false
  }
}

/** Saves the choice, then restarts the host so the worker starts with (or without) the permission. */
async function setTrust($: Engine, on: boolean): Promise<string> {
  trustedExec = on
  let note = ''
  try {
    await $.store.set(TRUST_KEY, on)
  } catch (e) {
    note = `（Claude Code 的插件儲存區無法使用，只在這次工作階段有效：${clip(errText(e), 200)}）`
  }
  const restarted = await restartText($)
  return on
    ? `${CFG.displayName}：已完全信任，這個插件以後開任何程式、讀寫任何檔案都不會再問你${note}。${restarted}`
    : `${CFG.displayName}：已取消信任，這個插件自己開程式會被擋下，也回到只能讀寫限定的資料夾${note}。${restarted}`
}

/** `rerun`: asked by a blocked tool call, which runs again once the plugin is trusted. */
function trustQuestion(notice: string, rerun = false): string {
  return [
    ...(notice !== '' ? [`${CFG.displayName} 想自己開程式，被安全限制擋下了：`, clip(notice, 300), ''] : [`要完全信任 ${CFG.displayName} 嗎？`, '']),
    '完全信任後，這個插件可以開任何程式、讀寫任何檔案，都不會再問你；它開的程式不經過 Claude Code 的權限檢查。',
    '只對這個插件有效，插件會自動重新啟動。',
    ...(rerun ? ['選完全信任後，會自動再執行一次剛才被擋下的功能（它在被擋下之前做過的步驟也會再做一次）。'] : []),
    `之後要取消，執行 /${TRUST_NAME}。`,
  ].join('\n')
}

/** Puts the trust question (marking it asked for this load); resolves whether the person trusted (the host then restarted). */
function askTrust($: Engine, notice: string, rerun: boolean): Promise<boolean> {
  trustAsked = true
  const asking = (async (): Promise<boolean> => {
    let answer: string
    try {
      answer = await askUser($, trustQuestion(notice, rerun), { options: [TRUST_YES, TRUST_NO], header: '插件開程式' })
    } catch (e) {
      debug($, `the trust question could not be asked: ${errText(e)}`)
      return false
    }
    if (answer !== TRUST_YES) {
      toast($, `${CFG.displayName}：沒有信任，插件自己開程式會繼續被擋下。之後要完全信任，執行 /${TRUST_NAME}。`)
      return false
    }
    try {
      toast($, await setTrust($, true))
    } catch (e) {
      debug($, `trusting the plugin failed: ${errText(e)}`)
      return false
    }
    return true
  })()
  trustPending = asking
  void asking.then(() => {
    if (trustPending === asking) trustPending = undefined
  })
  return asking
}

/** Asked once per load, when a block that the trust lifts reaches the person outside a tool call. */
async function offerTrust($: Engine, notice: string): Promise<void> {
  if (directExecAllowed() || trustAsked) return
  await askTrust($, notice, false)
}

/** A tool call hit a block the trust lifts: whether to run it again. Joins a question already up; asks once per load. */
async function trustForCall($: Engine, notice: string): Promise<boolean> {
  if (trustPending !== undefined) return trustPending
  if (directExecAllowed()) return true // trusted while the call ran on the host without the permission
  if (trustAsked) return false
  return askTrust($, notice, true)
}

/** `/<plugin>-trust`: trust the plugin, or withdraw the trust. */
async function trustText($: Engine): Promise<string> {
  if (optionAllowDirectExec) return `${CFG.displayName}：插件選項 allowDirectExec 已開啟，插件開程式本來就不問；要擋下請到插件選項關閉它。`
  trustAsked = true
  if (trustedExec) {
    const answer = await askUser($, `${CFG.displayName} 目前是完全信任的：可以開任何程式、讀寫任何檔案。\n取消信任後，它自己開程式會被擋下，插件會重新啟動。`, { options: [UNTRUST_YES, UNTRUST_NO], header: '插件開程式' })
    return answer === UNTRUST_YES ? setTrust($, false) : `${CFG.displayName}：維持信任。`
  }
  const answer = await askUser($, trustQuestion(''), { options: [TRUST_YES, TRUST_NO], header: '插件開程式' })
  return answer === TRUST_YES ? setTrust($, true) : `${CFG.displayName}：沒有信任，插件自己開程式會繼續被擋下。`
}

// ---------------------------------------------------------------------------
// Requests from the child (child -> module)
// ---------------------------------------------------------------------------

function describeApproval(p: Rec): string {
  // The child host (lib/modules/claude/approval.mjs) sends { toolName, callId, reason, argumentSummary };
  // the older names (question, message, tool, input) stay accepted.
  const lead = str(p.question) || str(p.message) || str(p.description) || str(p.title) || str(p.reason)
  const what = str(p.tool) || str(p.toolName) || str(p.action)
  const detail = p.input ?? p.args ?? p.params ?? p.detail ?? p.argumentSummary
  let text = lead !== '' ? lead : `${CFG.displayName} asks for permission`
  if (what !== '' && !text.includes(what)) text += ` (${what})`
  if (detail !== undefined) text += `: ${clip(typeof detail === 'string' ? detail : JSON.stringify(detail), 400)}`
  text = clip(text, 700)
  return text.endsWith('?') ? text : `${text}. Allow it?`
}

async function handleApproval($: Engine, p: Rec): Promise<unknown> {
  try {
    const answer = await askUser($, describeApproval(p), { options: [APPROVE, DENY], header: 'Approval' })
    return answer === APPROVE ? { approved: true } : { approved: false, reason: 'the person did not approve' }
  } catch (e) {
    // dismissed, or nobody to ask (-p): that is a no
    return { approved: false, reason: `no approval was given (${errText(e)})` }
  }
}

/**
 * `exec.check` (SECURITY-PLAN.md 約定 4): the shell/subprocess modules ask before running a command, and the
 * answer is Claude Code's own permission decision for the same command run by Bash (`$.tool.check`): the
 * session's mode and allow/deny rules apply. `$.tool.check` opens no dialog, so its `ask` is put to the person
 * here, with the command and the folder shown (keys masked).
 */
async function handleExecCheck($: Engine, p: Rec): Promise<unknown> {
  const command = str(p.command)
  if (command.trim() === '') throw new RpcError('BAD_REQUEST', 'exec.check needs a command')
  const cwd = str(p.cwd)
  const why = str(p.why)
  let verdict: { decision: string; reason?: string; rule?: string }
  try {
    verdict = await $.tool.check({ tool: 'Bash', input: { command } })
  } catch (e) {
    return { decision: 'deny', reason: `Claude Code 的權限檢查無法執行（${errText(e)}），所以不執行` }
  }
  if (verdict.decision === 'allow') return { decision: 'allow' }
  if (verdict.decision === 'deny') {
    const reason = str(verdict.reason) || 'Claude Code 的權限設定不允許這個指令'
    return { decision: 'deny', reason: mask(verdict.rule !== undefined ? `${reason}（規則 ${verdict.rule}）` : reason) }
  }
  const question = [
    `${CFG.displayName} 想在這台電腦執行指令${why !== '' ? `（${why}）` : ''}：`,
    clip(command, 2000),
    ...(cwd !== '' ? [`工作目錄：${cwd}`] : []),
    ...(str(verdict.reason) !== '' ? [`Claude Code 要確認的原因：${str(verdict.reason)}`] : []),
    '要允許執行嗎？',
  ].join('\n')
  try {
    const answer = await askUser($, question, { options: [EXEC_ALLOW, EXEC_DENY], header: '執行指令' })
    return answer === EXEC_ALLOW ? { decision: 'allow' } : { decision: 'deny', reason: '使用者沒有允許執行這個指令' }
  } catch (e) {
    return { decision: 'deny', reason: `沒有人確認這個指令，所以不執行（${errText(e)}）` }
  }
}

async function handleModel($: Engine, p: Rec): Promise<unknown> {
  const prompt = str(p.prompt)
  if (prompt.trim() === '') throw new RpcError('BAD_REQUEST', 'model.complete needs a non-empty prompt')
  toast($, `${CFG.displayName} 正在呼叫模型：${head(prompt, 60)}（可在插件選項關閉 allowModelCalls）`)
  // A DSH model id means nothing to Claude: only a Claude alias or id is honoured, else the session's own model.
  const asked = str(p.model)
  const model = /^(haiku|sonnet|opus|fable|claude-[\w.-]+)$/.test(asked) ? asked : await $.session.model()
  const system = str(p.system)
  const r = await $.model.complete({
    model,
    prompt: mask(prompt),
    ...(system !== '' ? { system: mask(system) } : {}),
    ...(typeof p.maxTokens === 'number' && p.maxTokens > 0 ? { maxTokens: Math.floor(p.maxTokens) } : {}),
    timeoutMs: CFG.callTimeoutMs * 4,
  })
  if (r.isAnswered) return { text: r.text, usage: r.usage, model }
  throw new RpcError('MODEL_FAILED', `the model call failed: ${r.reason}${r.reason === 'api-error' ? ` (HTTP ${String(r.status)}, ${r.error})` : ''}`)
}

async function handleAgent($: Engine, p: Rec): Promise<unknown> {
  const prompt = str(p.prompt)
  if (prompt.trim() === '') throw new RpcError('BAD_REQUEST', 'agent.spawn needs a non-empty prompt')
  const subagentType = str(p.subagentType)
  toast($, `${CFG.displayName} 開了一個子代理：${head(str(p.description) || firstLine(prompt), 80)}（可在插件選項關閉 allowAgents）`)
  agentRequests += 1
  try {
    const spawned = await $.agent.spawn({
      prompt: mask(prompt),
      description: mask(clip(str(p.description) || `${CFG.displayName} task`, 100)),
      ...(subagentType !== '' ? { subagentType } : {}),
    })
    if (spawned.deny !== undefined) throw new RpcError('AGENT_REFUSED', `the subagent was not started: ${spawned.deny}`)
    const agentId = spawned.agentId
    if (agentId === undefined) return { started: true } // no local loop to wait for
    const early = agentAnswers.get(agentId)
    if (early !== undefined) {
      agentAnswers.delete(agentId)
      return { agentId, text: early }
    }
    // The subagent's answer is its `turn.complete` (hook below), matched by agent id.
    const answer = await new Promise<string>(resolve => agentWaiters.set(agentId, resolve))
    return { agentId, text: answer }
  } finally {
    agentRequests -= 1
  }
}

async function handleAsk($: Engine, p: Rec): Promise<unknown> {
  // userQuestions of the child host: one question per request, shown in the engine's own question dialog.
  const question = str(p.question)
  if (question.trim() === '') throw new RpcError('BAD_REQUEST', 'ui.ask needs a question')
  const options = Array.isArray(p.options) ? p.options.filter((o): o is string => typeof o === 'string' && o !== '').slice(0, 4) : []
  const header = str(p.header).slice(0, 12)
  asksInFlight += 1
  try {
    const answer = await $.ui.ask(mask(clip(question, 2000)), {
      ...(options.length > 0 ? { options: options.map(mask) } : {}),
      ...(header !== '' ? { header } : {}),
      ...(p.multiSelect === true ? { multiSelect: true as const } : {}),
    })
    return { answer }
  } catch (e) {
    // dismissed, or nobody to ask (-p): the child turns this into an explicit error for the plugin
    throw new RpcError('USER_DISMISSED', `the question was not answered (${errText(e)})`)
  } finally {
    asksInFlight -= 1
  }
}

function handleNotify($: Engine, p: Rec): unknown {
  const raw = str(p.text) || str(p.message)
  if (raw === '') throw new RpcError('BAD_REQUEST', 'ui.notify needs text')
  const level = str(p.level)
  // Always a toast (SECURITY-PLAN.md 約定 5), masked, and remembered for the status command.
  toast($, `${level === 'error' || level === 'warn' || level === 'warning' ? `[${level}] ` : ''}${raw}`)
  // A block the trust lifts: ask once whether to trust the plugin (not awaited, the host is answered at once).
  if (isRec(p.blocked) && DIRECT_EXEC_KINDS.has(str(p.blocked.kind))) {
    const notice = firstLine(raw).replace(/^\[被擋下\]\s*/, '')
    const callId = str(p.blocked.callId)
    // Raised inside a tool call still under way: that call asks, and runs again once trusted (one question per block).
    if (callId !== '' && callsInFlight.has(callId)) {
      if (!callNotices.has(callId)) callNotices.set(callId, notice)
    } else {
      void offerTrust($, notice)
    }
  }
  return { shown: true }
}

/** `agent.followup` of the plugin: a message of its own turn, sent once Claude Code is idle. */
async function handleFollowup($: Engine, p: Rec): Promise<unknown> {
  const text = str(p.text).trim()
  if (text === '') throw new RpcError('BAD_REQUEST', 'prompt.submit needs text')
  await $.prompt.submit({ text: mask(text) })
  // The plugin hears its own message with the source it gave it; the prompt.submit hook leaves this module's messages alone.
  tellHost($, { kind: 'user', text: mask(clip(text, 20000)), source: isRec(p.source) ? p.source : { kind: 'plugin' } })
  return { queued: true }
}

async function answerRequest($: Engine, h: Host, msg: Rec): Promise<void> {
  const id = msg.id
  const method = str(msg.method)
  const params = isRec(msg.params) ? msg.params : {}
  const controller = new AbortController()
  let controllers = reverseControllers.get(h)
  if (controllers === undefined) { controllers = new Map(); reverseControllers.set(h, controllers) }
  controllers.set(str(id), controller)
  let reply: Rec
  reverseInFlight += 1
  try {
    let result: unknown
    switch (method) {
      case 'approval.request':
        result = await handleApproval($, params)
        break
      case 'model.complete':
        if (!optionAllowModel) {
          const msg = blocked(
            `${CFG.displayName} 想呼叫模型：「${head(str(params.prompt), 60)}」`,
            '插件選項關閉了插件呼叫模型（allowModelCalls）。',
            '到插件選項開啟 allowModelCalls。',
            '插件中需要呼叫模型的功能無法使用。',
            'DISABLED',
          )
          toast($, msg)
          throw new RpcError('DISABLED', mask(msg))
        }
        result = await handleModel($, params)
        break
      case 'agent.spawn':
        if (!optionAllowAgents) {
          const msg = blocked(
            `${CFG.displayName} 想開一個子代理執行「${head(str(params.description) || firstLine(str(params.prompt)), 60)}」`,
            '插件選項關閉了插件開子代理（allowAgents）。',
            '到插件選項開啟 allowAgents。',
            '插件中需要子代理的功能無法使用。',
            'DISABLED',
          )
          toast($, msg)
          throw new RpcError('DISABLED', mask(msg))
        }
        result = await handleAgent($, params)
        break
      case 'exec.check':
        result = await handleExecCheck($, params)
        break
      case 'ui.execute': {
        const entry = [...toolsByShort.values()].find(tool => tool.isActive && tool.dshName === str(params.name))
        if (entry === undefined) throw new RpcError('TOOL_NOT_FOUND', '這個插件沒有啟用這項工具。')
        const answer = await callOwnTool($, { ...(isRec(params.args) ? params.args : {}), tool_use_id: 'ui-' + str(id) }, controller.signal, entry) as Rec
        if (controller.signal.aborted) { result = { content: [{ type: 'text', text: '操作已取消。' }], isError: true }; break }
        result = answer.deny !== undefined ? { content: [{ type: 'text', text: str(answer.deny) }], isError: true } : { content: answer.result, isError: false }
        break
      }
      case 'ui.notify':
        result = handleNotify($, params)
        break
      case 'ui.ask':
        result = await handleAsk($, params)
        break
      case 'prompt.submit':
        if (!optionAllowFollowups) {
          const msg = blocked(
            `${CFG.displayName} 想自己送出一則訊息：「${head(str(params.text), 60)}」`,
            '插件選項 allowFollowups 預設關閉。',
            '到插件選項開啟 allowFollowups。',
            '插件主動說話的功能無法使用。',
            'DISABLED',
          )
          // A plugin may try on a timer: say it once per load, not on every try.
          if (!followupNoticeShown) {
            followupNoticeShown = true
            toast($, msg)
          }
          throw new RpcError('DISABLED', mask(msg))
        }
        result = await handleFollowup($, params)
        break
      default:
        throw new RpcError('UNSUPPORTED', `the bridge does not handle "${method}" requests`)
    }
    reply = { id, result }
  } catch (e) {
    reply = { id, error: { code: e instanceof RpcError ? e.code : 'FAILED', message: errText(e) } }
  } finally {
    controllers.delete(str(id))
    if (controllers.size === 0) reverseControllers.delete(h)
    reverseInFlight -= 1
  }
  try {
    await rpc($, h, 'reply', reply, { timeoutMs: 10000 })
  } catch (e) {
    debug($, `could not deliver the reply to "${method}": ${errText(e)}`)
  }
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

/** A number option, also when it arrives as text; anything else (or a negative) is the default. 0 means no limit. */
function limitOption(v: unknown, d: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d
}

function readOptions(options: Readonly<Record<string, unknown>>): void {
  optionAllowModel = options.allowModelCalls !== false
  optionAllowAgents = options.allowAgents !== false
  optionAllowInterception = options.allowInterception === true
  const mode = options.outboundMode
  optionOutboundMode = mode === 'auto' || mode === 'deny' ? mode : 'ask'
  optionHourlyLimit = limitOption(options.outboundHourlyLimit, 10)
  optionDailyLimit = limitOption(options.outboundDailyLimit, 50)
  optionAllowDirectExec = options.allowDirectExec === true
  optionExtraFolders = typeof options.extraFolders === 'string' ? options.extraFolders : ''
  optionShareConversation = options.shareConversation !== false
  optionAllowFollowups = options.allowFollowups === true
  const values = new Map<string, string>()
  for (const s of CFG.secretOptions) {
    const v = options[s.option]
    if (typeof v === 'string' && v.trim() !== '') values.set(s.env, v)
  }
  setSecrets(values)
}

/** Once per load, at the session's start: each required key the person has not filled in, by its option field. */
function noticeMissingSecrets($: Engine): void {
  if (secretNoticeShown) return
  secretNoticeShown = true
  for (const s of CFG.secretOptions) {
    if (!s.required || secretValues.has(s.env)) continue
    toast(
      $,
      blocked(
        `${CFG.displayName} 缺少「${s.title}」`,
        '插件需要這把金鑰，但插件選項裡沒有填。',
        `到插件選項填入 ${s.option} 欄位。`,
        `${s.features !== '' ? s.features : '需要這把金鑰的功能'}無法使用。`,
        'SECRET_MISSING',
      ),
    )
  }
}

// A part rewritten from the source by Claude (hooks/rewrite/) may hook the events below too. One plugin cannot register
// the same event twice, so each of these hooks hands `next` over: where it calls next, ./rewrite-shared.ts runs the
// rewritten hook, which itself calls the real next (a converted plugin without a rewrite has pass-through ones there).
// A call this module answers itself (its own tools, its own commands) never reaches the rewritten hook.
function handOver<N>(next: N, wrap: (real: N) => (value: unknown) => unknown): N {
  const call = wrap(next)
  const real = next as unknown as Rec
  // `next.called`, `next.signal` and the rest read the real next's.
  return new Proxy(call, { get: (target, key) => (key in target ? (target as unknown as Rec)[key as string] : real[key as string]) }) as unknown as N
}

export const register: Register = (on, options) => {
  readOptions(options)

  on('session.start', async ($, e, next) => {
    next = handOver(next, real => (value: unknown) => rewriteSessionStart($, value, real))
    sessionEnding = false
    sessionCwd = typeof e.cwd === 'string' ? e.cwd : undefined
    noticeMissingSecrets($)
    try {
      sessionId = await $.session.id()
      sessionModel = await $.session.model()
    } catch (err) {
      debug($, `could not read the session id or model: ${errText(err)}`)
    }
    trustedExec = await readTrust($)
    try {
      const old = host
      if (old !== undefined) await stopHost($, old, DISPOSE_WAIT_MS)
      const h = startHost($)
      // Tools known from the static analysis are listed from turn one; the host's own list replaces them.
      // Queued before any await, so it can never land after the list the host reports once it is ready.
      const staticTools = CFG.features.tools ? enqueue(() => syncTools($, CFG.staticTools)) : Promise.resolve()
      try {
        if (CFG.features.ui) await $.command.register({ name: UI_NAME, description: `開啟 ${CFG.displayName} 原本的設定頁與獨立畫面` })
        await $.command.register({ name: STATUS_NAME, description: `Show the state of the host behind ${CFG.displayName}` })
        await $.command.register({ name: RESTART_NAME, description: `Restart the host behind ${CFG.displayName}` })
        await $.command.register({ name: TRUST_NAME, description: `Trust ${CFG.displayName} to start programs by itself, or withdraw the trust` })
      } catch (err) {
        debug($, `could not register the status/restart/trust commands: ${errText(err)}`)
      }
      await staticTools
      await settleWithin($, h.setup.promise, SESSION_START_WAIT_MS)
    } catch (err) {
      lastError = errText(err)
      debug($, `session.start failed: ${errText(err)}`)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    next = handOver(next, real => (value: unknown) => rewriteSessionEnd($, value, real))
    // A /clear keeps the process (and no session.start follows it), so the host must keep running.
    if (e.reason !== 'clear') sessionEnding = true
    if (e.reason !== 'clear' && host !== undefined) {
      try {
        await stopHost($, host, DISPOSE_WAIT_MS)
      } catch (err) {
        debug($, `stopping the plugin host failed: ${errText(err)}`)
      }
    }
    return next(e)
  })

  // Always hooked: the host's own list (not the static analysis) decides which tools and guards exist.
  on('tool.call', async ($, e, next) => {
    next = handOver(next, real => (value: unknown) => rewriteToolCall($, value, real))
    const entry = toolsByFull.get(String(e.tool))
    // The main conversation's calls reach a plugin that follows the chat, under the plugin's own name for its tools.
    const follow = e.agentId === undefined && followsChat()
    const callId = typeof e.tool_use_id === 'string' && e.tool_use_id !== '' ? e.tool_use_id : `call-${++toolCallSequence}`
    const name = entry !== undefined ? entry.dshName : String(e.tool)
    if (follow) tellHost($, { kind: 'tool-call', callId, name, input: toolArgs(e) })
    const result =
      entry !== undefined
        ? ((await callOwnTool($, e, next.signal, entry)) as ToolCallResult)
        : !interceptionOn()
          ? await next(e)
          : ((await intercept($, e as unknown as Rec, next as unknown as (e: never) => Promise<unknown>)) as ToolCallResult)
    if (follow) tellHost($, { kind: 'tool-result', callId, name, ...toolResultText(result) })
    return result
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const reason = next.error.message ?? next.error.kind
    if (toolsByFull.has(String(e.tool))) return { deny: mask(`${CFG.displayName}: the tool failed (${reason})`) }
    if (interceptionOn()) {
      return { deny: `${CFG.displayName}: its guard could not judge this ${String(e.tool)} call (${reason}); /${RESTART_NAME} restarts it` }
    }
    return next(e)
  })

  // The person's message reaches a plugin that follows the chat as the text Claude gets.
  on('prompt.submit', async ($, e, next) => {
    next = handOver(next, real => (value: unknown) => rewritePromptSubmit($, value, real))
    const r = await next(e)
    if (e.command !== undefined || r.drop !== undefined || !followsChat()) return r
    const origin: unknown = e.origin
    if (isRec(origin) && origin.kind === 'plugin' && origin.name === CFG.pluginName) return r // told in handleFollowup
    if (e.isMeta === true) return r // a notice the engine or another program raised, not words of the conversation
    tellHost($, { kind: 'user', text: mask(clip(r.text, 20000)) })
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    next = handOver(next, real => (value: unknown) => rewritePromptCompose($, value, real))
    const base = await next(e)
    if (promptText === '') return base
    return {
      sections: [...base.sections, { id: `${CFG.pluginName}:dsh-prompt`, text: promptText, scope: 'session' as const }],
    }
  })

  on('command.run', { command: UI_NAME }, async $ => {
    try {
      const h = await usableHost($, HOOK_READY_WAIT_MS)
      const opened = await rpc($, h, 'ui.open', {}, { timeoutMs: CFG.callTimeoutMs })
      const url = isRec(opened) ? str(opened.url) : ''
      if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) throw new Error('插件沒有提供可開啟的本機網址。')
      const shown = await $.mcp.call('Claude_Browser', 'preview_start', { url })
      if (shown.isError) return { text: mask('內建瀏覽器未能開啟，請用瀏覽器開啟：' + url) }
      return { text: '已開啟 ' + CFG.displayName + ' 的原插件畫面。' }
    } catch (error) { return { text: mask('原插件畫面未能開啟：' + errText(error)) } }
  })

  on('command.run', { command: STATUS_NAME }, async $ => ({ text: await statusText($) })).catch(($, e, next) =>
    next.called ? next(e) : { text: `${CFG.displayName}: status failed (${next.error.message ?? next.error.kind})` },
  )

  on('command.run', { command: RESTART_NAME }, async $ => ({ text: await restartText($) })).catch(($, e, next) =>
    next.called ? next(e) : { text: `${CFG.displayName}: restart failed (${next.error.message ?? next.error.kind})` },
  )

  on('command.run', { command: TRUST_NAME }, async $ => ({ text: await trustText($) })).catch(($, e, next) =>
    next.called ? next(e) : { text: `${CFG.displayName}: trust failed (${next.error.message ?? next.error.kind})` },
  )

  on('command.run', async ($, e, next) => {
    next = handOver(next, real => (value: unknown) => rewriteCommandRun($, value, real))
    const dshName = commandsBySlash.get(e.command)
    if (dshName === undefined) return next(e)
    let h: Host
    try {
      h = await usableHost($, HOOK_READY_WAIT_MS)
    } catch (err) {
      return { text: mask(`${CFG.displayName}: /${e.command} cannot run: ${errText(err)}`) }
    }
    try {
      const r = await rpc($, h, 'commands.run', { name: dshName, args: e.args }, { timeoutMs: CFG.callTimeoutMs + HOST_TIMEOUT_GRACE_MS, isBusy: () => reverseInFlight > 0 })
      const text = isRec(r) ? str(r.text) : ''
      return { text: text === '' ? '(no output)' : mask(text) }
    } catch (err) {
      return { text: mask(`${CFG.displayName}: /${e.command} failed: ${errText(err)}`) }
    }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    if (commandsBySlash.has(e.command)) return { text: `${CFG.displayName}: /${e.command} failed (${next.error.message ?? next.error.kind})` }
    return next(e)
  })

  // The final answer of a subagent this module started (an `agent.spawn` request), matched by agent id.
  on('turn.complete', ($, e, next) => {
    next = handOver(next, real => (value: unknown) => rewriteTurnComplete($, value, real))
    const id = e.agentId
    if ((id === undefined || id === '') && followsChat()) {
      tellHost($, { kind: 'turn-end', answer: mask(clip(e.answer, 20000)), reason: e.reason, ...(sessionModel !== '' ? { model: sessionModel } : {}) })
    }
    if (id !== undefined && id !== '') {
      const answer = e.reason === 'answer' ? e.answer : `(the subagent ended without an answer: ${e.reason})`
      const waiter = agentWaiters.get(id)
      if (waiter !== undefined) {
        agentWaiters.delete(id)
        waiter(answer)
      } else if (agentRequests > 0 && agentAnswers.size < 50) {
        agentAnswers.set(id, answer) // it finished before agent.spawn returned its id
      }
    }
    return next(e)
  })
}
