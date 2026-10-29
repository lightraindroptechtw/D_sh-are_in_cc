import { describe, expect, test } from 'claude-code/testing'
import { START, denyOf, resultText, stage, tn } from './sim'

describe('tools', () => {
  test('registers the static tool at once, then the tools the host reports, and spawns the host as the spec says', async ($, on) => {
    const world = stage(on, { tools: [{ dshName: 'echo', description: 'Echo it' }, { dshName: 'web.search', name: 'web.search' }] })
    await $.session.start(START)

    // static_only is listed first (from the config), then the host's own list; the dot is not a valid name char.
    expect(world.registered.map(t => t.name)).toEqual(['static_only', 'echo', 'web_search'])
    expect(world.registered[1]?.description).toBe('Echo it')

    expect(world.spawns.length).toBe(1)
    const spawn = world.spawns[0]
    expect(spawn?.argv[0]).toBe('node')
    expect(spawn?.argv[1]).toMatch(/runtime\/claude-host\.mjs$/)
    expect(spawn?.cwd).toBeDefined()
    expect(spawn?.argv[1]).toStartWith(spawn?.cwd ?? '?')
  })

  test('a call round-trips: tools.call with the DSH name, the arguments and the call id', async ($, on) => {
    const world = stage(on, { tools: [{ dshName: 'echo' }] })
    await $.session.start(START)

    const answer = await $.tool.call({ tool: tn('echo'), query: 'hello', limit: 3 })
    expect(denyOf(answer)).toBeUndefined()
    expect(resultText(answer)).toBe('{"name":"echo","args":{"query":"hello","limit":3}}')

    const call = world.cores[0]?.calls.find(c => c.method === 'tools.call')
    expect(call?.params.name).toBe('echo')
    expect(call?.params.args).toEqual({ query: 'hello', limit: 3 })
    expect(typeof call?.params.callId).toBe('string')
  })

  test('a name that maps to the same short name gets a different one, and calls reach the right DSH tool', async ($, on) => {
    const world = stage(on, { tools: [{ dshName: 'a.b' }, { dshName: 'a_b' }] })
    await $.session.start(START)
    expect(world.registered.map(t => t.name)).toEqual(['static_only', 'a_b', 'a_b_2'])

    const answer = await $.tool.call({ tool: tn('a_b_2'), x: 1 })
    expect(resultText(answer)).toContain('ran a_b with')
  })

  test('a tool error from the host refuses the call with the host text', async ($, on) => {
    stage(on, { tools: [{ dshName: 'fail' }] })
    await $.session.start(START)
    expect(denyOf(await $.tool.call({ tool: tn('fail') }))).toBe('the tool failed on purpose')
  })

  test('the host output split anywhere in a line is still read (chunk boundaries)', async ($, on) => {
    const world = stage(on, { tools: [{ dshName: 'echo' }], promptSections: [{ id: 'p', text: 'Split prompt text.' }] }, { chunkSize: 5 })
    await $.session.start(START)
    expect(world.registered.map(t => t.name)).toEqual(['static_only', 'echo'])
    expect(resultText(await $.tool.call({ tool: tn('echo') }))).toContain('echo')
  })

  test(
    'cancel: when the call is abandoned the mod sends tools.cancel and stops waiting',
    {
      plugins: [
        {
          name: 'impatient',
          tier: 'prepend',
          register(on) {
            // Returns while `next` is still pending: that aborts what runs beneath (next.signal of the bridge's hook).
            on('tool.call', async ($, e, next) => {
              if (e.tool !== 'mcp__dsh-fixture__slow') return next(e)
              void next(e).catch(() => {})
              await $.clock.sleep(10)
              return { deny: 'impatient' }
            })
          },
        },
      ],
    },
    async ($, on) => {
      const world = stage(on, { tools: [{ dshName: 'slow', delayMs: 60000 }] })
      await $.session.start(START)

      const call = $.tool.call({ tool: tn('slow') })
      await world.clock.settle()
      expect(world.methods()).toContain('tools.call')
      expect(world.methods()).not.toContain('tools.cancel')

      await world.clock.advance(10)
      expect(denyOf(await call)).toBe('impatient')
      await world.clock.settle()

      const started = world.cores[0]?.calls.find(c => c.method === 'tools.call')
      const cancel = world.cores[0]?.calls.find(c => c.method === 'tools.cancel')
      expect(cancel).toBeDefined()
      expect(cancel?.params.callId).toBe(started?.params.callId)
    },
  )

  test('timeout: a call that outlasts callTimeoutMs fails and tells the host to cancel', async ($, on) => {
    const world = stage(on, { tools: [{ dshName: 'slow', delayMs: 60000 }] })
    await $.session.start(START)

    const call = $.tool.call({ tool: tn('slow') })
    await world.clock.settle()
    expect(world.methods()).not.toContain('tools.cancel')
    await world.clock.advance(3000) // callTimeoutMs of the fixture: the host's own limit; the mod waits a little longer for its answer
    await world.clock.settle()
    expect(world.methods()).not.toContain('tools.cancel')
    await world.clock.advance(5000) // HOST_TIMEOUT_GRACE_MS of the mod
    const answer = await call
    expect(denyOf(answer)).toMatch(/slow failed: tools\.call timed out after 8000 ms/)
    await world.clock.settle()
    expect(world.methods()).toContain('tools.cancel')
    const cancel = world.cores[0]?.calls.find(c => c.method === 'tools.cancel')
    const started = world.cores[0]?.calls.find(c => c.method === 'tools.call')
    expect(cancel?.params.callId).toBe(started?.params.callId)
  })

  test('toolsChanged: a new tool is registered, a removed one is refused with a clear message', async ($, on) => {
    const world = stage(on, { tools: [{ dshName: 'echo' }, { dshName: 'grow' }, { dshName: 'shrink' }] })
    await $.session.start(START)
    expect(world.registered.map(t => t.name)).toEqual(['static_only', 'echo', 'grow', 'shrink'])

    await $.tool.call({ tool: tn('grow') })
    await world.clock.settle()
    expect(world.registered.map(t => t.name)).toEqual(['static_only', 'echo', 'grow', 'shrink', 'extra3'])
    expect(resultText(await $.tool.call({ tool: tn('extra3') }))).toContain('ran extra3')

    await $.tool.call({ tool: tn('shrink') })
    await world.clock.settle()
    const gone = await $.tool.call({ tool: tn('echo') })
    expect(denyOf(gone)).toMatch(/echo is no longer provided by the plugin/)
  })

  test('re-registering is skipped for an unchanged tool', async ($, on) => {
    const world = stage(on, { tools: [{ dshName: 'echo' }, { dshName: 'grow' }] })
    await $.session.start(START)
    const before = world.registered.length
    await $.tool.call({ tool: tn('grow') })
    await world.clock.settle()
    // only the new tool was registered
    expect(world.registered.length).toBe(before + 1)
  })
})
