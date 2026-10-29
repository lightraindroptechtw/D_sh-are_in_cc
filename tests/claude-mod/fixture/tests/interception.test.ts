import { describe, expect, test } from 'claude-code/testing'
import { START, denyOf, slash, stage, tn } from './sim'

const HOST = { interception: true, tools: [{ dshName: 'echo' }, { dshName: 'ask' }] }
/** Interception runs only once the person turns it on (SECURITY-PLAN.md 第 5 項). */
const ON = { options: { allowInterception: true } } as const

/** The engine's Bash tool, beneath the plugins: remembers the input it ran with. */
function bash(on: Parameters<typeof stage>[0], ran: string[], output = 'ok') {
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    ran.push(e.command)
    return { result: { stdout: output } }
  })
}

describe('interception', () => {
  test('allow: the call reaches the tool, then the result goes to interception.post', ON, async ($, on) => {
    const ran: string[] = []
    bash(on, ran)
    const world = stage(on, HOST)
    await $.session.start(START)

    const r = await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    expect(denyOf(r)).toBeUndefined()
    expect(ran).toEqual(['ls -la'])
    const pre = world.cores[0]?.calls.find(c => c.method === 'interception.pre')
    expect(pre?.params.tool).toBe('Bash')
    expect(pre?.params.input).toEqual({ command: 'ls -la' })
    const post = world.cores[0]?.calls.find(c => c.method === 'interception.post')
    expect(post?.params.tool).toBe('Bash')
    expect(String(post?.params.result)).toContain('ok')
  })

  test('deny: the reason is the refusal and the tool never runs', ON, async ($, on) => {
    const ran: string[] = []
    bash(on, ran)
    const world = stage(on, HOST)
    await $.session.start(START)

    const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf forbidden' })
    expect(denyOf(r)).toBe('blocked by the fake host: Bash')
    expect(ran).toEqual([])
    expect(world.methods()).not.toContain('interception.post')
  })

  test('allow with a rewritten input: the rewrite is ignored, the tool runs with the original input', ON, async ($, on) => {
    const ran: string[] = []
    bash(on, ran)
    const world = stage(on, HOST)
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'rewrite-me' })
    expect(ran).toEqual(['rewrite-me'])
    expect(world.debugLogs.join(' | ')).toContain('sent a rewritten input; ignored')
  })

  test('post: a replacement text from the host is added for the model as context', ON, async ($, on) => {
    bash(on, [], 'post-me please')
    stage(on, HOST)
    await $.session.start(START)
    const r = (await $.tool.call({ tool: 'Bash', command: 'ls' })) as { context?: string[] }
    expect(r.context?.join('\n')).toContain('Fixture plugin (after Bash): the fake host saw post-me')
  })

  test("the plugin's own tools are not intercepted", ON, async ($, on) => {
    const world = stage(on, HOST)
    await $.session.start(START)
    await $.tool.call({ tool: tn('echo'), forbidden: true })
    expect(world.methods()).not.toContain('interception.pre')
    expect(world.methods()).toContain('tools.call')
  })

  test("the plugin's own approval dialog is not intercepted (no loop)", ON, async ($, on) => {
    const world = stage(on, { ...HOST, reverse: 'approval' })
    await $.session.start(START)
    await $.tool.call({ tool: tn('ask') })
    expect(world.asks.length).toBe(1)
    const pres = world.cores[0]?.calls.filter(c => c.method === 'interception.pre') ?? []
    expect(pres.map(c => c.params.tool)).not.toContain('AskUserQuestion')
  })

  test('off when the host says interception is false: other tools pass straight through', ON, async ($, on) => {
    const ran: string[] = []
    bash(on, ran)
    const world = stage(on, { tools: [{ dshName: 'echo' }] })
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'rm -rf forbidden' })
    expect(ran).toEqual(['rm -rf forbidden'])
    expect(world.methods()).not.toContain('interception.pre')
  })

  test('fails closed: when the host is gone the guard refuses instead of letting the call through', ON, async ($, on) => {
    const ran: string[] = []
    bash(on, ran)
    const world = stage(on, HOST)
    await $.session.start(START)
    world.crash(1)
    await world.clock.settle()

    const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(denyOf(r)).toContain('its guard could not judge this Bash call')
    expect(denyOf(r)).toContain('/dsh-fixture-restart')
    expect(ran).toEqual([])
  })

  test('off by default even when the host reports guards: nothing is asked, the call runs, one toast at the start', async ($, on) => {
    const ran: string[] = []
    bash(on, ran)
    const world = stage(on, { ...HOST, metadata: { listeners: { preExecute: 1, postExecute: 0 } } })
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'rm -rf forbidden' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(ran).toEqual(['rm -rf forbidden', 'ls'])
    expect(world.methods()).not.toContain('interception.pre')
    const notices = world.toasts.filter(t => t.includes('這個插件有監督 Claude 工具使用的功能，目前關閉'))
    expect(notices.length).toBe(1) // once, not per call
    expect(notices[0]).toContain('allowInterception')
    expect(world.spawns[0]?.env?.DSH_CLAUDE_ALLOW_INTERCEPTION).toBe('0')
    const status = (await $.command.run(slash('dsh-fixture-status'))).text ?? ''
    expect(status).toContain('目前受限的功能')
    expect(status).toContain('這個插件有監督 Claude 工具使用的功能，目前關閉')
    expect(status).toContain('allowInterception')
  })

  test('a host without guards gets no interception notice', async ($, on) => {
    const world = stage(on, { tools: [{ dshName: 'echo' }], metadata: { listeners: { preExecute: 0, postExecute: 0 } } })
    await $.session.start(START)
    expect(world.toasts.filter(t => t.includes('監督')).length).toBe(0)
  })

  test('turned on: the child is told so', ON, async ($, on) => {
    const world = stage(on, HOST)
    await $.session.start(START)
    expect(world.spawns[0]?.env?.DSH_CLAUDE_ALLOW_INTERCEPTION).toBe('1')
  })
})
