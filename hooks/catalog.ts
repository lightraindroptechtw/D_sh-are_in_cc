// DSH 插件目錄的整理與搜尋：純資料函式，不連網、不執行程式。
// 目錄內容是插件作者寫的資料，只拿來顯示和搜尋，不當指令；格式不對的條目直接略過，不讓整份目錄失敗。

/**
 * 一份清單由一或多個檔案組成。`index` 是 DSH 插件索引格式（format 1，有版本清單）；
 * `site` 是 awesome-dsh-plugin.com 網站自己用的清單（每個插件一筆安裝指令，含只在 GitHub 上的插件）。
 */
export type MarketFile = { kind: 'index' | 'site'; url: string; label: string }

/** 插件清單的來源。兩份都是社群維護，不是 DeepSeek 官方；`about` 照清單自己的說明寫。 */
export type Market = { id: string; title: string; short: string; site: string; about: string; files: readonly MarketFile[] }

export const MARKETS: readonly Market[] = [
  {
    id: 'open',
    title: '開放插件市場',
    short: '開放市場',
    site: 'dshopen.org',
    about: '社群維護的 DeepSeek Harness 插件索引。',
    files: [{ kind: 'index', url: 'https://dshopen.org/index.json', label: '插件索引' }],
  },
  {
    id: 'awesome',
    title: 'Awesome DSH 插件精選',
    short: 'Awesome 精選',
    site: 'awesome-dsh-plugin.com',
    about: '社群整理的精選清單。讀兩個檔案：npm 套件 dsh-plugin-catalog 裡的索引（只有發布在 npm 的插件，有版本清單和中文說明，由 jsDelivr 轉送），以及網站自己的完整清單（多了只放在 GitHub 的插件，說明只有英文）。',
    files: [
      { kind: 'index', url: 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json', label: 'npm 套件裡的索引' },
      { kind: 'site', url: 'https://awesome-dsh-plugin.com/catalog.json', label: '網站完整清單' },
    ],
  },
]

/**
 * `git` 沒有 `commit` 時是「預設分支的最新版」：下載當下才固定到那一次提交。
 * `release` 是 GitHub 發布檔（.tgz），轉換器還不能下載，只能看介紹與自述文件。
 */
export type VersionSource = { type: 'npm' } | { type: 'git'; url: string; commit?: string; path?: string } | { type: 'release'; url: string; repo: string }

/** `floating` 表示清單沒給固定版本，下載當下才決定是哪一版。 */
export type Version = { version: string; published: number; source: VersionSource; floating?: true }

export type Entry = {
  name: string
  title: string
  description: string
  author: string
  /** 分類的顯示名稱（繁體中文）；`categoryId` 是合併後的分類代號，見 CATEGORY_TITLES。 */
  category: string
  categoryId: string
  keywords: string[]
  homepage: string
  repository: string
  markets: string[]
  versions: Version[]
  updated: number
  stars?: number
  /** Awesome 網站清單的下載數，跟 npm 過去 30 天的次數幾乎一樣（比對過 billion-context）。 */
  downloads?: number
  /** 開放插件市場標的下載量級下限（標籤 downloads-5k 就是 5000）；清單沒寫是總數還是一段期間。 */
  downloadsRange?: number
  /** 圖示的完整網址（https）：開放插件市場的清單有寫才有。 */
  icon?: string
}

/**
 * 兩份清單的分類合成一套。Awesome 的 23 類比較細，用它的代號；開放插件市場的 11 類對到意思相同的那一類，
 * 對不到的（knowledge 知識與研究）自成一類。名稱是繁體中文；網頁的其他語言在 market-web/i18n.js（cat.代號）。
 * 清單以後新增的分類不在這裡，就照清單自己寫的名稱顯示。
 */
export const CATEGORY_TITLES: Readonly<Record<string, string>> = {
  ui: 'UI 增強', tools: '工具與能力', session: '會話與訊息', dev: '開發與執行環境', workflow: '工作流程與自動化',
  usage: '用量與計費', model: '模型與帳號接入', memory: '記憶', theme: '主題與外觀', notify: '通知與整合',
  skill: '技能包', fun: '娛樂', security: '安全與權限', remote: '遠端與行動裝置', browser: '瀏覽器與網頁',
  git: 'Git 與程式碼審查', vision: '視覺與多模態', market: '插件市場與管理', docs: '文件與渲染', wsl: 'WSL 與 Windows 互通',
  voice: '語音與音訊', identity: '身分與通訊', agi: 'AGI 架構探索', knowledge: '知識與研究',
}

// 開放插件市場的分類代號 → 合併後的代號。tools、memory、usage、workflow 兩份清單代號相同、意思也相同（例如「工具」和「工具與能力」）。
const CATEGORY_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  open: { interface: 'ui', skills: 'skill', providers: 'model', integrations: 'notify', appearance: 'theme', development: 'dev' },
}

