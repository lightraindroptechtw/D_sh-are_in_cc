// DSH 插件市場面板：目錄讀取、搜尋、手動下載、掃描、交給 Claude 審查。網路與命令列都在下面假造。
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 測試執行環境有 setTimeout，但 mod 的型別檔沒有宣告。
declare const setTimeout: (callback: (value?: unknown) => void, ms: number) => unknown

const PANE = {
  plugin: 'd-sh-are-in-cc',
  component: 'Pane',
  requestId: 'dsh-market',
  props: { title: 'DSH 插件市場', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const OPEN_INDEX = {
  format: 1,
  title: { en: 'Open', zh: '开放插件市场' },
  metadata: { categories: { memory: { title: { en: 'Memory', zh: '记忆' } }, tools: { title: { en: 'Tools', zh: '工具' } } } },
  plugins: [
    {
      name: 'dsh-memory-plus',
      title: { en: 'Memory Plus', zh: '记忆增强' },
      description: { zh: '跨会话保存项目记忆' },
      metadata: { category: 'memory', sortKeys: { 'github-stars': 12 }, labels: ['active', 'downloads-1k', 'downloads-5k'] },
      versions: [
        { version: '1.2.0', publishTimestamp: 1792000000, source: { type: 'npm' } },
        { version: '1.1.0', publishTimestamp: 1790000000, source: { type: 'npm' } },
      ],
    },
    {
      name: 'dsh-git-tool',
      title: 'Git Tool',
      description: '从 GitHub 固定提交安装',
      metadata: { category: 'tools' },
      versions: [{ version: '0.1.0', publishTimestamp: 1791000000, source: { type: 'git', url: 'https://github.com/someone/git-tool', commit: 'a'.repeat(40), path: 'packages/plugin' } }],
    },
    { name: 'BAD NAME', versions: [{ version: '1.0.0', source: { type: 'npm' } }] },
  ],
}
const AWESOME_INDEX = {
  format: 1,
  title: 'Awesome',
  metadata: { categories: { memory: { title: { zh: '记忆' } } } },
  plugins: [
    { name: 'dsh-memory-plus', title: 'dsh-memory-plus', metadata: { category: 'memory' }, versions: [{ version: '1.0.0', publishTimestamp: 1780000000, source: { type: 'npm' } }] },
    { name: 'dsh-weather', title: '天气查询', description: '查询天气', versions: [{ version: '2.0.0', publishTimestamp: 1789000000, source: { type: 'npm' } }] },
  ],
}

// awesome-dsh-plugin.com 網站自己的清單：一個 npm 插件、一個只在 GitHub 子目錄的插件、一個 GitHub 發布檔，和一筆不合格的。
const SITE_CATALOG = {
  install: 'Install',
  items: [
    { cat: 'tools', tag: 'Tools', dl: 1234, stars: 3, added: '2026-10-01', npm: 1, name: 'dsh-weather', owner: 'carol', short: 'dsh-weather', slug: 'carol/dsh-weather', desc: 'Weather', cmd: 'dsh plugin --profile web add dsh-weather', href: '/p/carol/dsh-weather/' },
    { cat: 'memory', tag: 'Memory', dl: null, stars: 2, added: '2026-10-02', npm: 0, name: 'dsh-gh-only', owner: 'alice', short: 'dsh-gh-only', slug: 'alice/dsh-gh-only--packages-p', desc: 'GitHub only plugin', cmd: 'dsh plugin --profile web add github:alice/dsh-gh-only#path:/packages/p', href: '/p/alice/dsh-gh-only--packages-p/' },
    { cat: 'ui', tag: 'UI', dl: null, stars: 1, added: '2026-10-03', npm: 0, name: 'dsh-rel', owner: 'bob', short: 'dsh-rel', slug: 'bob/dsh-rel', desc: 'Release file plugin', cmd: 'dsh plugin --profile web add "https://github.com/bob/dsh-rel/releases/latest/download/dsh-rel.tgz"', href: '/p/bob/dsh-rel/' },
    { cat: 'ui', npm: 0, name: 'evil', slug: 'x/evil', cmd: 'rm -rf /' },
  ],
}

// 自述文件：npm 版本經 jsDelivr 列檔案再讀；GitHub 預設分支依序試檔名。
const README_ZH = '# 天氣\n<p align="center"><img src="x" onerror="alert(1)"></p>\n![logo](https://example.com/logo.png)\n\n查天氣。'
const READMES: Record<string, string> = {
  'https://data.jsdelivr.com/v1/packages/npm/dsh-weather@2.0.0?structure=flat': JSON.stringify({ files: [{ name: '/README.md' }, { name: '/README.zh-CN.md' }, { name: '/index.js' }] }),
  'https://cdn.jsdelivr.net/npm/dsh-weather@2.0.0/README.zh-CN.md': README_ZH,
  'https://raw.githubusercontent.com/alice/dsh-gh-only/HEAD/packages/p/README.md': '# GitHub only\n只放在 GitHub 的插件。',
}

type World = { argv: string[][]; prompts: string[] }

function stage(on: On, { indexes = true, cliError }: { indexes?: boolean; cliError?: string } = {}): World {
  const world: World = { argv: [], prompts: [] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'd-sh-are-in-cc-market' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_, e) => {
    if (!indexes) return { value: { status: 503, ok: false, headers: {}, text: '' } }
    if (e.url === 'https://awesome-dsh-plugin.com/catalog.json') return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(SITE_CATALOG) } }
    if (/jsdelivr\.net\/npm\/[^/]+\/index\.json$|dshopen\.org/.test(e.url) === false && !e.url.startsWith('https://api.npmjs.org/')) {
      const text = READMES[e.url]
      return { value: text === undefined ? { status: 404, ok: false, headers: {}, text: '' } : { status: 200, ok: true, headers: {}, text } }
    }
    if (/^https:\/\/api\.npmjs\.org\/downloads\/point\/\d{4}-\d\d-\d\d:\d{4}-\d\d-\d\d\//.test(e.url)) {
      // npm 下載統計：dsh-weather 有資料，其他查不到（null）。
      const names = e.url.replace(/^.*\/point\/[^/]+\//, '').split(',')
      const row = (name: string) => (name === 'dsh-weather' ? { downloads: 914, package: name, start: '2026-09-23', end: '2026-10-22' } : null)
      const body = names.length === 1 ? (row(names[0] ?? '') ?? { error: 'not found' }) : Object.fromEntries(names.map(name => [name, row(name)]))
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
    }
    const body = e.url.includes('dshopen.org') ? OPEN_INDEX : AWESOME_INDEX
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    world.argv.push(argv)
    if (cliError) return { value: { exitCode: 1, stdout: '', stderr: cliError, isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv.includes('fetch')) return { value: { exitCode: 0, stdout: JSON.stringify({ root: 'C:\\Users\\someone\\.dsh-to-claude\\cache\\dsh-memory-plus-1.1.0', pinnedSource: 'npm:dsh-memory-plus@1.1.0' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    // 轉換器 scan --markdown 印的是 Markdown 文字（開頭是 #），不是 JSON。
    if (argv.includes('scan')) return { value: { exitCode: 0, stdout: '# DSH 插件安全掃描：dsh-memory-plus 1.2.0\n\n| 項目 | 結果 |\n|---|---|\n| 開程式 | 沒有 |\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', { command: 'd-sh-are-in-cc:install' }, (_, e) => {
    world.prompts.push(`/${e.command} ${e.args}`)
    return { text: '' }
  })
  return world
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`browse, search and open a plugin (${surface})`, async ($, on) => {
    stage(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, surface })
    if (await ui.find({ key: 'load' })) await ui.press({ key: 'load' })

    // 兩份清單（Awesome 有兩個檔案）合併：同名插件只算一次，格式不對的條目略過。
    expect((await ui.find({ type: 'Text', text: /共 5 個插件/ }))?.text).toContain('開放市場 2、Awesome 精選 4')
    expect(await ui.find({ key: 'plugin:dsh-weather' })).toBeDefined()

    await ui.input({ key: 'query', text: '记忆' })
    expect(await ui.find({ key: 'plugin:dsh-memory-plus' })).toBeDefined()
    expect(await ui.find({ key: 'plugin:dsh-weather' })).toBeUndefined()

    await ui.input({ key: 'query', text: '' })
    await ui.select({ key: 'market', value: 'awesome' })
    expect(await ui.find({ key: 'plugin:dsh-git-tool' })).toBeUndefined()
    await ui.select({ key: 'market', value: '' })
    await ui.select({ key: 'category', value: '工具與能力' })
    expect(await ui.find({ key: 'plugin:dsh-git-tool' })).toBeDefined()
    expect(await ui.find({ key: 'plugin:dsh-memory-plus' })).toBeUndefined()
    await ui.select({ key: 'category', value: '' })

    await ui.press({ key: 'plugin:dsh-memory-plus' })
    expect(await ui.find({ type: 'Text', text: /清單來源：開放插件市場（dshopen\.org）、Awesome DSH 插件精選（awesome-dsh-plugin\.com）/ })).toBeDefined()
    expect(await ui.find({ key: 'download' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'query' })).toBeDefined()
    await ui.unmount()
  })
}

test('download only fetches the pinned version and shows where it went', async ($, on) => {
  const world = stage(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  if (await ui.find({ key: 'load' })) await ui.press({ key: 'load' })
  await ui.press({ key: 'plugin:dsh-memory-plus' })
  await ui.select({ key: 'version', value: '1.1.0' })
  await ui.press({ key: 'download' })

  const fetchCall = world.argv.find(argv => argv.includes('fetch'))
  expect(fetchCall?.slice(-2)).toEqual(['fetch', 'npm:dsh-memory-plus@1.1.0'])
  expect(fetchCall?.[1]).toEndWith('/bin/d-sh-are-in-cc.mjs')
  expect((await ui.find({ type: 'Text', text: /已下載原始碼/ }))?.text).toContain('dsh-memory-plus-1.1.0')
  expect(await ui.find({ key: 'open-folder' })).toBeDefined()
  expect(await ui.find({ key: 'copy-path' })).toBeDefined()
  expect(world.prompts).toEqual([])
  await ui.unmount()
})

test('scan shows the fixed-rule table as written; review hands the pinned source to the install skill', async ($, on) => {
  const world = stage(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  if (await ui.find({ key: 'load' })) await ui.press({ key: 'load' })
  await ui.press({ key: 'plugin:dsh-memory-plus' })
  await ui.press({ key: 'scan' })
  expect(world.argv.at(-1)?.slice(-3)).toEqual(['scan', 'npm:dsh-memory-plus@1.2.0', '--markdown'])
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('| 開程式 | 沒有 |')

  await ui.press({ key: 'review' })
  expect(world.prompts).toEqual(['/d-sh-are-in-cc:install npm:dsh-memory-plus@1.2.0'])
  await ui.unmount()
})

test('sort by stars; the quick button on a card hands that plugin to the install skill; desktop draws the banner as an image', async ($, on) => {
  const world = stage(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  if (await ui.find({ key: 'load' })) await ui.press({ key: 'load' })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()

  await ui.select({ key: 'sort', value: 'stars' })
  const cards = (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('plugin:'))
  expect(cards[0]).toBe('plugin:dsh-memory-plus')

  await ui.press({ key: 'quick:dsh-weather' })
  expect(world.prompts).toEqual(['/d-sh-are-in-cc:install npm:dsh-weather@2.0.0'])
  expect(await ui.find({ key: 'back' })).toBeDefined()
  await ui.unmount()
})

test('a GitHub source is pinned to its commit, with its subfolder', async ($, on) => {
  const world = stage(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  if (await ui.find({ key: 'load' })) await ui.press({ key: 'load' })
  await ui.press({ key: 'plugin:dsh-git-tool' })
  await ui.press({ key: 'download' })
  expect(world.argv.at(-1)?.slice(-4)).toEqual(['fetch', `https://github.com/someone/git-tool/tree/${'a'.repeat(40)}`, '--package-dir', 'packages/plugin'])
  await ui.unmount()
})

test('a failing converter is explained: what, why, how to fix, what it affects', async ($, on) => {
  stage(on, { cliError: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'esbuild'" })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  if (await ui.find({ key: 'load' })) await ui.press({ key: 'load' })
  await ui.press({ key: 'plugin:dsh-weather' })
  await ui.press({ key: 'download' })
  const text = (await ui.find({ type: 'Text', text: /下載失敗/ }))?.text ?? ''
  for (const part of ['原因：', '怎麼處理：', 'npm ci --ignore-scripts', '影響：']) expect(text).toContain(part)
  expect(await ui.find({ key: 'open-folder' })).toBeUndefined()
  await ui.unmount()
})

test('mobile is told to use the desktop app', async ($, on) => {
  stage(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /電腦版/ })).toBeDefined()
  await ui.unmount()
})

test('download counts: exact npm 30-day numbers where npm has them, the open market range otherwise, each saying where it came from', async ($, on) => {
  stage(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } })
  if (await ui.find({ key: 'load' })) await ui.press({ key: 'load' })
  for (let i = 0; i < 100 && !(await ui.find({ type: 'Text', text: /↓ 914／30 天/ })); i++) await new Promise(resolve => setTimeout(resolve, 20))
  expect(await ui.find({ type: 'Text', text: /↓ 914／30 天/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↓ 5000\+/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /api\.npmjs\.org/ })).toBeDefined()

  await ui.select({ key: 'sort', value: 'downloads' })
  const cards = (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('plugin:'))
  expect(cards[0]).toBe('plugin:dsh-memory-plus')

  await ui.press({ key: 'plugin:dsh-weather' })
  expect((await ui.find({ type: 'Text', text: /下載次數：/ }))?.text).toContain('npm 過去 30 天下載 914 次（2026-09-23 到 2026-10-22，資料來自 api.npmjs.org）')
  await ui.press({ key: 'back' })
  await ui.press({ key: 'plugin:dsh-git-tool' })
  expect((await ui.find({ type: 'Text', text: /下載次數：/ }))?.text).toContain('從 GitHub 安裝，沒有下載次數')
  await ui.unmount()
})

test('the site list adds GitHub-only plugins: latest default branch with its subfolder; release files are shown but cannot be fetched', async ($, on) => {
  const world = stage(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  if (await ui.find({ key: 'load' })) await ui.press({ key: 'load' })
  expect(await ui.find({ key: 'plugin:x/evil' })).toBeUndefined()

  await ui.press({ key: 'plugin:alice/dsh-gh-only--packages-p' })
  expect(await ui.find({ type: 'Text', text: /清單來源：Awesome DSH 插件精選/ })).toBeDefined()
  await ui.press({ key: 'download' })
  expect(world.argv.at(-1)?.slice(-4)).toEqual(['fetch', 'https://github.com/alice/dsh-gh-only', '--package-dir', 'packages/p'])
  for (let i = 0; i < 100 && (await ui.find({ type: 'Text', text: /正在讀取自述文件/ })); i++) await new Promise(resolve => setTimeout(resolve, 20))
  expect((await ui.find({ type: 'Text', text: /來源：GitHub 倉庫 alice\/dsh-gh-only/ }))?.text).toContain('raw.githubusercontent.com')
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('只放在 GitHub 的插件')
  await ui.press({ key: 'back' })

  expect(await ui.find({ key: 'quick:bob/dsh-rel' })).toBeUndefined()
  await ui.press({ key: 'plugin:bob/dsh-rel' })
  expect(await ui.find({ type: 'Text', text: /GitHub 發布檔（\.tgz）/ })).toBeDefined()
  expect(await ui.find({ key: 'review' })).toBeUndefined()
  expect(await ui.find({ key: 'download' })).toBeUndefined()
  await ui.unmount()
})

test('the README is read from the pinned npm version, Chinese first, says where it came from, and loads no images or HTML', async ($, on) => {
  stage(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  if (await ui.find({ key: 'load' })) await ui.press({ key: 'load' })
  await ui.press({ key: 'plugin:dsh-weather' })
  for (let i = 0; i < 100 && (await ui.find({ type: 'Text', text: /正在讀取自述文件/ })); i++) await new Promise(resolve => setTimeout(resolve, 20))
  expect((await ui.find({ type: 'Text', text: /來源：npm 套件/ }))?.text).toContain('dsh-weather@2.0.0 裡的 README.zh-CN.md，經 jsDelivr 讀取')
  const text = (await ui.find({ type: 'Markdown' }))?.text ?? ''
  expect(text).toContain('查天氣')
  expect(text).toContain('[圖片：logo](https://example.com/logo.png)')
  expect(text).not.toContain('<img')
  expect(text).not.toContain('onerror')

  // 沒有自述文件的插件寫明沒有。
  await ui.press({ key: 'back' })
  await ui.press({ key: 'plugin:dsh-memory-plus' })
  for (let i = 0; i < 100 && (await ui.find({ type: 'Text', text: /正在讀取自述文件/ })); i++) await new Promise(resolve => setTimeout(resolve, 20))
  expect(await ui.find({ type: 'Text', text: /讀不到自述文件|沒有自述文件/ })).toBeDefined()
  await ui.unmount()
})
