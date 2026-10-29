// 「照原始碼補寫裝不進的部分」用的模型與思考強度：解析使用者寫的「模型 思考強度」，再實際試打一次模型，
// 確認使用者這個帳號真的能用。外掛（register.tsx）和本機網站（lib/market-web.mjs）共用這裡的清單；
// 網頁（market-web/app.js）在瀏覽器裡跑，不能載入 .ts，同一套規則另外寫一份。
import type { ModelCompleteRequest, ModelCompleteResult, ModelEffort } from 'claude-code'

export const REWRITE_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const REWRITE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ModelEffort[]
export type RewriteModel = (typeof REWRITE_MODELS)[number]
export type RewriteEffort = (typeof REWRITE_EFFORTS)[number]

/** 格式不對時給使用者看的正確寫法。 */
export const REWRITE_FORMAT_TEXT = '模型和思考強度的寫法不對。請寫「模型 思考強度」，例如 sonnet high。模型：haiku、sonnet、opus、fable；思考強度：low、medium、high、xhigh、max。'

export type ParsedModelSpec = { ok: true; model: RewriteModel; effort: RewriteEffort } | { ok: false; text: string; code: 'msg.rewrite.badFormat' }

/**
 * 「模型 思考強度」：不分大小寫，順序固定，中間用空白分開，前後空白不算。
 * 例如 `sonnet high`、`Opus Medium`；`high sonnet`、`sonnet`、`gpt high` 都不對。
 */
export function parseModelSpec(text: unknown): ParsedModelSpec {
  const words = typeof text === 'string' ? text.trim().toLowerCase().split(/\s+/) : []
  const [model, effort] = words
  if (words.length === 2 && (REWRITE_MODELS as readonly string[]).includes(model ?? '') && (REWRITE_EFFORTS as readonly string[]).includes(effort ?? ''))
    return { ok: true, model: model as RewriteModel, effort: effort as RewriteEffort }
  return { ok: false, text: REWRITE_FORMAT_TEXT, code: 'msg.rewrite.badFormat' }
}

/** 試打一次的結果：可以用，或白話的原因。text 給對話和面板；code（market-web/i18n.js 的 msg.*）和 params 給網頁照語言顯示。 */
export type ModelCheck =
  | { ok: true; model: RewriteModel; effort: RewriteEffort }
  | { ok: false; text: string; code: string; params: Record<string, string> }

export type Complete = (request: ModelCompleteRequest) => Promise<ModelCompleteResult>

const PROBE = '只回覆 ok'
export const CHECK_TIMEOUT = 60_000

/** 一次沒有成功的回答，換成白話原因。invalid_request 由 checkRewriteModel 另外處理（要先確認是不是思考強度的問題）。 */
function failed(model: string, reply: Exclude<ModelCompleteResult, { isAnswered: true } | { reason: 'empty-reply' }>): ModelCheck & { ok: false } {
  if (reply.reason === 'aborted') return { ok: false, text: `${model} 60 秒沒回應。`, code: 'msg.rewrite.timeout', params: { model } }
  // 忙碌、用量到上限、伺服器暫時出錯：過一陣子通常會好。
  if (reply.error === 'rate_limit' || reply.error === 'overloaded' || reply.error === 'server_error')
    return { ok: false, text: `${model} 現在忙碌或用量到上限，稍後再試。`, code: 'msg.rewrite.busy', params: { model } }
  const why = `${reply.error}${reply.status ? `，${reply.status}` : ''}`
  return { ok: false, text: `你的帳號目前不能使用 ${model}（原因：${why}）。`, code: 'msg.rewrite.unavailable', params: { model, why } }
}

/**
 * 用使用者選的模型和思考強度實際試打一次（只要它回 ok），確認這個帳號真的能用。
 * - 引擎拒絕送出（例如管理者封鎖這個模型）：不允許使用。
 * - API 說請求不對（invalid_request）：不帶思考強度再試一次；這次成功就是模型不支援這個強度，也失敗就是帳號不能用。
 * - 其他 API 錯誤：帳號不能用（附原因）；忙碌或用量到上限另外說；60 秒沒回應另外說。
 * - 回答是空的也算能用：請求送得出去、模型有回應。
 */
export async function checkRewriteModel(complete: Complete, model: RewriteModel, effort: RewriteEffort): Promise<ModelCheck> {
  const ask = (withEffort: boolean) => complete({ model, prompt: PROBE, maxTokens: 2048, ...(withEffort ? { effort } : {}), timeoutMs: CHECK_TIMEOUT })
  let reply: ModelCompleteResult
  try {
    reply = await ask(true)
  } catch {
    return { ok: false, text: `你的 Claude Code 不允許使用 ${model}。`, code: 'msg.rewrite.notAllowed', params: { model } }
  }
  if (reply.isAnswered || reply.reason === 'empty-reply') return { ok: true, model, effort }
  if (reply.reason === 'api-error' && reply.error === 'invalid_request') {
    let again: ModelCompleteResult
    try {
      again = await ask(false)
    } catch {
      return { ok: false, text: `你的 Claude Code 不允許使用 ${model}。`, code: 'msg.rewrite.notAllowed', params: { model } }
    }
    if (again.isAnswered || again.reason === 'empty-reply')
      return { ok: false, text: `${model} 不支援思考強度 ${effort}，換一個強度再試。`, code: 'msg.rewrite.effortUnsupported', params: { model, effort } }
    if (again.reason === 'api-error' && again.error === 'invalid_request') return { ok: false, text: `你的帳號目前不能使用 ${model}。`, code: 'msg.rewrite.noAccess', params: { model } }
    return failed(model, again)
  }
  return failed(model, reply)
}