/** 清單裡的分類代號換成合併後的代號與名稱；`title` 是清單自己寫的名稱，只在代號不認得時用。 */
function categoryOf(marketId: string, raw: string, title: string): { categoryId: string; category: string } {
  if (!raw) return { categoryId: '', category: '' }
  const categoryId = CATEGORY_ALIASES[marketId]?.[raw] ?? raw
  return { categoryId, category: CATEGORY_TITLES[categoryId] ?? (title || raw) }
}

const NPM_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/
const COMMIT = /^[0-9a-f]{40}$/
const GITHUB = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** 多語文字取一種：繁中、中文、英文，最後任何一種。 */
export function pickText(value: unknown, max = 2000): string {
  if (typeof value === 'string') return value.trim().slice(0, max)
  const map = record(value)
  if (!map) return ''
  for (const key of ['zh-TW', 'zh-Hant', 'zh', 'en']) {
    const text = map[key]
    if (typeof text === 'string' && text.trim()) return text.trim().slice(0, max)
  }
  const first = Object.values(map).find(text => typeof text === 'string' && text.trim())
  return typeof first === 'string' ? first.trim().slice(0, max) : ''
}

function safeUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

function safeSubdir(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return value.split('/').every(part => part && part !== '.' && part !== '..' && /^[\w.@+-]+$/.test(part)) ? value : undefined
}

const IMAGE_FILE = /\.(?:svg|png|jpe?g|webp|gif)$/i

/**
 * 圖示路徑換成完整網址：只接受圖片副檔名、接在 `base` 底下的相對路徑（不能有 `..`），或 https 網址。
 * 開放插件市場寫的是相對於清單網址的路徑（icons/xxxx.svg）；npm 套件的 `icon` 是相對於套件根目錄的路徑。
 */
export function iconUrl(value: unknown, base: string): string | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined
  const path = value.trim().replace(/^\.\//, '')
  if (/^https:\/\//i.test(path)) {
    const url = safeUrl(path)
    return url.startsWith('https:') && IMAGE_FILE.test(new URL(url).pathname) ? url : undefined
  }
  return safeSubdir(path) && IMAGE_FILE.test(path) ? new URL(path, base).href : undefined
}

/** jsDelivr 上一個 npm 套件某個版本的檔案根目錄（結尾有 /）。 */
export const npmFileBase = (name: string, version: string) => `https://cdn.jsdelivr.net/npm/${name}@${version}/`

/** npm 套件某版本（或 latest）的 package.json 網址：插件作者可能在裡面寫 `icon`。 */
export const npmManifestUrl = (name: string, version = 'latest') => `https://registry.npmjs.org/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`

/** 從 npm 的 package.json 讀圖示，換成 jsDelivr 上的完整網址；沒寫或寫得不合格就回傳 undefined。 */
export function npmIcon(raw: unknown, name: string): string | undefined {
  const manifest = record(raw)
  if (!manifest || manifest.name !== name || typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) return undefined
  return iconUrl(manifest.icon, npmFileBase(name, manifest.version))
}

function versionOf(row: unknown): Version | undefined {
  const item = record(row)
  const source = record(item?.source)
  if (!item || typeof item.version !== 'string' || !VERSION.test(item.version) || !source) return undefined
  const published = typeof item.publishTimestamp === 'number' && Number.isFinite(item.publishTimestamp) ? item.publishTimestamp : 0
  if (source.type === 'npm') return { version: item.version, published, source: { type: 'npm' } }
  if (source.type === 'git' && typeof source.url === 'string' && GITHUB.test(source.url) && typeof source.commit === 'string' && COMMIT.test(source.commit)) {
    const path = safeSubdir(source.path)
    return { version: item.version, published, source: { type: 'git', url: source.url, commit: source.commit, ...(path ? { path } : {}) } }
  }
  return undefined
}

