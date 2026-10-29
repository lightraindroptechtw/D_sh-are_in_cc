// DSH 插件市場網頁：清單在瀏覽器裡搜尋、篩選、排序；動作（審查並安裝、腳本安全掃描、只下載）送給本機網站排隊，
// 由 Claude Code 裡的外掛接手。畫面上的文字一律用 textContent 放進去，只有自述文件經 markdown.js 轉成安全的 HTML。
// 介面文字有 9 種語言，放在 i18n.js；插件清單的內容（說明、分類、自述文件）是作者寫的，原樣顯示。
import { renderMarkdown, setImageLabel } from './markdown.js';
import { t, tParts, hasKey, LANGS, lang, langInfo, setLang } from './i18n.js';

setImageLabel(alt => t('md.image', { alt }));

// 存取鑰匙在網址 # 後面：讀進來後從網址拿掉，只留在這個分頁的 sessionStorage。
const KEY = (() => {
  const match = /(?:^#|&)access=([a-f0-9]{64})\b/.exec(location.hash);
  if (match) {
    try { sessionStorage.setItem('dsh-access', match[1]); } catch { /* 沒有 sessionStorage 時只留在記憶體 */ }
    history.replaceState(null, '', location.pathname);
    return match[1];
  }
  try { return sessionStorage.getItem('dsh-access') ?? ''; } catch { return ''; }
})();

const PAGE = 48;
const state = {
  entries: [], meta: null, q: '', category: '', market: '', kind: '', sort: 'updated', page: 1,
  counts: new Map(), asking: new Set(), icons: new Map(), askingIcons: new Set(), readmes: new Map(), selected: null, version: null, jobs: [], polling: null,
  filterOpen: false, langOpen: false,
  // 已安裝：清單名稱 → { plugin, status: 'converted' | 'enabled' | 'disabled', version, update? }；view 是工具列上按下的「已安裝」或「收藏」
  installed: {}, favorites: new Set(), view: '', busy: new Map(), confirmRemove: null, confirmLeft: 0,
  // 下載過、還沒安裝的：清單名稱 → { version, update? }（漏斗「分類」裡的「已下載未安裝」）
  downloads: {},
  // Haiku 搜尋：{ id, query, phase: 'running' | 'done' | 'error', results, error }；null 時顯示一般的清單
  ai: null,
};
const $ = id => document.getElementById(id);
// 漏斗「分類」裡的「已下載未安裝」：不是清單上的分類，用不會跟分類代號重複的值。

/** 建立元素：屬性用 setAttribute，文字一律是文字節點；`on` 開頭的是事件。 */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}

