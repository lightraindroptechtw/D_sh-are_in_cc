// SECURITY-PLAN.md, mod side: outbound tools, keys, exec.check, the status command's restrictions.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { START, denyOf, resultText, slash, stage, tn, toastsOf } from './sim'

const HOST = { tools: [{ dshName: 'post_comment' }, { dshName: 'send_raw' }, { dshName: 'echo' }, { dshName: 'ask' }] }
const COMMENT = { tool: tn('post_comment'), bvid: 'BV1xx', text: 'hello world, a fine video' }
// A made-up value for the fixture's key field: nothing real.
const KEY = 'fixture-key-0123456789abcdef'
const PIN = '12345' // shorter than the masking minimum
const HOUR = 3600 * 1000

const sent = (world: ReturnType<typeof stage>): number => world.cores.at(-1)?.calls.filter(c => c.method === 'tools.call' && c.params.name === 'post_comment').length ?? 0
const status = async ($: { command: { run: (e: ReturnType<typeof slash>) => Promise<{ text?: string }> } }): Promise<string> => (await $.command.run(slash('dsh-fixture-status'))).text ?? ''

/** The person's `/config` rows and its writer, beneath the plugin: what `$.config.set` changed. */
function configMenu(on: On, deny?: string): { key: string; value: unknown }[] {
  const sets: { key: string; value: unknown }[] = []
  on('config.list', () => ({
    value: [
      {
        key: 'dsh-fixture.outboundMode',
        label: '對外發文模式',
        kind: 'choice' as const,
        value: 'ask',
        options: ['ask', 'auto', 'deny'],
        provider: { plugin: 'dsh-fixture', tier: 'user' as const },
        isLocked: false,
      },
    ],
  }))
  on('config.set', (_, e) => {
    sets.push({ key: e.key, value: e.value })
    return deny !== undefined ? { deny } : { value: e.value }
  })
  return sets
}

describe('outbound: deny', () => {
  test('nothing is sent, the result says why in four parts, a toast too; no argument gets past it', { options: { outboundMode: 'deny' } }, async ($, on) => {
    const world = stage(on, HOST)
    await $.session.start(START)
    const r = await $.tool.call({ ...COMMENT, force: true, outboundMode: 'auto' })
    const msg = denyOf(r) ?? ''
    expect(msg).toStartWith('[被擋下] Fixture plugin 想在影片底下發留言（目的地：bvid=BV1xx）')
    for (const part of ['原因：', '怎麼放行：', 'outboundMode', '影響：', '（代碼：OUTBOUND_DENIED）']) expect(msg).toContain(part)
    expect(sent(world)).toBe(0)
    expect(world.asks.length).toBe(0)
    expect(toastsOf(world)).toEqual([msg])
  })
})