/** 開放插件市場的下載量級標籤（downloads-100、downloads-5k…）取最大的下限。 */
function downloadsLabel(labels: unknown): number | undefined {
  if (!Array.isArray(labels)) return undefined
  let best: number | undefined
  for (const label of labels) {
    const match = typeof label === 'string' ? /^downloads-(\d{1,6})(k?)$/.exec(label) : null
    if (match) best = Math.max(best ?? 0, Number(match[1]) * (match[2] ? 1000 : 1))
  }
  return best
}

/** 把一份目錄（format 1）整理成條目；不合格的條目和版本略過。`url` 是這份目錄的網址，相對路徑的圖示接在它底下。 */
export function normalizeIndex(raw: unknown, marketId: string, url?: string): Entry[] {
  const index = record(raw)
  if (!index || !Array.isArray(index.plugins)) throw new Error('目錄格式不對：缺少 plugins 清單')
  const categories = record(record(index.metadata)?.categories) ?? {}
  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const row of index.plugins) {
    const item = record(row)
    const name = item?.name
    if (!item || typeof name !== 'string' || name.length > 214 || !NPM_NAME.test(name) || seen.has(name)) continue
    const versions = (Array.isArray(item.versions) ? item.versions : []).map(versionOf).filter((v): v is Version => v !== undefined)
    if (!versions.length) continue
    versions.sort((a, b) => b.published - a.published || (a.version < b.version ? 1 : -1))
    seen.add(name)
    const meta = record(item.metadata) ?? {}
    const categoryId = typeof meta.category === 'string' ? meta.category : ''
    const stars = record(meta.sortKeys)?.['github-stars']
    const downloadsRange = downloadsLabel(meta.labels)
    const icon = url ? iconUrl(item.icon, url) : undefined
    entries.push({
      name,
      title: pickText(item.title, 200) || name,
      // 開放插件市場的說明開頭附了「★ 873 │」，星數另外顯示，這裡拿掉。
      description: pickText(item.description).replace(/^★\s*[\d,.]+\s*[kKmM萬]?\s*[│|｜]\s*/, ''),
      author: pickText(item.author, 200),
      ...categoryOf(marketId, categoryId, pickText(record(categories[categoryId])?.title, 100)),
      keywords: Array.isArray(meta.keywords) ? meta.keywords.filter((k): k is string => typeof k === 'string').slice(0, 50) : [],
      homepage: safeUrl(item.homepage),
      repository: safeUrl(record(item.repository)?.url),
      markets: [marketId],
      versions,
      updated: versions[0]?.published ?? 0,
      ...(typeof stars === 'number' && Number.isFinite(stars) ? { stars } : {}),
      ...(downloadsRange !== undefined ? { downloadsRange } : {}),
      ...(icon ? { icon } : {}),
    })
  }
  return entries
}

/** 合併多份目錄：同名插件只留一筆，版本取聯集，記下出現在哪些市場；依最近更新排序。 */
export function mergeCatalogs(lists: readonly Entry[][]): Entry[] {
  const byName = new Map<string, Entry>()
  for (const list of lists) {
    for (const entry of list) {
      const prior = byName.get(entry.name)
      if (!prior) {
        byName.set(entry.name, { ...entry, markets: [...entry.markets], versions: [...entry.versions] })
        continue
      }
      for (const market of entry.markets) if (!prior.markets.includes(market)) prior.markets.push(market)
      for (const version of entry.versions) if (!prior.versions.some(v => v.version === version.version)) prior.versions.push(version)
      // 有固定版本時，不留「下載當下才決定」的那一筆。
      if (prior.versions.some(v => !v.floating)) prior.versions = prior.versions.filter(v => !v.floating)
      prior.versions.sort((a, b) => b.published - a.published || (a.version < b.version ? 1 : -1))
      prior.updated = prior.versions[0]?.published ?? prior.updated
      for (const key of ['description', 'author', 'homepage', 'repository'] as const) if (!prior[key]) prior[key] = entry[key]
      // 分類：Awesome 的分得比較細，同一個插件兩份清單都有分類時用 Awesome 的。
      if (entry.categoryId && (!prior.categoryId || (prior.markets[0] === 'open' && !entry.markets.includes('open')))) {
        prior.categoryId = entry.categoryId
        prior.category = entry.category
      }
      if (prior.title === prior.name && entry.title !== entry.name) prior.title = entry.title
      if (prior.stars === undefined && entry.stars !== undefined) prior.stars = entry.stars
      if (prior.downloads === undefined && entry.downloads !== undefined) prior.downloads = entry.downloads
      if (prior.downloadsRange === undefined && entry.downloadsRange !== undefined) prior.downloadsRange = entry.downloadsRange
      if (prior.icon === undefined && entry.icon !== undefined) prior.icon = entry.icon
    }
  }
  return [...byName.values()].sort((a, b) => b.updated - a.updated || (a.name < b.name ? -1 : 1))
}

