import { describe, expect, test } from 'claude-code/testing'
import { COMPOSE, START, resultText, slash, stage, tn } from './sim'

const BASE = [{ id: 'intro', text: 'Base prompt.', scope: 'shared' as const }]

describe('system prompt', () => {
  test('the host prompt sections are added as one session-scoped section after the engine sections', async ($, on) => {
    on('prompt.compose', () => ({ sections: BASE }))
    stage(on, { promptSections: [{ id: 'a', text: 'First DSH rule.' }, { id: 'b', text: 'Second DSH rule.' }] })
    await $.session.start(START)

    const { sections } = await $.prompt.compose(COMPOSE)
    expect(sections.map(s => s.id)).toEqual(['intro', 'dsh-fixture:dsh-prompt'])
    const added = sections[1]
    expect(added?.scope).toBe('session')
    expect(added?.text).toBe('First DSH rule.\n\nSecond DSH rule.')
  })

  test('no sections from the host means the engine prompt is left alone', async ($, on) => {
    on('prompt.compose', () => ({ sections: BASE }))
    stage(on, {})
    await $.session.start(START)
    expect((await $.prompt.compose(COMPOSE)).sections).toEqual(BASE)
  })

  test('promptChanged replaces the text', async ($, on) => {
    on('prompt.compose', () => ({ sections: BASE }))
    const world = stage(on, { tools: [{ dshName: 'reprompt' }], promptSections: [{ id: 'a', text: 'Old text.' }] })
    await $.session.start(START)
    await $.tool.call({ tool: tn('reprompt') })
    await world.clock.settle()
    const { sections } = await $.prompt.compose(COMPOSE)
    expect(sections[1]?.text).toBe('Changed prompt text.')
  })
})

describe('commands', () => {
  test('DSH commands are registered and a run goes to commands.run with the arguments', async ($, on) => {
    const world = stage(on, { commands: [{ name: 'review', description: 'Review the change' }] })
    await $.session.start(START)

    expect(world.commands.map(c => c.name)).toEqual(['dsh-fixture-ui', 'dsh-fixture-status', 'dsh-fixture-restart', 'dsh-fixture-trust', 'review'])
    expect(world.commands[4]?.description).toBe('Review the change')

    const out = await $.command.run(slash('review', 'src/a.ts --deep'))
    expect(out.text).toBe('ran command review with args "src/a.ts --deep"')
    const call = world.cores[0]?.calls.find(c => c.method === 'commands.run')
    expect(call?.params).toEqual({ name: 'review', args: 'src/a.ts --deep' })
  })

  test('a command this plugin does not own goes on to the engine', async ($, on) => {
    on('command.run', (_, e) => ({ text: `engine ran ${e.command}` }))
    stage(on, { commands: [{ name: 'review', description: 'Review' }] })
    await $.session.start(START)
    expect((await $.command.run(slash('compact'))).text).toBe('engine ran compact')
  })

  test('/<plugin>-status shows the host state and the status RPC', async ($, on) => {
    stage(on, { tools: [{ dshName: 'echo' }], promptSections: [{ id: 'a', text: 'Some text.' }] })
    await $.session.start(START)
    const text = (await $.command.run(slash('dsh-fixture-status'))).text ?? ''
    expect(text).toContain('Fixture plugin (dsh-fixture)')
    expect(text).toContain('host: ready on 127.0.0.1:40001')
    expect(text).toContain('state: ready')
    expect(text).toContain('services: ["fake-service"]')
    expect(text).toContain('tools registered: 1') // the static-only tool is no longer provided once the host lists its own
    expect(text).toContain('last error: none')
    expect(text).toContain('model calls from the plugin: allowed; subagents: allowed')
    // the token never appears
    expect(text).not.toContain('fake-token')
  })

  test('/<plugin>-restart stops the host (dispose) and starts a new one', async ($, on) => {
    const world = stage(on, { tools: [{ dshName: 'echo' }] })
    await $.session.start(START)
    const restarted = $.command.run(slash('dsh-fixture-restart'))
    await world.clock.settle()
    await world.clock.advance(10) // the old host leaves 10 ms after dispose; the mod waits for that
    const text = (await restarted).text
    expect(text).toContain('restarted, the plugin host is ready')
    expect(world.spawns.length).toBe(2)
    expect(world.cores[0]?.calls.map(c => c.method)).toContain('dispose')
    // the new host answers calls
    expect(resultText(await $.tool.call({ tool: tn('echo'), v: 1 }))).toContain('echo')
    expect(world.cores[1]?.calls.map(c => c.method)).toContain('tools.call')
    expect(world.cores[0]?.calls.map(c => c.method)).not.toContain('tools.call')
  })
})
