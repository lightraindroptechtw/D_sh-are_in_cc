/** Shared helpers of the Claude Code host modules. They never talk to a
 * app-server: everything that needs Claude Code goes through `requestHost`,
 * which the child host turns into a `request` line for the mod.
 */
export class ClaudeModuleError extends Error {
  constructor(module, method, reason, code = 'DSH_MODULE_UNSUPPORTED') {
    super(`${module}.${method}: ${reason}`);
    this.name = 'DshModuleError'; this.code = code; this.module = module; this.method = method; this.reason = reason;
  }
}
export const claudeError = (module, method, reason, code) => new ClaudeModuleError(module, method, reason, code);

/** Methods that are not mapped fail loudly instead of returning something plausible. */
export function guardService(target, module, reason = 'This method is not mapped to Claude Code') {
  return new Proxy(target, {
    get(value, key, receiver) {
      if (typeof key === 'symbol' || key === 'then' || key === 'toJSON' || Reflect.has(value, key)) return Reflect.get(value, key, receiver);
      return () => { throw claudeError(module, String(key), reason); };
    },
  });
}

/** A reply error with code DISABLED means the user left the switch off. */
export function disabledError(module, method, error, setting, code) {
  return claudeError(module, method, `${error?.message || 'disabled'} (enable ${setting} in the plugin settings to allow this)`, code);
}
export const isDisabled = error => error?.code === 'DISABLED';

const sensitive = /token|password|passwd|secret|credential|authorization|api[_-]?key|private[_-]?key|access[_-]?key|cookie/i;
export function argumentSummary(value, depth = 0) {
  if (depth > 3) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 8).map(v => argumentSummary(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, v]) => [key, sensitive.test(key) ? '[redacted]' : argumentSummary(v, depth + 1)]));
  if (typeof value === 'string') return `[string, ${value.length} characters]`; // never echo values that may hide credentials
  if (value === null) return null;
  return `[${typeof value}]`;
}
function secretValues(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, v] of Object.entries(value)) {
    if (sensitive.test(key) && typeof v === 'string' && v) result.push(v);
    else if (v && typeof v === 'object') secretValues(v, result);
  }
  return result;
}
export function redactText(text, secrets = []) {
  let out = typeof text === 'string' ? text : '';
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}

const secretsByAgent = new WeakMap();
/** Identity carrier for one tool call or hook; it is not a running DSH agent. */
export function createClaudeBridgeAgent({ root, callId, requestId, args = {} } = {}) {
  const id = `claude-tool-call:${String(callId ?? requestId ?? 'unassigned')}`;
  const session = guardService(Object.freeze({ id, projection: Object.freeze({ source: 'claude-tool-call', nativeDshSession: false }) }), 'approval.bridgeAgent.session');
  const agent = guardService(Object.freeze({ id, ctx: root, session, options: Object.freeze({}), bridgeRequestId: requestId, bridgeArgumentSummary: argumentSummary(args), projection: Object.freeze({ source: 'claude-tool-call', nativeDshAgent: false }) }), 'approval.bridgeAgent', 'The Claude Code tool call identity does not implement the native DSH agent lifecycle');
  secretsByAgent.set(agent, secretValues(args));
  return agent;
}
export const bridgeAgentSecrets = agent => secretsByAgent.get(agent) ?? [];