export type Sort = 'updated' | 'stars' | 'downloads'

export type Query = { query?: string; category?: string; market?: string; sort?: Sort; page?: number; pageSize?: number }

export type SearchResult = { items: Entry[]; total: number; page: number; pages: number }

const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase()

/** 關鍵字以空白分開，全部都要出現在名稱、標題、描述、作者、分類或關鍵字裡。目錄本身已依最近更新排序。 */
export function searchCatalog(entries: readonly Entry[], { query = '', category = '', market = '', sort = 'updated', page = 1, pageSize = 10 }: Query = {}): SearchResult {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  const matched = entries.filter(entry => {
    if (category && entry.category !== category) return false
    if (market && !entry.markets.includes(market)) return false
    if (!terms.length) return true
    const text = fold([entry.name, entry.title, entry.description, entry.author, entry.category, ...entry.keywords].join('\n'))
    return terms.every(term => text.includes(term))
  })
  // 星數只有開放插件市場有；沒有星數的排在後面，同星數維持最近更新的順序。
  if (sort === 'stars') matched.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
  // 下載數用 Awesome 網站清單的（約 30 天），沒有才用開放插件市場的量級；都沒有的排在後面。
  if (sort === 'downloads') matched.sort((a, b) => (b.downloads ?? b.downloadsRange ?? -1) - (a.downloads ?? a.downloadsRange ?? -1))
  const size = Math.max(1, Math.floor(pageSize))
  const pages = Math.max(1, Math.ceil(matched.length / size))
  const current = Math.min(Math.max(1, Math.floor(page)), pages)
  return { items: matched.slice((current - 1) * size, current * size), total: matched.length, page: current, pages }
}

/** 分類選單：依插件數由多到少。 */
export function categoryOptions(entries: readonly Entry[]): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const entry of entries) if (entry.category) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
}

/** GitHub 倉庫網址拆成擁有者與倉庫名稱；不是 GitHub 倉庫網址就回傳 undefined。 */
export function githubRepo(url: string): { owner: string; repo: string } | undefined {
  const match = GITHUB.exec(url)
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined
}

/** 轉換器能不能下載這個版本：GitHub 發布檔（.tgz）還不行。 */
export const canFetch = (version: Version) => version.source.type !== 'release'

/**
 * 交給轉換器命令列的來源寫法：npm 固定版本，或 GitHub 固定提交。
 * 清單沒給固定版本時（floating）交給轉換器下載最新版，它會回報實際的版本或提交，之後的掃描與安裝都用那一個。
 */
export function sourceSpec(entry: Entry, version: Version): { spec: string; packageDir?: string } {
  const source = version.source
  if (source.type === 'npm') return { spec: version.floating ? `npm:${entry.name}` : `npm:${entry.name}@${version.version}` }
  if (source.type === 'release') throw new Error('GitHub 發布檔還不能下載')
  const match = GITHUB.exec(source.url)
  if (!match) throw new Error('GitHub 來源網址不合法')
  const repo = `https://github.com/${match[1]}/${match[2]}`
  return { spec: source.commit ? `${repo}/tree/${source.commit}` : repo, ...(source.path ? { packageDir: source.path } : {}) }
}

