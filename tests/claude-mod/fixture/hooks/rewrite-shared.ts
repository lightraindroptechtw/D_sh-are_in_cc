// The rewritten part's hooks on the events hooks/register.ts already registers (see handOver there).
// This is the pass-through version every conversion gets: each one just calls next. When Claude rewrites the parts
// that could not be converted (hooks/rewrite/), D_sh-are_in_cc replaces this file with one that calls those hooks.
export function rewriteSessionStart($: unknown, e: unknown, next: (e: never) => unknown) {
  return next(e as never)
}
export function rewriteSessionEnd($: unknown, e: unknown, next: (e: never) => unknown) {
  return next(e as never)
}
export function rewriteToolCall($: unknown, e: unknown, next: (e: never) => unknown) {
  return next(e as never)
}
export function rewritePromptSubmit($: unknown, e: unknown, next: (e: never) => unknown) {
  return next(e as never)
}
export function rewritePromptCompose($: unknown, e: unknown, next: (e: never) => unknown) {
  return next(e as never)
}
export function rewriteCommandRun($: unknown, e: unknown, next: (e: never) => unknown) {
  return next(e as never)
}
export function rewriteTurnComplete($: unknown, e: unknown, next: (e: never) => unknown) {
  return next(e as never)
}
