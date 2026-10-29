// The generated fixture mod against the fake host as a REAL child process.
//
// `claude plugin test` cannot spawn processes or open sockets, so this test transpiles the fixture's
// register.ts with esbuild, loads it in Node and hands it a small `$` of my own: process.spawn over
// child_process, http.fetch over fetch, clock.after over setTimeout. It checks the pieces `plugin test`
// cannot: real stdout chunking, the loopback HTTP + Bearer token, dispose ending the child.
// The `$` shim is my approximation of the engine (hypothesis: close enough for these paths), not the engine.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixture')

let esbuild
try {
  esbuild = await import('esbuild')
} catch {
  esbuild = undefined
}

async function loadMod(options = {}) {
  // Bundled, so register.ts's own import (hooks/rewrite-shared.ts) comes along; claude-code is types only.
  const built = await esbuild.build({ entryPoints: [join(fixture, 'hooks', 'register.ts')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', external: ['claude-code'] })
  const code = built.outputFiles[0].text
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mod-live-'))
  const file = join(dir, 'register.mjs')
  await writeFile(file, code)
  const { register } = await import(pathToFileURL(file).href)
  const hooks = []
  register((event, ...rest) => {
    const hook = rest.at(-1)
    const matcher = rest.length === 2 ? rest[0] : undefined
    const entry = { event, matcher, hook, catcher: undefined }
    hooks.push(entry)
    return { catch: fn => ((entry.catcher = fn), undefined) }
  }, options)

  const world = { registered: [], commands: [], logs: [], statuses: [], children: [] }
  const killers = []
  const $ = {
    plugin: { name: 'dsh-fixture', root: fixture },
    clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) } } },
    http: {
      fetch: async (url, init) => {
        const r = await fetch(url, init)
        return { status: r.status, ok: r.ok, headers: {}, text: await r.text() }
      },
    },
    process: {
      spawn(request) {
        const child = spawn(request.argv[0] === 'node' ? process.execPath : request.argv[0], request.argv.slice(1), {
          cwd: request.cwd,
          env: { ...process.env, ...request.env, FAKE_HOST_CONFIG: JSON.stringify(world.hostConfig ?? {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        world.children.push(child)
        const queue = []
        let wake
        let result
        const push = stream => c => (queue.push({ stream, text: c.toString('utf8') }), wake?.())
        child.stdout.on('data', push('stdout'))
        child.stderr.on('data', push('stderr'))
        child.on('exit', (code, signal) => ((result = { code, signal }), wake?.()))
        killers.push(() => child.kill())
        return (async function* () {
          for (;;) {
            if (queue.length) yield queue.shift()
            else if (result) return result
            else await new Promise(r => (wake = r))
          }
        })()
      },
    },
    tool: { register: async spec => (world.registered.push(spec.name), { tool: `mcp__dsh-fixture__${spec.name}` }) },
    command: { register: async spec => (world.commands.push(spec.name), { command: spec.name }) },
    ui: { log: (t, o) => o?.to !== 'debug' && world.logs.push(t), status: t => world.statuses.push(t), toast() {}, ask: async () => 'Approve' },
    session: { model: async () => 'test-model' },
  }
  const run = async (event, e, matchOf = x => x) => {
    const entries = hooks.filter(h => h.event === event && (h.matcher === undefined || Object.entries(h.matcher).every(([k, v]) => e[k] === v)))
    const next = Object.assign(async x => x, { signal: new AbortController().signal, called: false, error: {} })
    for (const h of entries) {
      try {
        const answer = await h.hook($, e, next)
        if (answer !== e) return answer
      } catch (err) {
        if (h.catcher) return h.catcher($, e, Object.assign(next, { error: { message: err.message, kind: 'throw' } }))
        throw err
      }
    }
    return e
  }
  return { world, $, run, stop: () => killers.forEach(k => k()) }
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true }

test('real child: ready over stdout, a tool call over loopback HTTP with the token, dispose ends the child', { skip: esbuild === undefined && 'esbuild is not installed' }, async () => {
  const mod = await loadMod()
  mod.world.hostConfig = { tools: [{ dshName: 'echo' }], commands: [{ name: 'review', description: 'Review' }], promptSections: [{ id: 'p', text: 'Real prompt text.' }] }
  try {
    await mod.run('session.start', START)
    assert.deepEqual(mod.world.registered, ['static_only', 'echo'])
    assert.ok(mod.world.commands.includes('review'))

    const call = await mod.run('tool.call', { tool: 'mcp__dsh-fixture__echo', tool_use_id: 'toolu_1', a: 1 })
    assert.deepEqual(call.result, [{ type: 'text', text: '{"name":"echo","args":{"a":1}}' }])

    const cmd = await mod.run('command.run', { command: 'review', args: 'now' })
    assert.equal(cmd.text, 'ran command review with args "now"')

    const status = await mod.run('command.run', { command: 'dsh-fixture-status' })
    assert.match(status.text, /host: ready on 127\.0\.0\.1:\d+/)
    assert.doesNotMatch(status.text, /[0-9a-f]{64}/, 'the token must not be printed')

    const exited = new Promise(resolve => mod.world.children[0].on('exit', (code) => resolve(code)))
    await mod.run('session.end', { reason: 'other', sessionId: 's', resume: { id: 's' } })
    assert.equal(await exited, 0)
  } finally {
    mod.stop()
  }
})

test('real child: a fatal start is shown with its real message', { skip: esbuild === undefined && 'esbuild is not installed' }, async () => {
  const mod = await loadMod()
  mod.world.hostConfig = { fatal: 'Could not resolve "left-pad"' }
  try {
    await mod.run('session.start', START)
    const answer = await mod.run('tool.call', { tool: 'mcp__dsh-fixture__static_only', tool_use_id: 'toolu_2' })
    assert.match(answer.deny, /Could not resolve "left-pad"/)
    assert.equal(mod.world.statuses.at(-1), 'Fixture plugin: Could not resolve "left-pad"')
  } finally {
    mod.stop()
  }
})

test('real child: output arriving in tiny pieces is reassembled', { skip: esbuild === undefined && 'esbuild is not installed' }, async () => {
  // Wrap the child's stdout so every chunk is split in 3-character pieces.
  const mod = await loadMod()
  mod.world.hostConfig = { tools: [{ dshName: 'echo' }], promptSections: [{ id: 'p', text: 'A long enough prompt section text to cross many pieces.' }] }
  const original = mod.$.process.spawn
  mod.$.process.spawn = request => {
    const inner = original(request)
    return (async function* () {
      for (;;) {
        const step = await inner.next()
        if (step.done) return step.value
        for (let i = 0; i < step.value.text.length; i += 3) yield { stream: step.value.stream, text: step.value.text.slice(i, i + 3) }
      }
    })()
  }
  try {
    await mod.run('session.start', START)
    assert.deepEqual(mod.world.registered, ['static_only', 'echo'])
  } finally {
    mod.stop()
  }
})
