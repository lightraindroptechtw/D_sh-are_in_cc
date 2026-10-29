import { describe, expect, test } from 'claude-code/testing'
import { PLUGIN, START, denyOf, resultText, slash, stage, tn } from './sim'

const CORDIS = 'Cordis: property "inject" is already declared as accessor'
const END = (reason: 'other' | 'clear') => ({ reason, sessionId: 's1', resume: { id: 's1' } }) as const

describe('fatal', () => {
  test('the real message is shown in the status line and the transcript, and every tool call fails with it', async ($, on) => {
    const world = stage(on, { fatal: `${CORDIS}\n    at somewhere (lib.js:1:1)` })
    await $.session.start(START)

    expect(world.statuses.at(-1)).toBe(`Fixture plugin: ${CORDIS}`) // first line only
    const logged = world.logs.find(l => l.includes(CORDIS))
    expect(logged).toBeDefined()
    expect(logged).toContain('[FAKE_FATAL]')
    expect(logged).toContain('/dsh-fixture-status')
    expect(logged).toContain('/dsh-fixture-restart')

    const answer = await $.tool.call({ tool: tn('static_only') })
    expect(denyOf(answer)).toContain(CORDIS)
    expect(denyOf(answer)).toContain('static_only cannot run')
  })

  test('/<plugin>-status reports the fatal state and the last error', async ($, on) => {
    stage(on, { fatal: CORDIS })
    await $.session.start(START)
    const text = (await $.command.run(slash('dsh-fixture-status'))).text ?? ''
    expect(text).toContain('host: fatal')
    expect(text).toContain(`last error: ${CORDIS}`)
  })

  test('/<plugin>-restart recovers after a fatal start', async ($, on) => {
    const world = stage(on, spawn => (spawn === 1 ? { fatal: CORDIS } : { tools: [{ dshName: 'echo' }] }))
    await $.session.start(START)
    expect(denyOf(await $.tool.call({ tool: tn('static_only') }))).toContain(CORDIS)

    const text = (await $.command.run(slash('dsh-fixture-restart'))).text
    expect(text).toContain('restarted, the plugin host is ready')
    expect(world.spawns.length).toBe(2)
    expect(world.statuses.at(-1)).toBeUndefined() // the status line is cleared
    expect(resultText(await $.tool.call({ tool: tn('echo'), v: 1 }))).toContain('echo')
    expect((await $.command.run(slash('dsh-fixture-status'))).text).toContain('last error: none')
  })

  test('the host cannot be started: the spawn error is the message', async ($, on) => {
    stage(on, {}, { spawnError: 'spawn node ENOENT' })
    await $.session.start(START)
    const answer = await $.tool.call({ tool: tn('static_only') })
    expect(denyOf(answer)).toContain('could not run "node runtime/claude-host.mjs"')
    expect(denyOf(answer)).toContain('spawn node ENOENT')
  })

  test('the host exits before it is ready: exit code and the end of its stderr are in the message', async ($, on) => {
    stage(on, { crashBeforeReady: 2 })
    await $.session.start(START)
    const answer = await $.tool.call({ tool: tn('static_only') })
    expect(denyOf(answer)).toContain('exited before it was ready (exit code 2): host crashed with 2')
  })

  test('the host never says ready: a startup timeout, with the real wait time', async ($, on) => {
    const world = stage(on, { readyDelayMs: 600000 })
    const starting = $.session.start(START)
    await world.clock.settle()
    await world.clock.advance(5000) // startupTimeoutMs of the fixture
    await starting
    const answer = await $.tool.call({ tool: tn('static_only') })
    expect(denyOf(answer)).toContain('did not send "ready" within 5000 ms')
  })

  test('the host dies after it was ready: calls say so and the status line shows it', async ($, on) => {
    const world = stage(on, { tools: [{ dshName: 'echo' }] })
    await $.session.start(START)
    world.crash(3)
    await world.clock.settle()
    const answer = await $.tool.call({ tool: tn('echo') })
    expect(denyOf(answer)).toContain('the plugin host exited unexpectedly (exit code 3): host crashed with 3')
    // Shown once the session did not end meanwhile (Claude Code ending kills the child first).
    expect(world.statuses.filter(s => s?.includes('exited unexpectedly') === true).length).toBe(0)
    await world.clock.advance(3000)
    expect(world.statuses.at(-1)).toContain('exited unexpectedly')
    expect(world.logs.some(l => l.includes('exited unexpectedly') && l.includes('/dsh-fixture-restart'))).toBe(true)
    expect((await $.command.run(slash('dsh-fixture-status'))).text).toContain('host: stopped')
  })

  test('the host ends as the session ends (Claude Code exiting kills it first, exit code 1 on Windows): nothing is shown', async ($, on) => {
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    const world = stage(on, { tools: [{ dshName: 'echo' }] })
    await $.session.start(START)
    world.crash(1)
    await world.clock.settle()
    await $.session.end(END('other'))
    await world.clock.advance(3000)
    expect(world.statuses.some(s => s?.includes('exited unexpectedly') === true)).toBe(false)
    expect(world.logs.some(l => l.includes('exited unexpectedly'))).toBe(false)
    expect(world.debugLogs.some(l => l.includes('not shown'))).toBe(true)
  })
})