describe('outbound: ask (the default)', () => {
  test('the dialog shows the destination and the whole text; "這次送出" sends, then a toast and a log record', async ($, on) => {
    mock.store(on)
    const world = stage(on, HOST, { answers: ['這次送出'] })
    await $.session.start(START)
    const r = await $.tool.call(COMMENT)
    expect(resultText(r)).toContain('ran post_comment')
    expect(world.asks.length).toBe(1)
    expect(world.asks[0]?.question).toContain('Fixture plugin 想在影片底下發留言')
    expect(world.asks[0]?.question).toContain('目的地：bvid=BV1xx')
    expect(world.asks[0]?.question).toContain('全文：\nhello world, a fine video')
    expect(world.asks[0]?.options).toEqual(['這次送出', '以後都自動發', '不要送出'])
    expect(world.asks[0]?.header).toBe('對外發文')
    expect(toastsOf(world)).toEqual(['已發出：bvid=BV1xx：hello world, a fine video'])
    const text = await status($)
    expect(text).toContain('對外發文：每次確認（ask）')
    expect(text).toContain('post_comment  bvid=BV1xx：hello world, a fine video')
  })

  test('"不要送出": not sent, the result says the person declined', async ($, on) => {
    const world = stage(on, HOST, { answers: ['不要送出'] })
    await $.session.start(START)
    const msg = denyOf(await $.tool.call(COMMENT)) ?? ''
    expect(msg).toContain('使用者拒絕了 Fixture plugin 的這則「在影片底下發留言」')
    expect(msg).toContain('沒有送出')
    expect(msg).toContain('（代碼：OUTBOUND_REJECTED）')
    expect(sent(world)).toBe(0)
  })

  test('a dismissed dialog (or nobody to ask) is a no', async ($, on) => {
    const world = stage(on, HOST, { answer: null })
    await $.session.start(START)
    expect(denyOf(await $.tool.call(COMMENT))).toContain('沒有送出')
    expect(sent(world)).toBe(0)
  })

  test('free text under "Other" is not a yes', async ($, on) => {
    const world = stage(on, HOST, { answer: '好，送出' })
    await $.session.start(START)
    expect(denyOf(await $.tool.call(COMMENT))).toContain('沒有送出')
    expect(sent(world)).toBe(0)
  })

  test('a field like force does not skip the dialog', async ($, on) => {
    const world = stage(on, HOST, { answer: '不要送出' })
    await $.session.start(START)
    await $.tool.call({ ...COMMENT, force: true, confirmed: true })
    expect(world.asks.length).toBe(1)
    expect(sent(world)).toBe(0)
  })

  test('a tool with no named fields shows all of its arguments', async ($, on) => {
    const world = stage(on, HOST, { answer: '不要送出' })
    await $.session.start(START)
    await $.tool.call({ tool: tn('send_raw'), to: 'someone@example.com', body: 'hi there' })
    expect(world.asks[0]?.question).toContain('全部參數')
    expect(world.asks[0]?.question).toContain('someone@example.com')
    expect(world.asks[0]?.question).toContain('hi there')
  })

  test('"以後都自動發": warned once, sent, the option changed to auto; the next send is not asked', async ($, on) => {
    mock.store(on)
    const sets = configMenu(on)
    const world = stage(on, HOST, { answers: ['以後都自動發', '確定，以後都自動發'] })
    await $.session.start(START)
    expect(resultText(await $.tool.call(COMMENT))).toContain('ran post_comment')
    expect(world.asks.length).toBe(2)
    expect(world.asks[1]?.question).toContain('平台可能把大量自動發文視為垃圾訊息而限制帳號')
    expect(world.asks[1]?.options).toEqual(['確定，以後都自動發', '只送這一次', '不要送出'])
    await world.clock.advance(1)
    await world.clock.settle()
    expect(sets).toEqual([{ key: 'dsh-fixture.outboundMode', value: 'auto' }])
    expect(toastsOf(world).at(-1)).toContain('已把插件選項 outboundMode 改成 auto')

    expect(resultText(await $.tool.call({ ...COMMENT, text: 'second' }))).toContain('ran post_comment')
    expect(world.asks.length).toBe(2)
    expect(sent(world)).toBe(2)
  })

  test('"以後都自動發" when the option cannot be changed: this session only, and the toast says where to change it', async ($, on) => {
    mock.store(on)
    configMenu(on, 'a trusted source owns the row')
    const world = stage(on, HOST, { answers: ['以後都自動發', '確定，以後都自動發'] })
    await $.session.start(START)
    await $.tool.call(COMMENT)
    await world.clock.advance(1)
    await world.clock.settle()
    const note = toastsOf(world).at(-1) ?? ''
    expect(note).toContain('這次工作階段內以後都自動發文')
    expect(note).toContain('到插件選項把 outboundMode 改成 auto')
    expect(await status($)).toContain('只在這次 Claude Code 工作階段有效')
    await $.tool.call({ ...COMMENT, text: 'second' })
    expect(world.asks.length).toBe(2)
    expect(sent(world)).toBe(2)
  })

  test('"以後都自動發" then "只送這一次": sent once, the next send is asked again', async ($, on) => {
    const sets = configMenu(on)
    const world = stage(on, HOST, { answers: ['以後都自動發', '只送這一次', '不要送出'] })
    await $.session.start(START)
    expect(resultText(await $.tool.call(COMMENT))).toContain('ran post_comment')
    await world.clock.advance(1)
    await $.tool.call(COMMENT)
    expect(world.asks.length).toBe(3)
    expect(sets).toEqual([])
    expect(sent(world)).toBe(1)
  })
})

