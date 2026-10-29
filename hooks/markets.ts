// 讀所有社群清單並合併：面板（經 Claude Code 的網路功能）與瀏覽器版市場的本機伺服器（經 Node.js）共用。
import { MARKETS, categoryTitles, mergeCatalogs, normalizeIndex, normalizeSiteCatalog } from './catalog.ts'
import type { Entry } from './catalog.ts'

/** 讀一個網址的文字；不是 2xx 就丟出含狀態碼的錯誤（例如「HTTP 503」），讓使用者看得到原因。 */
export type FetchOrThrow = (url: string) => Promise<string>

/** 一份清單這次的讀取結果。讀不到但之前完整讀過時，`total` 與 `readAt` 是沿用的那一次。 */
export type SourceStatus = { id: string; title: string; total?: number; error?: string; readAt?: number }

/** 每份清單最後一次完整讀成功的內容；重新讀取時某一份暫時讀不到，就沿用上次的，清單不會突然少一半。 */
export type LastGood = Map<string, { entries: Entry[]; readAt: number }>

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/**
 * 讀每份清單的每個檔案、整理、合併。全部讀不到時 `entries` 是 undefined。
 * 一份清單有檔案讀不到：之前完整讀過就沿用那一次，否則先用讀到的部分；錯誤寫進那份清單的 `error`。
 */
export async function readMarkets(fetchText: FetchOrThrow, lastGood: LastGood, now: number): Promise<{ sources: SourceStatus[]; entries?: Entry[] }> {
  const results = await Promise.all(
    MARKETS.map(async (source): Promise<{ status: SourceStatus; entries?: Entry[] }> => {
      const base = { id: source.id, title: source.title }
      const files = await Promise.all(
        source.files.map(async file => {
          try {
            return { file, raw: JSON.parse(await fetchText(file.url)) as unknown }
          } catch (cause) {
            return { file, error: `${file.label}：${message(cause)}` }
          }
        }),
      )
      // 網站清單的分類用同一份清單索引裡的中文名稱。
      const titles = categoryTitles(files.find(f => f.file.kind === 'index' && !('error' in f))?.raw)
      const errors: string[] = []
      const lists: Entry[][] = []
      for (const f of files) {
        if ('error' in f) {
          errors.push(f.error ?? f.file.label)
          continue
        }
        try {
          lists.push(f.file.kind === 'index' ? normalizeIndex(f.raw, source.id, f.file.url) : normalizeSiteCatalog(f.raw, source.id, titles))
        } catch (cause) {
          errors.push(`${f.file.label}：${message(cause)}`)
        }
      }
      const fresh = lists.length ? mergeCatalogs(lists) : undefined
      if (fresh && !errors.length) {
        lastGood.set(source.id, { entries: fresh, readAt: now })
        return { status: { ...base, total: fresh.length, readAt: now }, entries: fresh }
      }
      const prior = lastGood.get(source.id)
      const entries = prior?.entries ?? fresh
      const readAt = prior ? prior.readAt : now
      return { status: { ...base, error: errors.join('；'), ...(entries ? { total: entries.length, readAt } : {}) }, ...(entries ? { entries } : {}) }
    }),
  )
  const lists = results.flatMap(r => (r.entries ? [r.entries] : []))
  return { sources: results.map(r => r.status), ...(lists.length ? { entries: mergeCatalogs(lists) } : {}) }
}