const SITE_COMMAND = /^dsh plugin --profile web add (\S.*)$/
const SITE_GITHUB = /^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#path:\/?([^#\s]+?)\/?)?$/
const SITE_RELEASE = /^"?(https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/(?:latest\/download|download\/[^/"\s]+)\/[^/"\s]+\.tgz)"?$/
const SITE_SLUG = /^[\w.-]{1,100}\/[\w.-]{1,200}$/
const SITE_PAGE = /^\/p\/[\w.-]+\/[\w.-]+\/$/

/**
 * 整理 awesome-dsh-plugin.com 網站自己的清單（catalog.json 的 items）。
 * 每筆只有一條 DSH 安裝指令，沒有版本清單：npm 插件下載當下取最新版；GitHub 插件下載當下固定到預設分支的最新提交。
 * `categoryTitles` 是同一份清單索引裡的分類名稱（分類代號 → 中文），讓兩個檔案的分類一致。
 */
export function normalizeSiteCatalog(raw: unknown, marketId: string, categoryTitles: Readonly<Record<string, string>> = {}): Entry[] {
  const catalog = record(raw)
  if (!catalog || !Array.isArray(catalog.items)) throw new Error('網站清單格式不對：缺少 items 清單')
  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const row of catalog.items) {
    const item = record(row)
    const target = item && typeof item.cmd === 'string' ? SITE_COMMAND.exec(item.cmd.trim())?.[1]?.trim() : undefined
    if (!item || !target) continue
    const added = typeof item.added === 'string' ? Date.parse(item.added) : NaN
    const published = Number.isFinite(added) ? Math.floor(added / 1000) : 0
    let name: string
    let version: Version
    let repository = ''
    if (item.npm === 1 || item.npm === true) {
      if (target.length > 214 || !NPM_NAME.test(target)) continue
      name = target
      version = { version: '最新版', published, floating: true, source: { type: 'npm' } }
    } else {
      if (typeof item.slug !== 'string' || !SITE_SLUG.test(item.slug) || item.slug.split('/').some(part => /^\.+$/.test(part))) continue
      name = item.slug
      const github = SITE_GITHUB.exec(target)
      const release = github ? null : SITE_RELEASE.exec(target)
      if (github) {
        const path = safeSubdir(github[3])
        repository = `https://github.com/${github[1]}/${github[2]}`
        version = { version: '最新版', published, floating: true, source: { type: 'git', url: repository, ...(path ? { path } : {}) } }
      } else if (release?.[1]) {
        repository = `https://github.com/${release[2]}/${release[3]}`
        version = { version: '發布檔', published, floating: true, source: { type: 'release', url: release[1], repo: repository } }
      } else continue
    }
    if (seen.has(name)) continue
    seen.add(name)
    const categoryId = typeof item.cat === 'string' ? item.cat : ''
    const stars = item.stars
    const downloads = item.dl
    entries.push({
      name,
      title: pickText(item.name, 200) || name,
      description: pickText(item.desc),
      author: typeof item.owner === 'string' ? item.owner.slice(0, 100) : '',
      ...categoryOf(marketId, categoryId, categoryTitles[categoryId] || pickText(item.tag, 100)),
      keywords: [],
      homepage: typeof item.href === 'string' && SITE_PAGE.test(item.href) ? `https://awesome-dsh-plugin.com${item.href}` : '',
      repository,
      markets: [marketId],
      versions: [version],
      updated: published,
      ...(typeof stars === 'number' && Number.isFinite(stars) ? { stars } : {}),
      ...(typeof downloads === 'number' && Number.isFinite(downloads) ? { downloads } : {}),
    })
  }
  return entries
}

/** 索引裡的分類名稱表（分類代號 → 顯示名稱），給網站清單用。 */
export function categoryTitles(raw: unknown): Record<string, string> {
  const categories = record(record(record(raw)?.metadata)?.categories) ?? {}
  return Object.fromEntries(Object.entries(categories).map(([id, value]) => [id, pickText(record(value)?.title, 100) || id]))
}