describe('outbound: auto', () => {
  test('sends without asking until the hourly limit, then stops with a four-part message', { options: { outboundMode: 'auto', outboundHourlyLimit: 2 } }, async ($, on) => {
    mock.store(on)
    const world = stage(on, HOST)
    await $.session.start(START)
    expect(resultText(await $.tool.call(COMMENT))).toContain('ran post_comment')
    expect(resultText(await $.tool.call(COMMENT))).toContain('ran post_comment')
    const msg = denyOf(await $.tool.call(COMMENT)) ?? ''
    expect(msg).toContain('這一小時已發 2 則，達到每小時上限 2 則')
    expect(msg).toContain('outboundHourlyLimit')
    expect(msg).toContain('（代碼：OUTBOUND_HOURLY_LIMIT）')
    expect(world.asks.length).toBe(0)
    expect(sent(world)).toBe(2)
    expect(toastsOf(world).filter(t => t.startsWith('已發出：bvid=BV1xx：')).length).toBe(2)
    expect(toastsOf(world).at(-1)).toBe(msg)

    await world.clock.advance(HOUR)
    expect(resultText(await $.tool.call(COMMENT))).toContain('ran post_comment')
  })

  test('the counts come from the stored log, so they hold across sessions', { options: { outboundMode: 'auto', outboundHourlyLimit: 0, outboundDailyLimit: 3 } }, async ($, on) => {
    const earlier = [1, 2, 3].map(i => ({ at: 0, tool: 'post_comment', target: `bvid=OLD${i}`, preview: `earlier ${i}` }))
    mock.store(on, { 'outbound-log': earlier })
    const world = stage(on, HOST)
    await $.session.start(START)
    const msg = denyOf(await $.tool.call(COMMENT)) ?? ''
    expect(msg).toContain('這 24 小時已發 3 則，達到每天上限 3 則')
    expect(msg).toContain('（代碼：OUTBOUND_DAILY_LIMIT）')
    expect(sent(world)).toBe(0)
    expect(await status($)).toContain('bvid=OLD3：earlier 3')
  })

  test('without a working store it still sends and logs for the session, and the status says so', { options: { outboundMode: 'auto' } }, async ($, on) => {
    const world = stage(on, HOST)
    await $.session.start(START)
    expect(resultText(await $.tool.call(COMMENT))).toContain('ran post_comment')
    const text = await status($)
    expect(text).toContain('只記在這次工作階段')
    expect(text).toContain('post_comment  bvid=BV1xx')
    expect(sent(world)).toBe(1)
  })

  test('a failed send is not logged and says nothing was sent', { options: { outboundMode: 'auto' } }, async ($, on) => {
    mock.store(on)
    const world = stage(on, { tools: [{ dshName: 'post_fail' }] })
    await $.session.start(START)
    expect(denyOf(await $.tool.call({ tool: tn('post_fail'), to: 'x', text: 'y' }))).toBe('the tool failed on purpose')
    expect(world.cores[0]?.calls.filter(c => c.method === 'tools.call').length).toBe(1)
    expect(await status($)).toContain('最近的發文紀錄：（沒有）')
    expect(toastsOf(world).filter(t => t.startsWith('已發出')).length).toBe(0)
  })
})

