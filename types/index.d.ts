/** 一份清單這次的讀取結果。讀不到但之前讀過時，`total` 與 `readAt` 是沿用的那一次。 */
export type MarketSourceStatus = { id: string; title: string; total?: number; error?: string; readAt?: number }

export type MarketStatus = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  message?: string
  sources?: MarketSourceStatus[]
  /** 最近一次讀取完成的時間（毫秒）。 */
  readAt?: number
}

/** 一個版本的自述文件：`from` 寫明從哪個檔案、經哪個網站讀的。 */
export type MarketReadme = {
  phase: 'done' | 'none' | 'error'
  text?: string
  truncated?: boolean
  from?: string
  url?: string
  error?: string
}

export type MarketJob = {
  kind: 'download' | 'scan' | 'review'
  name: string
  version: string
  phase: 'running' | 'done' | 'error'
  text: string
  path?: string
  markdown?: string
}

declare module 'claude-code' {
  interface PluginState {
    'd-sh-are-in-cc': {
      status: MarketStatus
      loadedRev: number
      query: string
      category: string
      market: string
      sort: 'updated' | 'stars' | 'downloads'
      downloadsRev: number
      readmeRev: number
      page: number
      selected: string | null
      version: string | null
      job: MarketJob | null
    }
  }
}
