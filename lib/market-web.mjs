// 瀏覽器版 DSH 插件市場的本機網站：只綁 127.0.0.1，每次啟動產生新的存取鑰匙（網址 # 後面那段）。
// 網站只提供清單、自述文件、下載次數，並把使用者按的「審查並安裝／腳本安全掃描／只下載／照原始碼補寫／Haiku 搜尋」排進佇列；
// 真正的下載、掃描、交給 Claude、問 Haiku 都由外掛（hooks/register.tsx）在 Claude Code 裡做，網站本身不執行任何插件的程式。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MARKETS, canFetch, npmDownloadsUrls, npmIcon, npmManifestUrl, parseNpmDownloads, sourceSpec } from '../hooks/catalog.ts';
import { readMarkets } from '../hooks/markets.ts';
import { readReadme } from '../hooks/readme.ts';
import { claudeRunner, installedState, manage, matchEntry, newerVersion, readFavorites, setFavorite } from './market-installed.mjs';
import { deleteDownloads, listDownloads } from './downloads.mjs';
import { dshHome } from './npm-source.mjs';

const WEB_DIR = fileURLToPath(new URL('../market-web/', import.meta.url));
// 網站只送這幾個檔案，路徑寫死，不從網址組檔名。
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
};
// 頁面只能跑自己的程式、只連自己；自述文件裡的圖片可以從 https 網站載入。
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ACTIONS = new Set(['review', 'scan', 'download']);
/**
 * 錯誤回應。error 是繁中原文；code（market-web/i18n.js 的 msg.* 句子）和 params 讓網頁照介面語言顯示，
 * 網頁不認得 code 時才顯示原文。
 */
const fail = (status, code, error, params) => ({ status, body: { error, code, ...(params ? { params } : {}) } });
const MESSAGE_CODE = /^msg\.[a-zA-Z0-9.-]{1,60}$/;
/** 外掛回報的句子參數：只收字串和數字，太長的截斷。 */
const cleanParams = params => !params || typeof params !== 'object' || Array.isArray(params) ? undefined
  : Object.fromEntries(Object.entries(params).filter(([key, value]) => /^\w{1,30}$/.test(key) && ['string', 'number'].includes(typeof value)).slice(0, 10).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 2000) : value]));
const RUNNING_TEXT = { review: '已交給 Claude，請到對話看審查過程。', scan: '正在下載並掃描原始碼（固定規則，不呼叫模型）…', download: '正在下載原始碼（只下載，不安裝、不執行）…', 'open-folder': '正在開啟資料夾…', 'ai-search': '正在問 Haiku…' };
// Haiku 搜尋：使用者的描述最長幾個字、Haiku 挑出的插件最多幾個、交給 Haiku 挑的候選最多幾個。
const AI_QUERY_MAX = 300;
const AI_RESULTS_MAX = 20;
const AI_CANDIDATES = 40;
const LANG_CODES = new Set(['zh-Hant', 'zh-Hans', 'en', 'ja', 'ko', 'es', 'fr', 'ru', 'ar']);
const fold = text => String(text ?? '').normalize('NFKC').toLocaleLowerCase();
const MAX_BODY = 4096;
const README_MAX = 300_000;
const message = cause => (cause instanceof Error ? cause.message : String(cause));
const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);

