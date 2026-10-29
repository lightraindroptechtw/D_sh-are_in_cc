// 目錄讀不到時要說清楚原因和怎麼處理；一個目錄壞掉時另一個照常可用。各自一個檔案，模組裡的目錄才不會沿用別的測試。
import { expect, test } from 'claude-code/testing'

// 測試執行環境有 setTimeout，但 mod 的型別檔沒有宣告。
declare const setTimeout: (callback: (value?: unknown) => void, ms: number) => unknown

const PANE = {
  plugin: 'd-sh-are-in-cc',
  component: 'Pane',
  requestId: 'dsh-market',
  props: { title: 'DSH 插件市場', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
// 使用者在輸入框打 /d-sh-are-in-cc-market 按 Enter。
const OPEN = { command: 'd-sh-are-in-cc-market', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

test('both catalogs unreachable: the reason per catalog, what to do, and a retry that works', async ($, on) => {
  let online = false
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'd-sh-are-in-cc-market' } }))
  on('http.fetch', (_, e) => {
    if (!online) return { value: { status: 503, ok: false, headers: {}, text: '' } }
    const text = e.url.includes('dshopen.org') ? JSON.stringify({ format: 1, plugins: [{ name: 'dsh-one', versions: [{ version: '1.0.0', source: { type: 'npm' } }] }] }) : 'not json'
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (await ui.find({ key: 'load' })) await ui.press({ key: 'load' })
    expect(await ui.find({ type: 'Text', text: /讀不到插件目錄/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /開放插件市場（dshopen\.org）/ }))?.text).toContain('HTTP 503')
    expect(await ui.find({ type: 'Text', text: /怎麼處理：/ })).toBeDefined()
    await ui.unmount()
  }

  // 恢復連線後重試：開放插件市場讀到了，Awesome 精選的內容壞掉，只標示那一個。
  online = true
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /共 1 個插件/ }))?.text).toContain('Awesome 精選 讀取失敗')
  expect(await ui.find({ key: 'plugin:dsh-one' })).toBeDefined()
  await ui.unmount()
})

test('every open re-reads both lists; a list that fails later keeps its last good copy and says so', async ($, on) => {
  let round = 0
  let awesomeDown = false
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'd-sh-are-in-cc-market' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('http.fetch', (_, e) => {
    if (e.url.includes('dshopen.org')) {
      const plugins = [{ name: 'dsh-old', versions: [{ version: '1.0.0', source: { type: 'npm' } }] }]
      if (round > 1) plugins.push({ name: 'dsh-new', versions: [{ version: '1.0.0', source: { type: 'npm' } }] })
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ format: 1, plugins }) } }
    }
    if (awesomeDown) return { value: { status: 503, ok: false, headers: {}, text: '' } }
    if (e.url === 'https://awesome-dsh-plugin.com/catalog.json') return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items: [] }) } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ format: 1, plugins: [{ name: 'dsh-curated', versions: [{ version: '2.0.0', source: { type: 'npm' } }] }] }) } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  round = 1
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 開啟面板後清單在背景讀，等「上次讀取」那行出現（最多約 2 秒）。
  const readDone = async () => {
    for (let i = 0; i < 100; i++) {
      if (await ui.find({ type: 'Text', text: /上次讀取：/ })) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  await readDone()
  // 來源寫明：名稱、網站、實際讀取的網址、這次讀到幾個、讀取時間。
  expect((await ui.find({ type: 'Text', text: /開放插件市場（dshopen\.org）/ }))?.text).toContain('1 個插件')
  expect(await ui.find({ type: 'Text', text: /Awesome DSH 插件精選（awesome-dsh-plugin\.com）/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /dshopen\.org\/index\.json/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /cdn\.jsdelivr\.net\/npm\/dsh-plugin-catalog/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /awesome-dsh-plugin\.com\/catalog\.json/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /上次讀取：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/ })).toBeDefined()
  expect(await ui.find({ key: 'plugin:dsh-new' })).toBeUndefined()

  // 社群清單新增了插件，Awesome 那份暫時讀不到：再開一次就看到新插件，Awesome 的沿用上次的並標明。
  round = 2
  awesomeDown = true
  await $.command.run(OPEN)
  await readDone()
  expect(await ui.find({ key: 'plugin:dsh-new' })).toBeDefined()
  expect(await ui.find({ key: 'plugin:dsh-curated' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Awesome DSH 插件精選/ }))?.text).toMatch(/這次讀不到（npm 套件裡的索引：HTTP 503；網站完整清單：HTTP 503），沿用 .* 讀到的 1 個/)

  await ui.press({ key: 'plugin:dsh-curated' })
  expect(await ui.find({ type: 'Text', text: /清單來源：Awesome DSH 插件精選（awesome-dsh-plugin\.com）/ })).toBeDefined()
  await ui.unmount()
})
