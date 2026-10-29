// The mod template as the converter will use it: placeholders, substitution, generated fixture up to date.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FIXTURE_CONFIG, applyPluginJson, applyRegister } from './build-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const templates = join(here, '..', '..', 'templates', 'claude-mod')
const read = async (...p) => readFile(join(...p), 'utf8')

test('plugin.json: three placeholders, the options of SECURITY-PLAN.md 約定 1 with their defaults, valid JSON once filled', async () => {
  const raw = await read(templates, 'plugin.json')
  for (const p of ['__DSH_PLUGIN_NAME__', '__DSH_PLUGIN_VERSION__', '__DSH_PLUGIN_DESCRIPTION__']) assert.equal(raw.split(p).length, 2, p)
  const description = 'He said "hi"\nand left \\ '
  const filled = JSON.parse(applyPluginJson(raw, { name: 'my-plugin', version: '1.2.3', description }))
  assert.equal(filled.name, 'my-plugin')
  assert.equal(filled.version, '1.2.3')
  assert.equal(filled.description, description)
  const expected = {
    allowModelCalls: ['boolean', true],
    allowAgents: ['boolean', true],
    allowInterception: ['boolean', false],
    allowFollowups: ['boolean', false],
    shareConversation: ['boolean', true],
    outboundMode: ['string', 'ask'],
    outboundHourlyLimit: ['number', 10],
    outboundDailyLimit: ['number', 50],
    allowDirectExec: ['boolean', false],
    extraFolders: ['string', ''],
  }
  assert.deepEqual(Object.keys(filled.userConfig).sort(), Object.keys(expected).sort())
  for (const [key, [type, value]] of Object.entries(expected)) {
    assert.equal(filled.userConfig[key].type, type, key)
    assert.equal(filled.userConfig[key].default, value, key)
    assert.ok(filled.userConfig[key].description.length > 10, key)
    assert.notEqual(filled.userConfig[key].sensitive, true, key)
  }
  assert.deepEqual(filled.userConfig.outboundMode.options, ['ask', 'auto', 'deny'])
})

test('fixture manifest: key fields are sensitive strings named secret_<variable>', async () => {
  const manifest = JSON.parse(await read(here, 'fixture', '.claude-plugin', 'plugin.json'))
  for (const s of FIXTURE_CONFIG.secretOptions) {
    assert.equal(s.option, `secret_${s.env}`)
    assert.equal(manifest.userConfig[s.option].type, 'string')
    assert.equal(manifest.userConfig[s.option].sensitive, true)
  }
})

test('hooks.json names the module', async () => {
  assert.deepEqual(JSON.parse(await read(templates, 'hooks.json')), { modules: ['./register.ts'] })
})

test('register.ts: the placeholder literal is there exactly once and nothing the engine refuses', async () => {
  const raw = await read(templates, 'register.ts')
  assert.equal(raw.split('"__DSH_BRIDGE_CONFIG__"').length, 2)
  assert.doesNotMatch(raw, /\bimport\s*\(/, 'import() does not load in a hooks module')
  assert.doesNotMatch(raw, /\brequire\s*\(/)
})

test('substitution puts the JSON in place of the literal, quotes included, even with awkward text', async () => {
  const raw = await read(templates, 'register.ts')
  const config = { ...FIXTURE_CONFIG, displayName: 'Tricky $& $1 `${x}` "quoted" \\   end', staticTools: [] }
  const out = applyRegister(raw, config)
  assert.equal(out.includes('__DSH_BRIDGE_CONFIG__'), false)
  const head = 'const RAW_CONFIG: unknown = '
  const literal = out.slice(out.indexOf(head) + head.length).split('\n')[0]
  assert.deepEqual(JSON.parse(literal), config)
})

test('the generated fixture is up to date with the templates (run build-fixture.mjs after a change)', async () => {
  const fixture = join(here, 'fixture')
  assert.equal(await read(fixture, 'hooks', 'register.ts'), applyRegister(await read(templates, 'register.ts'), FIXTURE_CONFIG))
  assert.equal(await read(fixture, 'hooks', 'hooks.json'), await read(templates, 'hooks.json'))
  assert.equal(await read(fixture, 'runtime', 'claude-host.mjs'), await read(here, 'fake-host.mjs'))
  assert.equal(await read(fixture, 'runtime', 'fake-host-core.mjs'), await read(here, 'fake-host-core.mjs'))
  const manifest = JSON.parse(await read(fixture, '.claude-plugin', 'plugin.json'))
  assert.equal(manifest.name, FIXTURE_CONFIG.pluginName)
  const template = JSON.parse(await read(templates, 'plugin.json'))
  for (const key of Object.keys(template.userConfig)) assert.deepEqual(manifest.userConfig[key], template.userConfig[key], key)
})