async function api(path, init = {}) {
  let response;
  try {
    response = await fetch(path, { ...init, headers: { 'x-dsh-access': KEY, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  } catch {
    // 連不上：多半是 Claude Code 重新啟動或重新載入插件，本機網站換了網址，這一頁還停在舊網址。
    throw new Error(t('offline'));
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(message(body.code, body.params, body.error ?? `HTTP ${response.status}`));
  return body;
}

/**
 * 伺服器或外掛送來的訊息：有網頁認得的代碼（msg.*）就照介面語言顯示，否則顯示原文。
 * 參數 action 是動作代號，換成介面語言的動作名稱。
 */
function message(code, params, fallback) {
  if (typeof code !== 'string' || !hasKey(code)) return fallback ?? '';
  const vars = { ...(params ?? {}) };
  if (typeof vars.action === 'string') vars.action = t(['download', 'scan'].includes(vars.action) ? `act.${vars.action}` : `manage.${vars.action}`);
  return t(code, vars);
}
const jobText = job => message(job.code, job.params, job.text);

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

const fold = text => String(text ?? '').normalize('NFKC').toLocaleLowerCase();
const hash = text => [...text].reduce((n, c) => (n * 31 + c.codePointAt(0)) >>> 0, 7);
const initial = entry => ([...entry.title.replace(/^[@\s]+/, '')][0] ?? '?').toUpperCase();
// 數字依介面語言寫（1.2萬、1.2万、1.2만、12K…），一律用阿拉伯數字。
const formatNumber = n => new Intl.NumberFormat(lang(), { numberingSystem: 'latn' }).format(n);
const formatCount = n => (n >= 10000 ? new Intl.NumberFormat(lang(), { notation: 'compact', maximumFractionDigits: 1, numberingSystem: 'latn' }).format(n) : formatNumber(n));
const formatDate = seconds => {
  if (!seconds) return t('date.unknown');
  const d = new Date(seconds < 1e11 ? seconds * 1000 : seconds);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const formatTime = ms => (ms ? `${formatDate(ms)} ${new Date(ms).toTimeString().slice(0, 5)}` : t('time.unknown'));
// 只依分類名稱推測，不是實測：改 DSH 畫面、外觀、接入模型、用量的插件，轉到 Claude Code 多半用不了。
const limitedGuess = entry => /UI|界面|介面|外[观觀]|主[题題]|appearance|interface|theme|模型|provider|用量|usage|billing/i.test(entry.category);
/** 分類名稱照介面語言：合併後的分類有翻好的名稱（cat.代號）；清單新增、還沒翻的分類照清單寫的。 */
const catName = entry => { const key = `cat.${entry.categoryId}`; const name = t(key); return name !== key ? name : entry.category; };
const kindOf = entry => entry.versions[0]?.type ?? 'npm';
const canFetch = version => version && version.type !== 'release';
const marketOf = id => state.meta?.markets.find(m => m.id === id);
/** 社群清單的名稱：認得的兩份用翻好的名稱，其他照網站給的。 */
const marketName = (id, short = false) => {
  const key = `market.${id}${short ? '.short' : ''}`;
  const name = t(key);
  return name !== key ? name : (marketOf(id)?.[short ? 'short' : 'title'] ?? id);
};
const downloadsOf = entry => state.counts.get(entry.name)?.downloads ?? entry.downloads;

const iconOf = entry => entry.icon ?? state.icons.get(entry.name) ?? undefined;

/** 有圖示就蓋在首字母上面；圖片讀不到就拿掉，露出底下的首字母。 */
function avatar(entry, big = false) {
  const url = iconOf(entry);
  const img = url ? h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }) : null;
  img?.addEventListener('error', () => img.remove(), { once: true });
  return h('div', { class: `avatar g${hash(entry.name) % 8}${big ? ' big' : ''}`, 'aria-hidden': 'true' }, initial(entry), img);
}

const STATUS_TONE = { converted: 'warn', enabled: 'ok', disabled: '', unknown: 'warn' };

/** 有顏色的標籤：安裝狀態、分類、只能在 DSH 用、安裝方式。 */
function tags(entry) {
  const list = [];
  const mine = state.installed[entry.name];
  if (mine) list.push([STATUS_TONE[mine.status], t(`status.${mine.status}`)]);
  if (entry.category) list.push(['accent', catName(entry)]);
  if (limitedGuess(entry)) list.push(['warn', t('tag.limited')]);
  if (kindOf(entry) === 'release') list.push(['warn', t('tag.release')]);
  else if (kindOf(entry) === 'git') list.push(['', 'GitHub']);
  return list;
}

/** 數字資料：下載次數、星數、更新日期。 */
function numbers(entry, { full = false } = {}) {
  const list = [];
  const count = downloadsOf(entry);
  if (count !== undefined) list.push(t('num.downloads30', { n: formatCount(count) }));
  else if (entry.downloadsRange !== undefined) list.push(`↓ ${formatCount(entry.downloadsRange)}+`);
  if (entry.stars !== undefined) list.push(`★ ${formatCount(entry.stars)}`);
  if (full || entry.updated) list.push(full ? t('num.updated', { date: formatDate(entry.updated) }) : formatDate(entry.updated));
  return list;
}

const sourceTag = entry => ['', t('tag.source', { list: entry.markets.map(id => marketName(id, true)).join(t('list.sep')) })];

/** 詳情頁：全部做成標籤，加上清單來源。 */
function pills(entry) {
  const list = [...tags(entry), sourceTag(entry), ...numbers(entry, { full: true }).map(label => ['', label])];
  return h('div', { class: 'pills' }, list.map(([tone, label]) => h('span', { class: `pill ${tone}` }, label)));
}

/** 卡片：標籤一排（有顏色的標籤加上清單來源），數字資料一行小字，卡片才不會被標籤撐高。 */
function cardMeta(entry) {
  const list = [...tags(entry), sourceTag(entry)];
  return [
    h('div', { class: 'pills' }, list.map(([tone, label]) => h('span', { class: `pill ${tone}` }, label))),
    h('p', { class: 'meta', title: t('meta.tip') }, numbers(entry).join(' · ')),
  ];
}

/** 卡片標題：名稱開頭和作者重複時（作者/名稱）只留名稱，作者已經寫在下面一行。 */
const shortTitle = entry => (entry.author && entry.title.startsWith(`${entry.author}/`) ? entry.title.slice(entry.author.length + 1) : entry.title);

// ── 篩選與排序 ──
function filtered() {
  const terms = fold(state.q).split(/\s+/).filter(Boolean);
  const list = state.entries.filter(e =>
    (state.view !== 'installed' || state.installed[e.name]) &&
    (state.view !== 'notInstalled' || !state.installed[e.name]) &&
    (state.view !== 'favorites' || state.favorites.has(e.name)) &&
    (state.view !== 'downloaded' || state.downloads[e.name]) &&
    (!state.category || e.categoryId === state.category) &&
    (!state.market || e.markets.includes(state.market)) &&
    (!state.kind || kindOf(e) === state.kind) &&
    (!terms.length || terms.every(t => e.haystack.includes(t))));
  const by = {
    updated: (a, b) => b.updated - a.updated,
    downloads: (a, b) => (downloadsOf(b) ?? b.downloadsRange ?? -1) - (downloadsOf(a) ?? a.downloadsRange ?? -1),
    stars: (a, b) => (b.stars ?? -1) - (a.stars ?? -1),
    name: (a, b) => a.title.localeCompare(b.title, lang()),
  }[state.sort];
  return list.sort((a, b) => by(a, b) || b.updated - a.updated);
}

function render() {
  if (state.ai) return renderAi();
  const list = filtered();
  // 一般清單不顯示「找到幾個插件」；這一格只在 Haiku 搜尋時顯示進度和結果。
  $('count').replaceChildren();
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  state.page = Math.min(state.page, pages);
  const visible = list.slice((state.page - 1) * PAGE, state.page * PAGE);
  const empty = !state.entries.length ? t('grid.loading') : state.view === 'installed' ? t('grid.emptyInstalled') : state.view === 'favorites' ? t('grid.emptyFavorites') : t('grid.empty');
  $('grid').replaceChildren(...(visible.length ? visible.map(e => card(e)) : [h('div', { class: 'empty' }, empty)]));
  renderPager(pages);
  void loadCounts(visible);
  void loadIcons(visible);
  renderFilters();
}

function card(entry, reason) {
  const latest = entry.versions[0];
  const mine = state.installed[entry.name];
  return h('article', { class: 'card', tabindex: '0', onClick: () => openDetail(entry.name), onKeydown: e => { if (e.key === 'Enter' && e.target === e.currentTarget) openDetail(entry.name); } },
    h('div', { class: 'card-head' }, avatar(entry),
      h('div', { class: 'titles' }, h('h3', { title: entry.title, dir: 'auto' }, shortTitle(entry)), h('p', { class: 'byline' }, [entry.author, latest && !latest.floating ? `v${latest.version}` : null].filter(Boolean).join(' · ') || entry.name)),
      starButton(entry)),
    h('p', { class: 'desc', dir: 'auto' }, entry.description || t('desc.none')),
    reason ? h('p', { class: 'ai-reason', dir: 'auto' }, t('ai.reason', { r: reason })) : null,
    cardMeta(entry),
    !mine && state.downloads[entry.name] ? h('p', { class: 'muted downloaded' }, downloadedText(state.downloads[entry.name])) : null,
    h('div', { class: 'card-actions' },
      mine ? manageButtons(entry, mine, 'small')
        : canFetch(latest) ? h('button', { class: 'ghost small', type: 'button', onClick: e => { e.stopPropagation(); void startJob('review', entry, latest); } }, t('card.review')) : null,
      !mine && state.downloads[entry.name] ? manageButton('delete', entry, 'ghost', 'small') : null,
      h('button', { class: 'primary small', type: 'button', onClick: e => { e.stopPropagation(); openDetail(entry.name); } }, t('card.details'))));
}

/** 收藏的星號：卡片右上角，和插件頁右上角的關閉按鈕旁邊。 */
function starButton(entry) {
  const on = state.favorites.has(entry.name);
  const label = t(on ? 'fav.remove' : 'fav.add');
  return h('button', { class: `star${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on), 'aria-label': label, title: label, onClick: e => { e.stopPropagation(); void toggleFavorite(entry); } },
    starIcon());
}

/** 圓角的星星（和工具列「收藏」的圖示同一個形狀）；收藏了就填滿，由 CSS 決定。 */
function starIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'm12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z');
  svg.append(path);
  return svg;
}

/**
 * 用市場轉換或安裝過的插件，「審查並安裝」換成管理按鈕：已轉換未安裝的是安裝、移除；裝好的是停用或啟用、移除；
 * 清單上有比裝的新的固定版本時多一個「更新」（重新審查並轉換，交給 Claude）。移除要按兩次。
 */
function manageButtons(entry, mine, size = '') {
  // 讀不到安裝清單時不知道有沒有裝，不給管理按鈕，免得按了做錯事
  if (mine.status === 'unknown') return [];
  const busy = state.busy.get(entry.name);
  const button = (action, tone) => manageButton(action, entry, tone, size);
  const main = mine.status === 'converted' ? 'install' : mine.status === 'enabled' ? 'disable' : 'enable';
  const update = mine.update ? entry.versions.find(v => v.version === mine.update) : undefined;
  return [
    update ? h('button', { class: `ghost ${size} update`.trim(), type: 'button', disabled: Boolean(busy), title: t('manage.update.tip'), onClick: e => { e.stopPropagation(); void startJob('review', entry, update); } }, t('manage.update', { v: update.version })) : null,
    button(main, 'ghost'),
    button('remove', 'ghost'),
  ];
}

/** 一個管理按鈕。移除和刪除要按兩次：第一次變成「確定移除？(秒數)」或「確定刪除？(秒數)」。 */
function manageButton(action, entry, tone, size = '') {
  const busy = state.busy.get(entry.name);
  const confirming = (action === 'remove' || action === 'delete') && state.confirmRemove === `${action}:${entry.name}`;
  const label = busy === action ? t('manage.running') : confirming ? t(`manage.${action}Confirm`, { s: state.confirmLeft }) : t(`manage.${action}`);
  return h('button', { class: `${confirming ? 'danger' : tone} ${size}`.trim(), type: 'button', disabled: Boolean(busy), onClick: e => { e.stopPropagation(); void manageAction(action, entry); } },
    busy === action ? h('span', { class: 'spin' }) : null, label);
}

/** 下載的版本；清單上有更新的版本時一起寫出來（舊的下載沒有審查價值，再審查會下載新版）。 */
const downloadedText = d => (d.update ? t('downloaded.newer', { v: d.version, latest: d.update }) : t('downloaded.version', { v: d.version }));

/** 篩選面板裡的一個選項：按下改 state[key]，n 是有幾個。 */
const chip = (key, value, label, n) => h('button', { class: `chip${state[key] === value ? ' on' : ''}`, type: 'button', 'aria-pressed': String(state[key] === value), onClick: () => setFilter({ [key]: value }, false) },
  label, n !== undefined ? h('span', { class: 'n' }, formatNumber(n)) : null);

/** 漏斗裡的篩選：狀態（已安裝、未安裝、已下載未安裝、收藏）放最上面，接著分類（多的時候換行排）、清單、安裝方式。 */
function renderFilters() {
  const installed = state.entries.filter(e => state.installed[e.name]).length;
  const views = [['installed', t('view.installed'), installed], ['notInstalled', t('view.notInstalled'), state.entries.length - installed], ['downloaded', t('filter.downloaded'), Object.keys(state.downloads).length], ['favorites', t('view.favorites'), state.favorites.size]];
  const counts = new Map();
  const names = new Map();
  for (const e of state.entries) if (e.categoryId) { counts.set(e.categoryId, (counts.get(e.categoryId) ?? 0) + 1); names.set(e.categoryId, catName(e)); }
  const cats = [...counts].sort((a, b) => b[1] - a[1]);
  const meta = state.meta;
  const active = [state.view, state.category, state.market, state.kind].filter(Boolean).length;
  $('filter').classList.toggle('on', active > 0);
  $('filter').setAttribute('aria-expanded', String(state.filterOpen));
  $('filter-panel').hidden = !state.filterOpen;
  $('filter-panel').replaceChildren(
    h('section', {}, h('h2', {}, t('filter.status')), h('div', { class: 'seg' }, chip('view', '', t('all')), views.map(([view, label, n]) => chip('view', view, label, n)))),
    h('section', {}, h('h2', {}, t('filter.category')), h('div', { class: 'seg cats' }, chip('category', '', t('all'), state.entries.length), cats.map(([id, n]) => chip('category', id, names.get(id), n)))),
    h('section', {}, h('h2', {}, t('filter.lists')), h('div', { class: 'seg' }, chip('market', '', t('all')), (meta?.markets ?? []).map(m => chip('market', m.id, marketName(m.id, true))))),
    h('section', {}, h('h2', {}, t('filter.kind')), h('div', { class: 'seg' }, chip('kind', '', t('all')), chip('kind', 'npm', 'npm'), chip('kind', 'git', 'GitHub'), chip('kind', 'release', t('kind.release')))),
    ...(active ? [h('button', { class: 'ghost small', type: 'button', onClick: () => setFilter({ view: '', category: '', market: '', kind: '' }, false) }, t('filter.clear'))] : []));
}

function setFilterOpen(open) {
  state.filterOpen = open;
  renderFilters();
}
// ── 介面語言 ──
/** 換掉 index.html 裡寫死的文字：data-i18n 是內文，data-i18n-placeholder／-title／-aria-label 是屬性。 */
function applyStatic() {
  const info = langInfo();
  document.documentElement.lang = info.code;
  document.documentElement.dir = info.dir ?? 'ltr';
  document.title = t('app.title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const attr of ['placeholder', 'title', 'aria-label', 'data-tip']) {
    for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
  }
  $('lang-name').textContent = info.name;
}

function renderLangPanel() {
  $('lang').setAttribute('aria-expanded', String(state.langOpen));
  $('lang-panel').hidden = !state.langOpen;
  $('lang-panel').replaceChildren(...LANGS.map(item => h('button', {
    class: item.code === lang() ? 'on' : '', type: 'button', role: 'menuitemradio', lang: item.code, dir: item.dir ?? 'ltr',
    'aria-checked': String(item.code === lang()), onClick: () => chooseLang(item.code),
  }, item.name)));
}

function setLangOpen(open) {
  state.langOpen = open;
  renderLangPanel();
}

/** 換語言：記住選擇，整個畫面重畫一次。 */
function chooseLang(code) {
  setLang(code);
  indexEntries();
  state.langOpen = false;
  applyStatic();
  renderLangPanel();
  renderSummary();
  render();
  renderJobs();
  if (state.selected) renderDetail();
}

/** 搜尋框下方的來源與著作權說明：每個社群清單的網站連結。 */
function renderOrigin() {
  $('origin-links').replaceChildren(...(state.meta?.markets ?? []).map(m =>
    h('a', { href: `https://${m.site}/`, target: '_blank', rel: 'noopener noreferrer' }, t('market.link', { name: marketName(m.id), site: m.site }))));
}

function renderSummary() {
  renderOrigin();
  const meta = state.meta;
  const stats = [h('span', { class: 'stat' }, ...tParts('summary.total', { n: h('b', {}, formatNumber(state.entries.length)) }))];
  for (const s of meta?.sources ?? []) {
    const stale = s.error && s.total !== undefined ? t('summary.stale', { time: formatTime(s.readAt) }) : '';
    stats.push(h('span', { class: `stat${s.error ? ' bad' : ''}`, title: s.error ? t('summary.failTip', { error: s.error }) : undefined }, `${marketName(s.id, true)} `, h('b', {}, s.total !== undefined ? formatNumber(s.total) : t('summary.unreadable')), stale));
  }
  if (meta?.readAt) stats.push(h('span', { class: 'stat' }, t('summary.readAt', { time: formatTime(meta.readAt) })));
  if (meta?.error && !state.entries.length) stats.push(h('span', { class: 'notice error' }, meta.noKey ? t('nokey') : t('summary.error', { error: message(meta.errorCode, null, meta.error).replace(/[。.]\s*$/, '') })));
  $('summary').replaceChildren(...stats);
}

/** 頁碼：上一頁、第一頁、目前頁前後各兩頁、最後一頁、下一頁；中間跳過的用「…」。 */
function renderPager(pages) {
  if (pages <= 1) return $('pager').replaceChildren();
  const current = state.page;
  const numbers = [...new Set([1, current - 2, current - 1, current, current + 1, current + 2, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
  const go = n => () => {
    state.page = n;
    render();
    $('toolbar').scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const items = [];
  numbers.forEach((n, i) => {
    if (i && n - numbers[i - 1] > 1) items.push(h('span', { class: 'gap' }, '…'));
    items.push(h('button', { class: `page${n === current ? ' on' : ''}`, type: 'button', 'aria-current': n === current ? 'page' : undefined, onClick: go(n) }, String(n)));
  });
  $('pager').replaceChildren(
    h('button', { class: 'page step', type: 'button', disabled: current === 1, onClick: go(current - 1) }, t('pager.prev')),
    ...items,
    h('button', { class: 'page step', type: 'button', disabled: current === pages, onClick: go(current + 1) }, t('pager.next')),
    h('span', { class: 'total' }, t('pager.total', { n: formatNumber(pages) })));
}

// ── Haiku 搜尋 ──
/** 把搜尋框的描述交給 Claude Code 裡的外掛，由 Haiku 想關鍵字、從清單挑插件。 */
async function startAiSearch() {
  const query = $('q').value.trim();
  if (!query) { toast(t('ai.needQuery')); $('q').focus(); return; }
  if (state.ai?.phase === 'running') return;
  try {
    const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ action: 'ai-search', query, lang: lang() }) });
    state.jobs.push(job);
    state.ai = { id: job.id, query, phase: 'running', results: [] };
    render();
    pollJobs();
  } catch (cause) {
    toast(cause.message);
  }
}

/** 輪詢拿到新的工作狀態時，更新 Haiku 搜尋的結果。 */
function syncAi() {
  const job = state.ai && state.jobs.find(j => j.id === state.ai.id);
  if (!job || job.phase === state.ai.phase) return;
  state.ai = { ...state.ai, phase: job.phase === 'error' ? 'error' : job.phase === 'done' ? 'done' : 'running', results: job.results ?? [], error: jobText(job) };
  render();
}

/** Haiku 搜尋的畫面：結果照 Haiku 排的順序，每張卡片多一行它寫的理由；不分頁。 */
function renderAi() {
  const ai = state.ai;
  const back = h('button', { class: 'ghost small', type: 'button', onClick: () => { state.ai = null; render(); } }, t('ai.back'));
  const picks = ai.phase === 'done' ? ai.results.map(r => [state.entries.find(e => e.name === r.name), r.reason]).filter(([e]) => e) : [];
  if (ai.phase === 'running') $('count').replaceChildren(h('span', { class: 'spin' }), ' ', t('ai.running', { q: ai.query }));
  else if (ai.phase === 'error') $('count').replaceChildren(t('ai.error', { error: ai.error ?? '' }), ' ', back);
  else $('count').replaceChildren(...(picks.length ? tParts('ai.count', { n: h('b', {}, formatNumber(picks.length)), q: ai.query }) : [t('ai.none', { q: ai.query })]), ' ', back);
  $('grid').replaceChildren(...(picks.length ? picks.map(([e, reason]) => card(e, reason)) : [h('div', { class: 'empty' }, ai.phase === 'running' ? t('ai.waitNote') : '')]));
  $('pager').replaceChildren();
  void loadCounts(picks.map(([e]) => e));
  void loadIcons(picks.map(([e]) => e));
  renderFilters();
}

/** 改篩選條件；在漏斗裡改的不捲回頁首，面板才不會跟著跑掉。改了條件就離開 Haiku 搜尋的結果。 */
function setFilter(change, scrollUp = true) {
  Object.assign(state, change, { page: 1, ai: null });
  render();
  if (scrollUp) window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── 讀資料 ──
/** 搜尋用的文字：名稱、標題、說明、作者、分類（清單寫的和介面語言的都算）。換語言時重做。 */
function indexEntries() {
  for (const e of state.entries) e.haystack = fold([e.name, e.title, e.description, e.author, e.category, catName(e)].join('\n'));
}

async function loadCatalog(refresh = false) {
  const button = $('refresh');
  button.disabled = true;
  button.textContent = t('refresh.loading');
  try {
    const body = await api(`/api/catalog${refresh ? '?refresh=1' : ''}`);
    state.meta = body.meta;
    state.entries = body.entries;
    indexEntries();
    renderSummary();
    render();
    if (state.selected) renderDetail();
  } catch (cause) {
    toast(t('toast.catalogError', { error: cause.message }));
    state.meta = { ...(state.meta ?? { markets: [], sources: [] }), error: cause.message };
    renderSummary();
  } finally {
    button.disabled = false;
    button.textContent = t('refresh');
  }
}

async function loadCounts(entries) {
  const names = entries.filter(e => kindOf(e) === 'npm' && !state.counts.has(e.name) && !state.asking.has(e.name)).map(e => e.name);
  if (!names.length) return;
  names.forEach(n => state.asking.add(n));
  try {
    const { counts } = await api(`/api/downloads?names=${encodeURIComponent(names.join(','))}`);
    for (const n of names) state.counts.set(n, counts[n] ?? null);
    for (const n of names) state.asking.delete(n);
    render();
    if (state.selected && names.includes(state.selected)) renderDetail();
  } catch {
    names.forEach(n => state.asking.delete(n));
  }
}

/** 清單沒有圖示的 npm 插件，向本機網站查套件自己寫的圖示；查到才重畫。 */
async function loadIcons(entries) {
  const names = entries.filter(e => !e.icon && kindOf(e) === 'npm' && !state.icons.has(e.name) && !state.askingIcons.has(e.name)).map(e => e.name);
  if (!names.length) return;
  names.forEach(n => state.askingIcons.add(n));
  try {
    const { icons } = await api(`/api/icons?names=${encodeURIComponent(names.join(','))}`);
    for (const n of names) state.icons.set(n, icons[n] ?? null);
    if (names.some(n => icons[n])) {
      render();
      if (state.selected && names.includes(state.selected)) renderDetail();
    }
  } catch {
    // 圖示只是裝飾，查不到就畫首字母。
  } finally {
    names.forEach(n => state.askingIcons.delete(n));
  }
}

/** 重畫清單和開著的插件頁（安裝狀態、收藏改變時）。 */
function redraw() {
  render();
  if (state.selected) renderDetail();
}

let installedWarned = false;
function applyInstalled(body) {
  state.installed = body.items ?? {};
  state.downloads = body.downloads ?? {};
  // 讀不到 Claude Code 的安裝清單時只提示一次；這時插件都先當成已轉換未安裝。
  if (body.known === false && !installedWarned) { installedWarned = true; toast(t('installed.unknown', { error: body.error ?? '' })); }
  redraw();
}

async function loadInstalled() {
  try {
    applyInstalled(await api('/api/installed'));
  } catch {
    // 讀不到就維持原樣，下次回到這個分頁再讀。
  }
}

async function loadFavorites() {
  try {
    const { names } = await api('/api/favorites');
    state.favorites = new Set(names);
    redraw();
  } catch {
    // 收藏讀不到就當成沒有。
  }
}

async function toggleFavorite(entry) {
  const on = !state.favorites.has(entry.name);
  try {
    const { names } = await api('/api/favorites', { method: 'POST', body: JSON.stringify({ name: entry.name, on }) });
    state.favorites = new Set(names);
    redraw();
  } catch (cause) {
    toast(cause.message);
  }
}

let confirmTimer;
const CONFIRM_SECONDS = 4;
/** 安裝、啟用、停用、移除：本機網站用 Claude Code 的 claude plugin 指令執行。移除第一次按只是確認，4 秒內再按才執行；按鈕上倒數剩幾秒。 */
async function manageAction(action, entry) {
  if (state.busy.size) return;
  const key = `${action}:${entry.name}`;
  if ((action === 'remove' || action === 'delete') && state.confirmRemove !== key) {
    state.confirmRemove = key;
    state.confirmLeft = CONFIRM_SECONDS;
    clearInterval(confirmTimer);
    confirmTimer = setInterval(() => {
      state.confirmLeft -= 1;
      if (state.confirmLeft <= 0) { clearInterval(confirmTimer); state.confirmRemove = null; }
      redraw();
    }, 1000);
    redraw();
    return;
  }
  clearInterval(confirmTimer);
  state.confirmRemove = null;
  state.busy.set(entry.name, action);
  redraw();
  try {
    const result = await api('/api/manage', { method: 'POST', body: JSON.stringify({ action, name: entry.name }) });
    toast(!result.ok ? message(result.code, result.params, result.text) : action === 'delete' ? t('manage.deleted', { name: entry.title }) : t(result.later ? 'manage.doneLater' : 'manage.done', { action: t(`manage.${action}`), name: entry.title }));
    state.busy.delete(entry.name);
    applyInstalled(result.installed);
  } catch (cause) {
    state.busy.delete(entry.name);
    toast(cause.message);
    redraw();
  }
}

// ── 插件頁 ──
function openDetail(name) {
  const entry = state.entries.find(e => e.name === name);
  if (!entry) return;
  state.selected = name;
  state.version = entry.versions[0]?.version ?? null;
  $('drawer').hidden = false;
  document.body.style.overflow = 'hidden';
  renderDetail();
  void loadCounts([entry]);
  void loadIcons([entry]);
  $('drawer').querySelector('.close')?.focus();
}

function closeDetail() {
  state.selected = null;
  $('drawer').hidden = true;
  document.body.style.overflow = '';
}

function versionLabel(v) {
  if (v.type === 'release') return t('version.release', { date: formatDate(v.published) });
  if (v.floating) return v.type === 'npm' ? t('version.latestNpm') : t('version.latestGit');
  return t(v.type === 'git' ? 'version.git' : 'version.npm', { v: v.version, date: formatDate(v.published) });
}

function downloadsLine(entry) {
  const npm = state.counts.get(entry.name);
  const parts = [];
  if (npm) parts.push(t('dl.npm', { n: formatNumber(npm.downloads), start: npm.start, end: npm.end }));
  else if (kindOf(entry) === 'npm') parts.push(state.counts.has(entry.name) ? t('dl.npmNone') : t('dl.npmLoading'));
  else parts.push(t('dl.github'));
  if (entry.downloads !== undefined && !npm) parts.push(t('dl.awesome', { n: formatNumber(entry.downloads) }));
  if (entry.downloadsRange !== undefined) parts.push(t('dl.open', { n: formatCount(entry.downloadsRange) }));
  return parts.join(t('dl.sep'));
}

// 本機網站會記住這次 Claude Code 啟動以來的所有工作；網頁只顯示還在跑的，和打開（或重新整理）這個網頁之後送出的。
// 之前已經結束的結果（例如舊的錯誤）不會在每次重新整理時又跳出來。
const PAGE_OPENED = Date.now();
const current = j => j.phase === 'queued' || j.phase === 'running' || (j.created ?? 0) >= PAGE_OPENED;

function jobFor(entry, version) {
  return [...state.jobs].reverse().find(j => current(j) && j.name === entry.name && j.version === version && j.action !== 'open-folder');
}

function renderDetail() {
  const entry = state.entries.find(e => e.name === state.selected);
  const panel = $('drawer').querySelector('.panel');
  if (!entry) { closeDetail(); return; }
  drawDetail(entry, panel);
}

function drawDetail(entry, panel) {
  const picked = entry.versions.find(v => v.version === state.version) ?? entry.versions[0];
  const job = picked ? jobFor(entry, picked.version) : undefined;
  const mine = state.installed[entry.name];
  const link = (href, label) => (href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label ?? href) : null);
  const marketNames = entry.markets.map(id => { const m = marketOf(id); return m ? t('market.link', { name: marketName(id), site: m.site }) : id; }).join(t('list.sep'));

  panel.replaceChildren(
    h('header', { class: 'hero' },
      // 右上角：收藏和關閉並排，一樣大小
      h('div', { class: 'hero-actions' },
        starButton(entry),
        h('button', { class: 'close', type: 'button', 'aria-label': t('detail.close'), onClick: closeDetail }, '×')),
      h('div', { class: 'hero-row' }, avatar(entry, true),
        h('div', {}, h('h2', { id: 'd-title', dir: 'auto' }, entry.title), h('p', { class: 'byline' }, [entry.name, entry.author ? t('detail.author', { a: entry.author }) : null].filter(Boolean).join(' · ')))),
      pills(entry, { full: true })),
    h('div', { class: 'sections' },
      h('section', { class: 'box' },
        h('h3', {}, t('detail.intro')),
        h('p', { dir: 'auto' }, entry.description || t('desc.none')),
        limitedGuess(entry) ? h('p', { class: 'muted' }, t('detail.limited')) : null,
        h('dl', { class: 'facts' },
          h('dt', {}, t('detail.downloads')), h('dd', {}, downloadsLine(entry)),
          h('dt', {}, t('detail.lists')), h('dd', {}, t('detail.listsNote', { list: marketNames })),
          entry.homepage ? [h('dt', {}, t('detail.homepage')), h('dd', {}, link(entry.homepage))] : null,
          entry.repository && entry.repository !== entry.homepage ? [h('dt', {}, t('detail.repo')), h('dd', {}, link(entry.repository))] : null)),
      mine ? h('section', { class: 'box' },
        h('h3', {}, t('detail.manage')),
        h('p', { class: 'muted' }, mine.version ? t('detail.installedVersion', { status: t(`status.${mine.status}`), v: mine.version }) : t(`status.${mine.status}`)),
        h('div', { class: 'actions' }, manageButtons(entry, mine)))
      : state.downloads[entry.name] ? h('section', { class: 'box' },
        h('h3', {}, t('detail.manage')),
        h('p', { class: 'muted' }, downloadedText(state.downloads[entry.name])),
        h('div', { class: 'actions' }, manageButton('delete', entry, 'ghost'))) : null,
      h('section', { class: 'box' },
        h('h3', {}, t('detail.get')),
        h('div', { class: 'actions' },
          h('select', { 'aria-label': t('detail.version'), onChange: e => { state.version = e.target.value; renderDetail(); } },
            entry.versions.map(v => h('option', { value: v.version, selected: v.version === picked?.version }, versionLabel(v))))),
        canFetch(picked)
          ? h('div', { class: 'actions' },
              tipButton('primary', t('action.review'), t('action.review.tip'), () => void startJob('review', entry, picked)),
              tipButton('ghost', t('action.scan'), t('action.scan.tip'), () => void startJob('scan', entry, picked)),
              tipButton('ghost', t('action.download'), t('action.download.tip'), () => void startJob('download', entry, picked)))
          : h('div', { class: 'warnbox' }, t('detail.releaseWarn')),
        job ? jobStatus(job) : null),
      h('section', { class: 'box' }, h('h3', {}, t('detail.readme')), readmeView(entry, picked))));
}

/** 有說明的按鈕：說明在滑鼠移上去（或用鍵盤選到）時才顯示。 */
function tipButton(tone, label, tip, onClick) {
  return h('button', { class: `${tone} tip`, type: 'button', 'data-tip': tip, 'aria-description': tip, onClick }, label);
}

function jobStatus(job) {
  const running = job.phase === 'queued' || job.phase === 'running';
  return h('div', { class: `status ${job.phase}` },
    running ? h('span', { class: 'spin' }) : null,
    h('div', {},
      h('pre', {}, jobText(job)),
      job.path ? h('div', { class: 'row' },
        h('button', { class: 'ghost small', type: 'button', onClick: () => void openFolder(job) }, t('job.openFolder')),
        h('button', { class: 'ghost small', type: 'button', onClick: () => void copy(job.path) }, t('job.copyPath'))) : null,
      job.markdown ? markdownBox(job.markdown) : null));
}

/** 轉成安全 HTML 後放進一個區塊（見 markdown.js）。 */
function markdownBox(text, base = '') {
  const box = h('div', { class: 'markdown', dir: 'auto' });
  box.innerHTML = renderMarkdown(text, base);
  return box;
}

function readmeView(entry, picked) {
  if (!picked) return h('p', { class: 'muted' }, t('readme.noVersion'));
  const key = `${entry.name}@${picked.version}`;
  const readme = state.readmes.get(key);
  if (!readme) {
    state.readmes.set(key, { phase: 'loading' });
    api(`/api/readme?name=${encodeURIComponent(entry.name)}&version=${encodeURIComponent(picked.version)}`)
      .then(body => state.readmes.set(key, body))
      .catch(cause => state.readmes.set(key, { phase: 'error', error: cause.message }))
      .finally(() => { if (state.selected === entry.name) renderDetail(); });
    return h('p', { class: 'muted' }, t('readme.loading'));
  }
  if (readme.phase === 'loading') return h('p', { class: 'muted' }, t('readme.loading'));
  if (readme.phase === 'none') return h('p', { class: 'muted' }, t('readme.none'));
  if (readme.phase === 'error') return h('p', { class: 'muted' }, t('readme.error', { error: readme.error ?? t('readme.unknown') }));
  return [
    // 來源直接寫原始檔網址（看得出是 npm 套件還是 GitHub 倉庫、哪個版本），每種語言都一樣
    h('p', { class: 'readme-from' }, ...tParts('readme.from', { from: h('a', { href: readme.url, target: '_blank', rel: 'noopener noreferrer', dir: 'ltr' }, readme.url.replace(/^https:\/\//, '')) }), readme.truncated ? ` ${t('readme.truncated')}` : ''),
    markdownBox(readme.text, readme.base),
  ];
}

// ── 動作與工作 ──
/** `extra`：補寫多帶的模型和思考強度。 */
async function startJob(action, entry, picked) {
  try {
    const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ action, name: entry.name, version: picked.version }) });
    state.jobs.push(job);
    if (state.selected !== entry.name) openDetail(entry.name);
    renderJobs();
    renderDetail();
    pollJobs();
  } catch (cause) {
    toast(cause.message);
  }
}

async function openFolder(job) {
  try {
    await api('/api/jobs', { method: 'POST', body: JSON.stringify({ action: 'open-folder', job: job.id }) });
    pollJobs();
  } catch (cause) {
    toast(cause.message);
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('copy.done'));
  } catch {
    toast(t('copy.fail', { text }));
  }
}

function pollJobs() {
  if (state.polling) return;
  state.polling = setInterval(async () => {
    try {
      const { jobs } = await api('/api/jobs');
      const changed = JSON.stringify(jobs) !== JSON.stringify(state.jobs);
      state.jobs = jobs;
      if (changed) { renderJobs(); syncAi(); if (state.selected) renderDetail(); }
      if (!jobs.some(j => j.phase === 'queued' || j.phase === 'running')) { clearInterval(state.polling); state.polling = null; }
    } catch {
      clearInterval(state.polling);
      state.polling = null;
    }
  }, 1500);
}

const dismissed = new Set();
function renderJobs() {
  const LABEL = { review: t('jobs.review'), scan: t('jobs.scan'), download: t('jobs.download'), 'open-folder': t('jobs.openFolder') };
  // 審查並安裝、照原始碼補寫由 Claude 在對話裡回報，右下角不另外跳出；進度看插件詳情頁。
  // Haiku 搜尋的結果直接顯示在插件列表，也不另外跳出。
  const recent = state.jobs.filter(j => current(j) && !dismissed.has(j.id) && !['open-folder', 'review', 'ai-search'].includes(j.action)).slice(-4);
  $('jobs').replaceChildren(...recent.map(job => h('div', { class: `job ${job.phase}` },
    job.phase === 'done' ? h('span', { class: 'icon' }, '✓') : job.phase === 'error' ? h('span', { class: 'icon' }, '!') : h('span', { class: 'spin' }),
    h('div', { class: 'body' },
      h('b', {}, `${LABEL[job.action] ?? job.action}: ${job.title}`),
      h('p', {}, jobText(job)),
      h('div', { class: 'row' }, h('button', { class: 'ghost small', type: 'button', onClick: () => openDetail(job.name) }, t('jobs.details')))),
    h('button', { class: 'x', type: 'button', 'aria-label': t('jobs.close'), onClick: () => { dismissed.add(job.id); renderJobs(); } }, '×'))));
}

// ── 啟動 ──
$('filter').addEventListener('click', () => setFilterOpen(!state.filterOpen));
// 回到這個分頁時重讀安裝狀態：可能剛在對話裡裝好，或用 Claude Code 自己的指令改過。
window.addEventListener('focus', () => { if (KEY && state.entries.length) void loadInstalled(); });
$('lang').addEventListener('click', () => setLangOpen(!state.langOpen));
// 點面板外面就關起來；面板裡的按鈕按下後會重畫，所以用事件經過的路徑判斷，不看按鈕還在不在畫面上。
document.addEventListener('click', e => {
  const path = e.composedPath();
  if (state.filterOpen && !path.includes($('filter-wrap'))) setFilterOpen(false);
  if (state.langOpen && !path.includes($('lang-wrap'))) setLangOpen(false);
});
let typing;
$('q').addEventListener('input', e => { clearTimeout(typing); typing = setTimeout(() => setFilter({ q: e.target.value.trim() }), 120); });
$('sort').addEventListener('change', e => setFilter({ sort: e.target.value }));
$('refresh').addEventListener('click', () => void loadCatalog(true));
$('ai').addEventListener('click', () => void startAiSearch());
$('drawer').addEventListener('click', e => { if (e.target instanceof Element && e.target.hasAttribute('data-close')) closeDetail(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.langOpen) setLangOpen(false);
  else if (e.key === 'Escape' && state.filterOpen) setFilterOpen(false);  else if (e.key === 'Escape' && state.selected) closeDetail();
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'SELECT') { e.preventDefault(); $('q').focus(); }
});

applyStatic();
renderLangPanel();
if (!KEY) {
  state.meta = { markets: [], sources: [], error: 'no access key', noKey: true };
  renderSummary();
  render();
} else {
  render();
  void loadCatalog().then(() => loadInstalled());
  void loadFavorites();
  api('/api/jobs').then(({ jobs }) => { state.jobs = jobs; renderJobs(); if (jobs.some(j => j.phase === 'queued' || j.phase === 'running')) pollJobs(); }).catch(() => {});
}