describe('startup', () => {
  test('a call made while the host is still starting waits for it', async ($, on) => {
    const world = stage(on, { readyDelayMs: 3000, tools: [{ dshName: 'static_only' }] })
    const starting = $.session.start(START)
    await world.clock.settle()
    const call = $.tool.call({ tool: tn('static_only') })
    await world.clock.settle()
    expect(world.cores[0]?.calls.length).toBe(0)
    await world.clock.advance(3000)
    await starting
    expect(resultText(await call)).toContain('ran static_only')
  })

  test('non-protocol lines and unknown message types on stdout are ignored', async ($, on) => {
    const world = stage(on, { noise: true, tools: [{ dshName: 'echo' }] })
    await $.session.start(START)
    expect(world.registered.map(t => t.name)).toEqual(['static_only', 'echo'])
    expect(world.logs.length).toBe(0) // nothing is shown to the person
    expect(world.debugLogs.join(' | ')).toContain('non-protocol output from the host')
    expect(world.debugLogs.join(' | ')).toContain('unknown host message type "surprise"')
  })

  test('the child gets the plugin root as its working directory and no token in its environment', async ($, on) => {
    const world = stage(on, {})
    await $.session.start(START)
    const spawn = world.spawns[0]
    expect(spawn?.env).toBeDefined()
    // The names the child host reads: the plugin name (own tools are not intercepted twice) and the session's directory (its fs workspace).
    expect(Object.keys(spawn?.env ?? {}).sort()).toEqual([
      'DSH_CLAUDE_ALLOW_DIRECT_EXEC',
      'DSH_CLAUDE_ALLOW_INTERCEPTION',
      'DSH_CLAUDE_BRIDGE',
      'DSH_CLAUDE_EXTRA_FOLDERS',
      'DSH_CLAUDE_PLUGIN_NAME',
      'DSH_CLAUDE_PLUGIN_ROOT',
      'DSH_CLAUDE_SECRET_NAMES',
      'DSH_CLAUDE_WORKSPACE',
    ])
    // SECURITY-PLAN.md 約定 3, with the options at their defaults and no key filled in
    expect(spawn?.env?.DSH_CLAUDE_ALLOW_DIRECT_EXEC).toBe('0')
    expect(spawn?.env?.DSH_CLAUDE_ALLOW_INTERCEPTION).toBe('0')
    expect(spawn?.env?.DSH_CLAUDE_EXTRA_FOLDERS).toBe('')
    expect(spawn?.env?.DSH_CLAUDE_SECRET_NAMES).toBe('')
    expect(spawn?.env?.DSH_CLAUDE_PLUGIN_ROOT).toBe(spawn?.cwd)
    expect(spawn?.env?.DSH_CLAUDE_PLUGIN_NAME).toBe(PLUGIN)
    expect(spawn?.env?.DSH_CLAUDE_WORKSPACE).toBe(START.cwd)
  })
})

describe('session end', () => {
  test('sends dispose when the session ends', async ($, on) => {
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    const world = stage(on, {})
    await $.session.start(START)
    const ended = $.session.end(END('other'))
    await world.clock.settle()
    await world.clock.advance(10) // the fake host leaves 10 ms after dispose; the mod waits for that before it kills the child
    await ended
    expect(world.methods()).toContain('dispose')
    expect(world.killed).toBe(0) // it left on its own: the mod did not have to kill it
  })

  test('a /clear keeps the host running (no session.start follows it)', async ($, on) => {
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    const world = stage(on, { tools: [{ dshName: 'echo' }] })
    await $.session.start(START)
    await $.session.end(END('clear'))
    expect(world.methods()).not.toContain('dispose')
    expect(resultText(await $.tool.call({ tool: tn('echo') }))).toContain('echo')
  })
})