describe('keys', () => {
  const FILLED = { options: { secret_FIXTURE_API_KEY: KEY, secret_FIXTURE_PIN: PIN } }

  test('filled-in keys reach the child as its variables, with their names', FILLED, async ($, on) => {
    const world = stage(on, HOST)
    await $.session.start(START)
    const env = world.spawns[0]?.env ?? {}
    expect(env.FIXTURE_API_KEY).toBe(KEY)
    expect(env.FIXTURE_PIN).toBe(PIN)
    expect(env.DSH_CLAUDE_SECRET_NAMES).toBe('FIXTURE_API_KEY,FIXTURE_PIN')
    expect(world.toasts.filter(t => t.includes('SECRET_MISSING')).length).toBe(0)
  })

  test('a required key left empty: one toast at the start, naming its option field; the status lists it', async ($, on) => {
    const world = stage(on, HOST)
    await $.session.start(START)
    const missing = world.toasts.filter(t => t.includes('SECRET_MISSING'))
    expect(missing.length).toBe(1)
    expect(missing[0]).toContain('[被擋下] Fixture plugin 缺少「Fixture API 金鑰」')
    expect(missing[0]).toContain('secret_FIXTURE_API_KEY')
    expect(missing[0]).toContain('假搜尋無法使用')
    expect(world.spawns[0]?.env?.FIXTURE_API_KEY).toBeUndefined()
    const text = await status($)
    expect(text).toContain('假搜尋（缺少「Fixture API 金鑰」）')
    expect(text).toContain('secret_FIXTURE_API_KEY')
  })

  test('tool results reach Claude with the key masked; a value shorter than 6 characters is left alone', FILLED, async ($, on) => {
    stage(on, HOST)
    await $.session.start(START)
    const text = resultText(await $.tool.call({ tool: tn('echo'), q: `use ${KEY} here`, pin: PIN }))
    expect(text).not.toContain(KEY)
    expect(text).toContain('use [已遮蔽] here')
    expect(text).toContain(PIN)
  })

  test('the host notices and the dialogs are masked too', FILLED, async ($, on) => {
    const world = stage(on, { ...HOST, reverse: 'notify' }, { answer: '不要送出' })
    await $.session.start(START)
    await $.tool.call({ tool: tn('ask'), params: { text: `the key is ${KEY}`, level: 'warning' } })
    await $.tool.call({ ...COMMENT, text: `leaking ${KEY}` })
    expect(world.toasts.join('\n')).not.toContain(KEY)
    expect(world.toasts).toContain('[warning] the key is [已遮蔽]')
    expect(world.asks[0]?.question).toContain('leaking [已遮蔽]')
  })
})

describe('ui.notify', () => {
  test('always a toast, even when the host asks for the status line', async ($, on) => {
    const world = stage(on, { ...HOST, reverse: 'notify' })
    await $.session.start(START)
    await $.tool.call({ tool: tn('ask'), params: { text: 'worker restarted', level: 'info', target: 'status' } })
    expect(toastsOf(world)).toEqual(['worker restarted'])
    expect(world.statuses.filter(s => s !== undefined)).toEqual([])
  })
})

describe('exec.check', () => {
  const EXEC = { tools: [{ dshName: 'ask' }], reverse: 'exec' }
  const replyOf = (answer: unknown): { result?: { decision: string; reason?: string }; error?: { code: string } } =>
    JSON.parse(resultText(answer)).reply

  test('allow: Claude Code allows the Bash command, nobody is asked', async ($, on) => {
    const checks: { tool: string; input: unknown }[] = []
    on('tool.check', { tool: 'Bash' }, (_, e) => {
      checks.push({ tool: e.tool, input: e.input })
      return { decision: 'allow' as const }
    })
    const world = stage(on, EXEC)
    await $.session.start(START)
    expect(replyOf(await $.tool.call({ tool: tn('ask') })).result).toEqual({ decision: 'allow' })
    expect(checks).toEqual([{ tool: 'Bash', input: { command: 'git status' } }])
    expect(world.asks.length).toBe(0)
  })

  test("deny: Claude Code's reason and rule are passed on", async ($, on) => {
    on('tool.check', { tool: 'Bash' }, () => ({ decision: 'deny' as const, reason: 'denied by a rule', rule: 'Bash(git:*)' }))
    stage(on, EXEC)
    await $.session.start(START)
    const reply = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(reply.result?.decision).toBe('deny')
    expect(reply.result?.reason).toBe('denied by a rule（規則 Bash(git:*)）')
  })

  test('ask: the person sees the command, the folder and why; only the allow label runs it', async ($, on) => {
    on('tool.check', { tool: 'Bash' }, () => ({ decision: 'ask' as const, reason: 'git is not in the allow list' }))
    const world = stage(on, EXEC, { answers: ['允許這次執行', '不允許', null] })
    await $.session.start(START)
    expect(replyOf(await $.tool.call({ tool: tn('ask') })).result).toEqual({ decision: 'allow' })
    const q = world.asks[0]?.question ?? ''
    expect(q).toContain('Fixture plugin 想在這台電腦執行指令（Fixture plugin: the status feature）')
    expect(q).toContain('git status')
    expect(q).toContain('工作目錄：/work')
    expect(q).toContain('git is not in the allow list')
    expect(world.asks[0]?.options).toEqual(['允許這次執行', '不允許'])
    expect(replyOf(await $.tool.call({ tool: tn('ask') })).result?.decision).toBe('deny')
    expect(replyOf(await $.tool.call({ tool: tn('ask') })).result?.decision).toBe('deny')
  })

  test('ask: the command is shown with the key masked', { options: { secret_FIXTURE_API_KEY: KEY } }, async ($, on) => {
    on('tool.check', { tool: 'Bash' }, () => ({ decision: 'ask' as const }))
    const world = stage(on, EXEC, { answer: '不允許' })
    await $.session.start(START)
    await $.tool.call({ tool: tn('ask'), params: { tool: 'Bash', command: `curl -H "x-key: ${KEY}" https://example.com`, cwd: '/work', why: 'x' } })
    expect(world.asks[0]?.question).toContain('x-key: [已遮蔽]')
    expect(world.asks[0]?.question).not.toContain(KEY)
  })
})