/** 發佈時間（目錄用秒）轉成使用者所在時區的日期。 */
export function formatDate(seconds: number): string {
  if (!seconds) return '日期不明'
  const date = new Date(seconds < 1e11 ? seconds * 1000 : seconds)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本地時間 YYYY-MM-DD HH:MM，用來標示清單是什麼時候讀的。 */
export function formatDateTime(ms: number): string {
  if (!ms) return '時間不明'
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${formatDate(ms)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 數字寫成中文習慣：1 萬以上用「萬」，其他加千分位。 */
export function formatCount(n: number): string {
  if (n >= 10000) return `${Number((n / 10000).toFixed(n >= 100000 ? 0 : 1))}萬`
  return n.toLocaleString('en-US')
}

/** 下載統計的期間：到昨天（UTC）為止的 30 天，寫成 npm 要的「開始:結束」。 */
export function npmDownloadsPeriod(now: number): string {
  const day = (offset: number) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10)
  return `${day(30)}:${day(1)}`
}

/**
 * npm 下載統計（api.npmjs.org）一次查詢的網址：沒有範圍的名稱可以一次查多個，有範圍（@xxx/）的要一個一個查。
 * 期間寫明日期：npm 的 last-month 曾經停在幾個月前的舊資料，新插件全部顯示 0。
 */
export function npmDownloadsUrls(names: readonly string[], now: number): string[] {
  const plain = names.filter(name => !name.startsWith('@'))
  const scoped = names.filter(name => name.startsWith('@'))
  const base = `https://api.npmjs.org/downloads/point/${npmDownloadsPeriod(now)}/`
  const urls: string[] = []
  for (let i = 0; i < plain.length; i += 100) urls.push(base + plain.slice(i, i + 100).join(','))
  for (const name of scoped) urls.push(base + name.replace('/', '%2F'))
  return urls
}

export type NpmDownloads = { downloads: number; start: string; end: string }

/** 讀 npm 下載統計的回應：一個套件時是單筆，多個時是以名稱為鍵的物件；查不到的套件是 null。 */
export function parseNpmDownloads(raw: unknown): Map<string, NpmDownloads> {
  const out = new Map<string, NpmDownloads>()
  const take = (row: unknown) => {
    const item = record(row)
    if (item && typeof item.package === 'string' && typeof item.downloads === 'number' && Number.isFinite(item.downloads))
      out.set(item.package, { downloads: item.downloads, start: typeof item.start === 'string' ? item.start : '', end: typeof item.end === 'string' ? item.end : '' })
  }
  const top = record(raw)
  if (top && typeof top.package === 'string') take(top)
  else if (top) for (const row of Object.values(top)) take(row)
  return out
}

const README = /^readme(?:[._-][\w-]+)?\.(?:md|markdown)$/i

/** 自述文件的優先順序：繁中、簡中、沒標語言的，最後其他語言。 */
function readmeRank(file: string): number {
  if (/zh[._-]?(?:tw|hant|hk)|[._-]tw\b/i.test(file)) return 0
  if (/zh|[._-]cn\b|chinese/i.test(file)) return 1
  if (/^readme\.(?:md|markdown)$/i.test(file)) return 2
  return 3
}

/**
 * 從一份檔案清單（jsDelivr 列出的路徑，以 / 開頭）挑出 `dir` 這一層的自述文件，沒有就回傳 undefined。
 * `dir` 是插件所在的子目錄，根目錄給空字串。
 */
export function pickReadme(files: readonly string[], dir = ''): string | undefined {
  const clean = dir.replace(/^\/+|\/+$/g, '')
  const prefix = clean ? `/${clean}/` : '/'
  return files
    .filter(path => path.startsWith(prefix) && README.test(path.slice(prefix.length)))
    .sort((a, b) => readmeRank(a.slice(prefix.length)) - readmeRank(b.slice(prefix.length)) || a.length - b.length)[0]
}

/** 依序試這些檔名（GitHub 沒有檔案清單可查時用）。 */
export const README_GUESSES = ['README.zh-TW.md', 'README.zh-CN.md', 'README_zh-CN.md', 'README.zh.md', 'README_CN.md', 'README.md', 'readme.md', 'Readme.md'] as const

/**
 * 自述文件是插件作者寫的，只拿來顯示：拿掉 HTML 標籤與註解（保留文字），圖片改成文字連結（不在面板裡載入外部圖片），
 * 太長時截斷並回報。
 */
export function cleanReadme(text: string, max = 60_000): { text: string; truncated: boolean } {
  let out = text
    .replace(/^﻿/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt: string, url: string) => `[圖片：${alt.trim() || '沒有說明'}](${url})`)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const truncated = out.length > max
  if (truncated) out = out.slice(0, max)
  return { text: out, truncated }
}