/** 預設的網路讀取：Node.js 內建 fetch，30 秒逾時。 */
export const defaultFetch = url => fetch(url, { headers: { 'user-agent': 'd-sh-are-in-cc-market' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });

/** 給網頁的精簡條目：網頁在瀏覽器裡自己搜尋、篩選、排序。版本最多帶 30 個。 */
const compact = e => ({
  name: e.name, title: e.title, description: e.description, author: e.author, category: e.category, categoryId: e.categoryId, homepage: e.homepage, repository: e.repository,
  markets: e.markets, updated: e.updated, stars: e.stars, downloads: e.downloads, downloadsRange: e.downloadsRange, icon: e.icon,
  versions: e.versions.slice(0, 30).map(v => ({ version: v.version, published: v.published, type: v.source.type, floating: Boolean(v.floating) })),
});

/**
 * `home` 是轉換器的資料夾（本機插件市場、收藏都在這裡）；`runClaude` 執行 `claude` 指令（測試時換成替身）。
 */
export function createMarketWeb({ fetchImpl = defaultFetch, now = () => Date.now(), webDir = WEB_DIR, home = dshHome(), runClaude = claudeRunner() } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const lastGood = new Map();
  const readmes = new Map();
  const counts = new Map();
  const icons = new Map();
  const jobs = new Map();
  let server, origin, host, loading, catalogPayload;
  let byName = new Map();
  let state = { phase: 'idle', sources: [], readAt: 0 };
  let seq = 0;

  const fetchOrThrow = async url => { const r = await fetchImpl(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
  const fetchText = async url => { const r = await fetchImpl(url); return r.ok ? r.text() : undefined; };

  function loadCatalog() {
    loading ??= (async () => {
      state = { ...state, phase: 'loading' };
      const at = now();
      const result = await readMarkets(fetchOrThrow, lastGood, at);
      if (result.entries) {
        byName = new Map(result.entries.map(e => [e.name, e]));
        catalogPayload = undefined;
        installedCache = undefined;
        state = { phase: 'ready', sources: result.sources, readAt: at };
      } else state = { phase: byName.size ? 'ready' : 'error', sources: result.sources, readAt: at, error: '兩份清單都讀不到，可能是網路不通或清單網站暫時無法連線。', errorCode: 'msg.catalogUnreadable' };
    })().catch(cause => { state = { ...state, phase: byName.size ? 'ready' : 'error', error: message(cause) }; }).finally(() => { loading = undefined; });
    return loading;
  }

  function catalogBody() {
    catalogPayload ??= JSON.stringify({ entries: [...byName.values()].map(compact) });
    return catalogPayload;
  }

  function lookup(name, version) {
    const entry = typeof name === 'string' ? byName.get(name) : undefined;
    const picked = entry && typeof version === 'string' ? entry.versions.find(v => v.version === version) : undefined;
    return { entry, picked };
  }

  async function readme(name, version) {
    const { entry, picked } = lookup(name, version);
    if (!entry || !picked) return fail(404, 'msg.noSuchVersion', '清單裡沒有這個插件或版本');
    const key = `${name}@${version}`;
    if (!readmes.has(key)) {
      readmes.set(key, (async () => {
        try {
          const found = await readReadme(fetchText, entry, picked);
          // 沒找到不記住：剛發布的版本 jsDelivr 可能還沒收到，下次打開插件頁再找一次。
          if (!found) { readmes.delete(key); return { phase: 'none' }; }
          return { phase: 'done', text: found.text.slice(0, README_MAX), truncated: found.text.length > README_MAX, from: found.from, url: found.url, base: found.url.replace(/[^/]*$/, '') };
        } catch (cause) {
          readmes.delete(key);
          return { phase: 'error', error: message(cause) };
        }
      })());
    }
    return { status: 200, body: await readmes.get(key) };
  }

  async function downloads(names) {
    const wanted = names.filter(n => byName.get(n)?.versions[0]?.source.type === 'npm').slice(0, 100);
    const missing = wanted.filter(n => !counts.has(n));
    if (missing.length) {
      await Promise.all(npmDownloadsUrls(missing, now()).map(async url => {
        try { for (const [n, c] of parseNpmDownloads(JSON.parse(await fetchOrThrow(url)))) counts.set(n, c); } catch { /* 下載次數只是參考，查不到就不顯示 */ }
      }));
      for (const n of missing) if (!counts.has(n)) counts.set(n, null);
    }
    return Object.fromEntries(wanted.map(n => [n, counts.get(n) ?? null]));
  }

  /**
   * 清單沒有圖示的 npm 插件，讀套件 package.json 的 `icon`，換成 jsDelivr 上的網址。
   * 只讀網頁正在顯示的（一次最多 60 個，同時最多 8 個請求），讀過就記住；讀不到記成 null。
   */
  async function npmIcons(names) {
    const wanted = names.filter(n => { const e = byName.get(n); return e && !e.icon && e.versions[0]?.source.type === 'npm'; }).slice(0, 60);
    const missing = wanted.filter(n => !icons.has(n));
    for (let i = 0; i < missing.length; i += 8) {
      await Promise.all(missing.slice(i, i + 8).map(async name => {
        const latest = byName.get(name).versions[0];
        try { icons.set(name, npmIcon(JSON.parse(await fetchOrThrow(npmManifestUrl(name, latest.floating ? 'latest' : latest.version))), name) ?? null); } catch { icons.set(name, null); }
      }));
    }
    return Object.fromEntries(wanted.map(n => [n, icons.get(n) ?? null]));
  }

  /**
   * 已安裝：清單上的名稱 → { plugin, status, update? }。對不回清單的插件放在 `others`（網頁沒有卡片可畫，只列名稱）。
   * `claude plugin list` 要一兩秒，5 秒內再問就用上一次的。
   */
  let installedCache;
  async function installed(fresh = false) {
    if (!fresh && installedCache && now() - installedCache.at < 5000) return installedCache.body;
    const state = await installedState({ home, run: runClaude });
    const entries = [...byName.values()];
    const items = {}, others = [];
    for (const p of state.plugins) {
      const entry = matchEntry(p.source, entries);
      if (!entry) { others.push({ plugin: p.plugin, status: p.status }); continue; }
      const update = newerVersion(p.source, entry);
      items[entry.name] = { plugin: p.plugin, status: p.status, version: p.source.version, ...(update ? { update } : {}) };
    }
    // 下載過、還沒用市場轉換或安裝的 npm 插件：下載的是哪一版、清單上有沒有更新的版本。
    const downloads = {};
    for (const d of await listDownloads(home)) {
      const entry = byName.get(d.name);
      if (!entry || items[entry.name]) continue;
      const update = newerVersion({ origin: `npm:${d.name}`, version: d.version }, entry);
      downloads[entry.name] = { version: d.version, ...(update ? { update } : {}) };
    }
    const body = { known: state.known, ...(state.error ? { error: state.error } : {}), items, others, downloads };
    installedCache = { at: now(), body };
    return body;
  }

  let managing = false;
  async function manageRequest(body) {
    if (managing) return fail(409, 'msg.manageBusy', '上一個安裝、啟用、停用或移除還沒完成。');
    if (!['install', 'enable', 'disable', 'remove', 'delete'].includes(body?.action) || typeof body?.name !== 'string') return fail(400, 'msg.badAction', '不認得的動作');
    managing = true;
    try {
      const now = await installed(true);
      // 刪除：只刪下載過、還沒安裝的原始碼（連同掃描報告和補寫的資料夾）
      if (body.action === 'delete') {
        if (!now.downloads[body.name]) return fail(404, 'msg.notDownloaded', '這個插件沒有下載過，或已經安裝了');
        await deleteDownloads(home, body.name);
        return { status: 200, body: { ok: true, installed: await installed(true) } };
      }
      const item = now.items[body.name];
      if (!item) return fail(404, 'msg.notFromMarket', '這個插件沒有用市場轉換或安裝過');
      if (item.status === 'unknown') return fail(409, 'msg.installedUnknown', `讀不到 Claude Code 的安裝清單，不知道這個插件有沒有裝，先不動它：${now.error ?? ''}`, { error: now.error ?? '' });
      const result = await manage({ home, run: runClaude, action: body.action, plugin: item.plugin, status: item.status });
      return { status: 200, body: { ...result, installed: await installed(true) } };
    } finally {
      managing = false;
    }
  }

  async function favoriteRequest(body) {
    if (typeof body?.name !== 'string' || typeof body?.on !== 'boolean') return fail(400, 'msg.badFavorite', '收藏的格式不對');
    if (body.on && !byName.has(body.name)) return fail(404, 'msg.notInList', '清單裡沒有這個插件');
    return { status: 200, body: { names: await setFavorite(home, body.name, body.on) } };
  }

  const publicJob = j => ({ id: j.id, action: j.action, name: j.name, version: j.version, title: j.title, phase: j.phase, text: j.text, code: j.code, params: j.params, path: j.path, markdown: j.markdown, query: j.query, results: j.results, created: j.created });

  /** Haiku 搜尋：使用者在搜尋框寫的描述排進佇列，同一時間只跑一個。 */
  function addSearch(body, active) {
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query || query.length > AI_QUERY_MAX) return fail(400, 'msg.aiQueryLength', `描述要寫 1 到 ${AI_QUERY_MAX} 個字`, { max: AI_QUERY_MAX });
    if (active.some(j => j.action === 'ai-search')) return fail(409, 'msg.aiBusy', '上一個 Haiku 搜尋還沒完成。');
    const lang = LANG_CODES.has(body.lang) ? body.lang : 'zh-Hant';
    const job = { id: String(++seq), action: 'ai-search', query, lang, phase: 'queued', text: '等待 Claude Code 接手…', code: 'msg.job.queued', created: now() };
    jobs.set(job.id, job);
    return { status: 200, body: publicJob(job) };
  }

  /**
   * Haiku 想好的關鍵字拿來在清單裡找候選，最多回傳 AI_CANDIDATES 個，交給 Haiku 從裡面挑。
   * 關鍵字依意思分組（同一組是同一個意思的不同說法，例如 discord、dc），第一組是最重要的意思。
   * 每個詞的分數：越少插件有的詞越高（discord 只有十幾個插件有，chat、bot 有幾百個），名稱、標題對到再乘 1.5；
   * 一組只算分數最高的那個詞，同義詞不會重複加分；第一組再乘 2。
   * 英文詞要從詞頭對起，3 個字母以內的要整個詞對到（ds 不算對到 dsh）。說明只帶前 160 字，分類照清單寫的。
   */
  function candidates(keywords) {
    const clean = list => [...new Set(list.filter(k => typeof k === 'string').map(k => fold(k).trim()).filter(k => k && k.length <= 40))];
    // 一個字串是一組；一個陣列是一組同義詞
    const groups = (Array.isArray(keywords) ? keywords : []).map(g => clean(Array.isArray(g) ? g.slice(0, 12) : [g])).filter(g => g.length).slice(0, 10);
    if (!groups.length) return [];
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 含中日韓文字的詞不管空白：作者常寫「B 站」，關鍵字是「b站」也要對到。
    const squeeze = text => text.replace(/\s+/g, '');
    const matcher = t => (/^[a-z0-9][a-z0-9 .+#-]*$/.test(t)
      ? (re => d => re.test(d))(new RegExp(`(?:^|[^a-z0-9])${escape(t)}${t.length <= 3 ? '(?![a-z0-9])' : ''}`))
      : (s => d => squeeze(d).includes(s))(squeeze(t)));
    const docs = [...byName.values()].map(e => ({
      e,
      head: fold([e.name, e.title].join(' | ')),
      body: fold([e.description, e.category, ...(e.keywords ?? [])].join(' | ')),
    }));
    // 每一組、每個插件的分數：組裡分數最高的詞
    const groupScores = groups.map((terms, g) => {
      const best = new Float64Array(docs.length);
      for (const t of terms) {
        const match = matcher(t);
        const hits = docs.map(d => (match(d.head) ? 1.5 : match(d.body) ? 1 : 0));
        const df = hits.filter(Boolean).length;
        if (!df) continue;
        const weight = Math.log(docs.length / df) * (g === 0 ? 2 : 1);
        hits.forEach((hit, i) => { best[i] = Math.max(best[i], hit * weight); });
      }
      return best;
    });
    const scored = [];
    docs.forEach((d, i) => {
      const score = groupScores.reduce((sum, best) => sum + best[i], 0);
      if (score > 0) scored.push([score, d.e]);
    });
    scored.sort((a, b) => b[0] - a[0] || (b[1].downloads ?? b[1].downloadsRange ?? 0) - (a[1].downloads ?? a[1].downloadsRange ?? 0));
    return scored.slice(0, AI_CANDIDATES).map(([, e]) => ({ name: e.name, title: e.title, description: e.description.slice(0, 160), category: e.category || '' }));
  }

  /** 網頁送來的請求：只接受清單裡有的插件與版本，來源寫法由這裡依清單產生，不用網頁給的。 */
  function addJob(body) {
    const active = [...jobs.values()].filter(j => j.phase === 'queued' || j.phase === 'running');
    if (active.length >= 10) return fail(429, 'msg.queueFull', '排隊的工作太多了，請等前面的完成。');
    if (body?.action === 'open-folder') {
      const done = jobs.get(String(body.job));
      if (!done?.path) return fail(400, 'msg.noFolder', '這個工作沒有資料夾可以開');
      const job = { id: String(++seq), action: 'open-folder', name: done.name, version: done.version, title: done.title, path: done.path, phase: 'queued', text: '等待 Claude Code 接手…', code: 'msg.job.queued', created: now() };
      jobs.set(job.id, job);
      return { status: 200, body: publicJob(job) };
    }
    if (body?.action === 'ai-search') return addSearch(body, active);
    if (!ACTIONS.has(body?.action)) return fail(400, 'msg.badAction', '不認得的動作');
    const { entry, picked } = lookup(body.name, body.version);
    if (!entry || !picked) return fail(404, 'msg.noSuchVersion', '清單裡沒有這個插件或版本');
    if (!canFetch(picked)) return fail(400, 'msg.releaseOnly', '這個插件用 GitHub 發布檔安裝，轉換器還不能下載');
    if (active.some(j => j.name === entry.name && j.action === body.action)) return fail(409, 'msg.sameJobRunning', '這個插件的同一個動作已經在進行了');
    if ((body.action === 'scan' || body.action === 'download') && active.some(j => j.action === 'scan' || j.action === 'download')) return fail(409, 'msg.fetchBusy', '另一個下載或掃描還沒完成，完成後才能開始新的。');
    const { spec, packageDir } = sourceSpec(entry, picked);
    const job = { id: String(++seq), action: body.action, name: entry.name, version: picked.version, title: entry.title, spec, packageDir, phase: 'queued', text: '等待 Claude Code 接手…', code: 'msg.job.queued', created: now() };
    jobs.set(job.id, job);
    return { status: 200, body: publicJob(job) };
  }

  /** 外掛來拿排隊中的工作；拿走的標成進行中。 */
  function take() {
    const taken = [...jobs.values()].filter(j => j.phase === 'queued');
    for (const j of taken) { j.phase = 'running'; j.text = RUNNING_TEXT[j.action]; j.code = `msg.job.${j.action}`; }
    return taken.map(j => ({ id: j.id, action: j.action, name: j.name, version: j.version, title: j.title, spec: j.spec, packageDir: j.packageDir, path: j.path, query: j.query, lang: j.lang }));
  }

  /** 外掛回報工作結果，網頁輪詢時看到。 */
  function report(update) {
    const j = jobs.get(String(update?.id));
    if (!j || !['running', 'done', 'error'].includes(update.phase)) return false;
    j.phase = update.phase;
    j.text = clip(update.text, 4000) ?? j.text;
    j.code = typeof update.code === 'string' && MESSAGE_CODE.test(update.code) ? update.code : undefined;
    j.params = j.code ? cleanParams(update.params) : undefined;
    if (typeof update.path === 'string') j.path = update.path.slice(0, 1000);
    if (typeof update.markdown === 'string') j.markdown = update.markdown.slice(0, 200_000);
    // Haiku 搜尋的結果：只留清單裡真的有的插件，理由是純文字
    if (j.action === 'ai-search' && Array.isArray(update.results)) {
      j.results = update.results.filter(r => typeof r?.name === 'string' && byName.has(r.name)).slice(0, AI_RESULTS_MAX).map(r => ({ name: r.name, reason: clip(r.reason, 300) ?? '' }));
    }
    return true;
  }

  const sameKey = value => typeof value === 'string' && value.length === token.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token));

  function send(req, res, status, body, type = 'application/json; charset=utf-8') {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const headers = {
      'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin', 'x-frame-options': 'DENY', 'content-security-policy': CSP,
    };
    if (raw.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
      res.writeHead(status, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
      res.end(zlib.gzipSync(raw));
    } else {
      res.writeHead(status, headers);
      res.end(raw);
    }
  }

  async function readBody(req) {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('只接受 JSON'), { status: 415, code: 'msg.jsonOnly' });
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw Object.assign(new Error('請求太大'), { status: 413, code: 'msg.tooLarge' }); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  }

  async function handle(req, res) {
    // 只回應用 127.0.0.1:<這個埠> 連進來的請求，擋掉把別的網域指到本機的手法（DNS rebinding）。
    if (req.headers.host !== host) return send(req, res, 421, { error: '只接受 127.0.0.1 的請求', code: 'msg.localOnly' });
    const url = new URL(req.url ?? '/', origin);
    if (req.method === 'GET' && Object.hasOwn(STATIC, url.pathname)) {
      const [file, type] = STATIC[url.pathname];
      return send(req, res, 200, await fs.readFile(path.join(webDir, file)), type);
    }
    if (!url.pathname.startsWith('/api/')) return send(req, res, 404, { error: '找不到', code: 'msg.notFound' });
    // 資料與動作都要帶存取鑰匙；其他網頁拿不到鑰匙，也不能從別的網域送請求過來。
    if (!sameKey(req.headers['x-dsh-access'])) return send(req, res, 403, { error: '存取鑰匙不對。請在 Claude Code 輸入 /d-sh-are-in-cc-market 重新打開市場。', code: 'msg.badKey' });
    if (req.headers.origin && req.headers.origin !== origin) return send(req, res, 403, { error: '只接受市場頁面自己的請求', code: 'msg.pageOnly' });
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return send(req, res, 403, { error: '只接受市場頁面自己的請求', code: 'msg.pageOnly' });

    if (req.method === 'GET' && url.pathname === '/api/catalog') {
      if (url.searchParams.get('refresh') === '1' || state.phase === 'idle') await loadCatalog();
      else if (loading && !byName.size) await loading;
      const meta = { phase: state.phase, error: state.error, errorCode: state.errorCode, sources: state.sources, readAt: state.readAt, markets: MARKETS };
      return send(req, res, 200, `{"meta":${JSON.stringify(meta)},${catalogBody().slice(1)}`);
    }
    if (req.method === 'GET' && url.pathname === '/api/readme') {
      const { status, body } = await readme(url.searchParams.get('name'), url.searchParams.get('version'));
      return send(req, res, status, body);
    }
    if (req.method === 'GET' && url.pathname === '/api/downloads') {
      return send(req, res, 200, { counts: await downloads((url.searchParams.get('names') ?? '').split(',').filter(Boolean)) });
    }
    if (req.method === 'GET' && url.pathname === '/api/icons') {
      return send(req, res, 200, { icons: await npmIcons((url.searchParams.get('names') ?? '').split(',').filter(Boolean)) });
    }
    if (req.method === 'GET' && url.pathname === '/api/installed') {
      if (loading && !byName.size) await loading;
      return send(req, res, 200, await installed(url.searchParams.get('fresh') === '1'));
    }
    if (req.method === 'POST' && url.pathname === '/api/manage') {
      const { status, body } = await manageRequest(await readBody(req));
      return send(req, res, status, body);
    }
    if (req.method === 'GET' && url.pathname === '/api/favorites') {
      return send(req, res, 200, { names: await readFavorites(home) });
    }
    if (req.method === 'POST' && url.pathname === '/api/favorites') {
      const { status, body } = await favoriteRequest(await readBody(req));
      return send(req, res, status, body);
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      return send(req, res, 200, { jobs: [...jobs.values()].slice(-30).map(publicJob) });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const { status, body } = addJob(await readBody(req));
      return send(req, res, status, body);
    }
    return send(req, res, 404, { error: '找不到', code: 'msg.notFound' });
  }

  return {
    /** 啟動網站（已啟動就沿用），回傳帶存取鑰匙的網址，並在背景讀清單。 */
    async open() {
      if (!server) {
        server = http.createServer((req, res) => {
          handle(req, res).catch(cause => { if (!res.headersSent) send(req, res, cause?.status ?? 500, { error: message(cause), ...(cause?.code?.startsWith?.('msg.') ? { code: cause.code } : {}) }); else res.destroy(); });
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        host = `127.0.0.1:${server.address().port}`;
        origin = `http://${host}`;
      }
      if (state.phase === 'idle') void loadCatalog();
      return { url: `${origin}/#access=${token}` };
    },
    take,
    report,
    candidates,
    /** 網站打開了沒：沒打開時外掛不用每秒來問。 */
    get opened() { return Boolean(server); },
    close: () => new Promise(resolve => (server ? server.close(() => resolve()) : resolve())),
    /** 測試用：網址與鑰匙。 */
    get origin() { return origin; },
    get token() { return token; },
  };
}