describe('status and options', () => {
  test('the status lists what is restricted, why, and how to let it', { options: { allowModelCalls: false, outboundMode: 'deny' } }, async ($, on) => {
    stage(on, HOST)
    await $.session.start(START)
    const text = await status($)
    expect(text).toContain('目前受限的功能：')
    for (const s of ['插件呼叫模型', 'allowModelCalls', '對外發文（在影片底下發留言', 'outboundMode 設為 deny', 'allowDirectExec', 'extraFolders']) {
      expect(text).toContain(s)
    }
    expect(text).not.toContain('插件開子代理')
  })

  test('allowDirectExec and extraFolders reach the child as they are', { options: { allowDirectExec: true, extraFolders: 'D:\\notes;E:\\data' } }, async ($, on) => {
    const world = stage(on, HOST)
    await $.session.start(START)
    expect(world.spawns[0]?.env?.DSH_CLAUDE_ALLOW_DIRECT_EXEC).toBe('1')
    expect(world.spawns[0]?.env?.DSH_CLAUDE_EXTRA_FOLDERS).toBe('D:\\notes;E:\\data')
    const text = await status($)
    expect(text).not.toContain('插件自己直接開程式')
  })
})

describe('trust: the plugin starts programs by itself', () => {
  const NOTIFY = { tools: [{ dshName: 'ask' }], reverse: 'notify' }
  const BLOCKED = {
    level: 'warning',
    text: ['[被擋下] 「Fixture plugin」插件想直接執行程式 git', '原因：安全限制', '怎麼放行：信任這個插件', '影響：插件無法啟動', '（代碼：ERR_ACCESS_DENIED）'].join('\n'),
    blocked: { kind: 'exec', code: 'ERR_ACCESS_DENIED' },
  }
  const TRUST = '完全信任這個插件（它可以開任何程式、讀寫任何檔案）'

  test('a direct-exec block asks once; trusting restarts the host with the permission', async ($, on) => {
    mock.store(on)
    const world = stage(on, NOTIFY, { answers: [TRUST] })
    await $.session.start(START)
    expect(world.spawns[0]?.env?.DSH_CLAUDE_ALLOW_DIRECT_EXEC).toBe('0')
    await $.tool.call({ tool: tn('ask'), params: BLOCKED })
    await world.clock.settle()
    await world.clock.advance(10) // the old host leaves 10 ms after dispose; the mod waits for that
    await world.clock.advance(10)
    expect(world.asks.length).toBe(1)
    expect(world.asks[0]?.question).toContain('「Fixture plugin」插件想直接執行程式 git')
    expect(world.asks[0]?.question).toContain('只對這個插件有效')
    expect(world.asks[0]?.options).toEqual([TRUST, '先不要'])
    expect(world.spawns.length).toBe(2)
    expect(world.spawns[1]?.env?.DSH_CLAUDE_ALLOW_DIRECT_EXEC).toBe('1')
    expect(toastsOf(world).some(t => t.includes('已完全信任'))).toBe(true)
    expect(await status($)).toContain('allowed (trusted; /dsh-fixture-trust to withdraw)')
  })

  test('the trust is kept in the store: the next session starts with the permission and nothing is asked', async ($, on) => {
    mock.store(on, { 'trust-direct-exec': true })
    const world = stage(on, NOTIFY)
    await $.session.start(START)
    expect(world.spawns[0]?.env?.DSH_CLAUDE_ALLOW_DIRECT_EXEC).toBe('1')
    await $.tool.call({ tool: tn('ask'), params: BLOCKED })
    await world.clock.settle()
    expect(world.asks.length).toBe(0)
  })

  test('"先不要" keeps the block, says how to trust later, and is not asked again in this load', async ($, on) => {
    mock.store(on)
    const world = stage(on, NOTIFY, { answers: ['先不要'] })
    await $.session.start(START)
    await $.tool.call({ tool: tn('ask'), params: BLOCKED })
    await world.clock.settle()
    await $.tool.call({ tool: tn('ask'), params: BLOCKED })
    await world.clock.settle()
    expect(world.asks.length).toBe(1)
    expect(world.spawns.length).toBe(1)
    expect(toastsOf(world).some(t => t.includes('沒有信任') && t.includes('/dsh-fixture-trust'))).toBe(true)
  })

  test('other blocks (a folder) do not ask about trust', async ($, on) => {
    const world = stage(on, NOTIFY)
    await $.session.start(START)
    await $.tool.call({ tool: tn('ask'), params: { ...BLOCKED, blocked: { kind: 'fs', code: 'ERR_ACCESS_DENIED' } } })
    await world.clock.settle()
    expect(world.asks.length).toBe(0)
  })

  test('/<plugin>-trust withdraws the trust and restarts without the permission', async ($, on) => {
    mock.store(on, { 'trust-direct-exec': true })
    const world = stage(on, NOTIFY, { answers: ['取消信任'] })
    await $.session.start(START)
    const ran = $.command.run(slash('dsh-fixture-trust'))
    await world.clock.settle()
    await world.clock.advance(10)
    await world.clock.advance(10)
    expect((await ran).text).toContain('已取消信任')
    expect(world.asks[0]?.options).toEqual(['取消信任', '保持信任'])
    expect(world.spawns[1]?.env?.DSH_CLAUDE_ALLOW_DIRECT_EXEC).toBe('0')
  })

  // A tool call that hit the block inside: what the real host answers (lib/claude-host/host.mjs), on the first host only.
  const WHAT = '「Fixture plugin」插件想直接執行程式 node'
  const BLOCK_TEXT = [`[被擋下] ${WHAT}`, '原因：安全限制', '怎麼放行：信任這個插件', '影響：「echo」功能無法使用', '（代碼：ERR_ACCESS_DENIED）'].join('\n')
  const blockOnFirstHost = (method: string, params: Record<string, unknown>, result: unknown, spawn: number): unknown =>
    method === 'tools.call' && spawn === 1
      ? { content: [{ type: 'text', text: BLOCK_TEXT }], isError: true, blocked: [{ kind: 'exec', code: 'ERR_ACCESS_DENIED', what: WHAT }] }
      : result
  const ECHO = { tools: [{ dshName: 'echo' }] }
  const calls = (world: ReturnType<typeof stage>, n: number, name = 'echo') => world.cores[n]?.calls.filter(c => c.method === 'tools.call' && c.params.name === name) ?? []
  const RERUN = '會自動再執行一次剛才被擋下的功能'
  /** Lets the trust run: the old host leaves 10 ms after dispose, then the new one starts. */
  const letItRun = async (world: ReturnType<typeof stage>): Promise<void> => {
    await world.clock.settle()
    await world.clock.advance(10)
    await world.clock.advance(10)
    await world.clock.settle()
  }

  test('a blocked tool call waits for the answer; trusting restarts the host and Claude gets the answer of the call run once more', async ($, on) => {
    mock.store(on)
    const world = stage(on, ECHO, { answers: [TRUST], rewrite: blockOnFirstHost })
    await $.session.start(START)
    const call = $.tool.call({ tool: tn('echo'), tool_use_id: 'toolu_trust_1', word: 'hi' })
    await letItRun(world)
    const answer = await call
    expect(denyOf(answer)).toBeUndefined()
    expect(resultText(answer)).toContain('"word":"hi"')
    expect(world.asks.length).toBe(1)
    expect(world.asks[0]?.question).toContain(WHAT)
    expect(world.asks[0]?.question).toContain(RERUN)
    expect(world.spawns.length).toBe(2)
    expect(world.spawns[1]?.env?.DSH_CLAUDE_ALLOW_DIRECT_EXEC).toBe('1')
    // Once on each host: the blocked call, then the same call once more.
    expect(calls(world, 0).length).toBe(1)
    expect(calls(world, 1).map(c => c.params.callId)).toEqual(['toolu_trust_1-again'])
    expect(calls(world, 1)[0]?.params.args).toEqual({ word: 'hi' })
    expect(toastsOf(world).some(t => t.includes('已完全信任'))).toBe(true)
  })

  test('"先不要": the call answers with the original block, nothing runs again, and a later block asks nothing', async ($, on) => {
    mock.store(on)
    const world = stage(on, ECHO, { answers: ['先不要'], rewrite: blockOnFirstHost })
    await $.session.start(START)
    const call = $.tool.call({ tool: tn('echo'), word: 'hi' })
    await world.clock.settle()
    const answer = await call
    expect(denyOf(answer)).toBe(BLOCK_TEXT)
    expect(world.asks.length).toBe(1)
    expect(world.spawns.length).toBe(1)
    expect(calls(world, 0).length).toBe(1)
    expect(toastsOf(world).some(t => t.includes('沒有信任') && t.includes('/dsh-fixture-trust'))).toBe(true)
    const again = $.tool.call({ tool: tn('echo'), word: 'hi' })
    await world.clock.settle()
    expect(denyOf(await again)).toBe(BLOCK_TEXT)
    expect(world.asks.length).toBe(1)
  })

  test('a question dismissed (or one nobody can answer, as under claude -p): the original block, nothing runs again', async ($, on) => {
    mock.store(on)
    const world = stage(on, ECHO, { answer: null, rewrite: blockOnFirstHost })
    await $.session.start(START)
    const call = $.tool.call({ tool: tn('echo'), word: 'hi' })
    await world.clock.settle()
    expect(denyOf(await call)).toBe(BLOCK_TEXT)
    expect(world.asks.length).toBe(1)
    expect(world.spawns.length).toBe(1)
    expect(calls(world, 0).length).toBe(1)
  })

  test('the notice a blocked call raises and its answer make one question, asked by the call (and two blocked calls share it)', async ($, on) => {
    mock.store(on)
    const inCall = (id: string) => ({ ...BLOCKED, blocked: { ...BLOCKED.blocked, callId: id } })
    const withBlock = (method: string, params: Record<string, unknown>, result: unknown, spawn: number): unknown =>
      method === 'tools.call' && spawn === 1 && isRecord(result) ? { ...result, blocked: [{ kind: 'exec', code: 'ERR_ACCESS_DENIED', what: WHAT }] } : result
    const world = stage(on, NOTIFY, { answers: [TRUST], rewrite: withBlock })
    await $.session.start(START)
    const first = $.tool.call({ tool: tn('ask'), tool_use_id: 'toolu_a', params: inCall('toolu_a') })
    const second = $.tool.call({ tool: tn('ask'), tool_use_id: 'toolu_b', params: inCall('toolu_b') })
    await letItRun(world)
    expect(denyOf(await first)).toBeUndefined()
    expect(denyOf(await second)).toBeUndefined()
    expect(world.asks.length).toBe(1)
    expect(world.asks[0]?.question).toContain(RERUN) // the call's question, not the notice's
    expect(world.spawns.length).toBe(2)
    expect(calls(world, 1, 'ask').map(c => c.params.callId).sort()).toEqual(['toolu_a-again', 'toolu_b-again'])
  })
})

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
