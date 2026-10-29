// Builds tests/claude-mod/fixture/ from templates/claude-mod/ the way the converter will:
// placeholders in plugin.json, the config JSON in place of "__DSH_BRIDGE_CONFIG__" in register.ts.
// Hand-written files in fixture/tests/ are left alone.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const templates = join(here, '..', '..', 'templates', 'claude-mod')
const out = join(here, 'fixture')

export const FIXTURE_CONFIG = {
  schemaVersion: 1,
  pluginName: 'dsh-fixture',
  displayName: 'Fixture plugin',
  hostEntry: 'runtime/claude-host.mjs',
  node: 'node',
  startupTimeoutMs: 5000,
  callTimeoutMs: 3000,
  features: { tools: true, commands: true, systemPrompt: true, interception: false, ui: true },
  staticTools: [
    {
      dshName: 'static_only',
      name: 'static_only',
      description: 'A tool known from static analysis only.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  // What the converter adds (SECURITY-PLAN.md 約定 2).
  outboundTools: [
    { name: 'post_comment', dshName: 'post_comment', kind: 'comment', targetFields: ['bvid'], textFields: ['text'], summary: '在影片底下發留言' },
    { name: 'send_raw', dshName: 'send_raw', kind: 'message', targetFields: [], textFields: [], summary: '' },
    { name: 'post_fail', dshName: 'post_fail', kind: 'post', targetFields: ['to'], textFields: ['text'], summary: '發一則一定失敗的貼文' },
  ],
  secretOptions: [
    { option: 'secret_FIXTURE_API_KEY', env: 'FIXTURE_API_KEY', title: 'Fixture API 金鑰', features: '假搜尋', required: true },
    { option: 'secret_FIXTURE_PIN', env: 'FIXTURE_PIN', title: '短 PIN', features: '', required: false },
  ],
}

/** The fields the converter merges into the manifest for the keys (SECURITY-PLAN.md 約定 1). */
export function withSecretFields(manifest, secretOptions) {
  const userConfig = { ...(manifest.userConfig ?? {}) }
  for (const s of secretOptions) {
    userConfig[s.option] = {
      type: 'string',
      sensitive: true,
      title: s.title,
      description: `${s.title}：${s.features || '插件'}需要它。`,
    }
  }
  return { ...manifest, userConfig }
}

export function applyPluginJson(template, { name, version, description }) {
  // JSON.stringify(...).slice(1, -1) keeps the escaping right inside the quoted placeholder.
  const inner = value => JSON.stringify(value).slice(1, -1)
  return template
    .replaceAll('__DSH_PLUGIN_NAME__', inner(name))
    .replaceAll('__DSH_PLUGIN_VERSION__', inner(version))
    .replaceAll('__DSH_PLUGIN_DESCRIPTION__', inner(description))
}

export function applyRegister(template, config) {
  const placeholder = '"__DSH_BRIDGE_CONFIG__"'
  if (!template.includes(placeholder)) throw new Error('register.ts template has no "__DSH_BRIDGE_CONFIG__" placeholder')
  return template.replace(placeholder, () => JSON.stringify(config))
}

export async function buildFixture() {
  const pluginJson = applyPluginJson(await readFile(join(templates, 'plugin.json'), 'utf8'), {
    name: FIXTURE_CONFIG.pluginName,
    version: '0.0.1',
    description: 'Fixture plugin for the DSH bridge mod tests.',
  })
  const manifest = withSecretFields(JSON.parse(pluginJson), FIXTURE_CONFIG.secretOptions)
  await mkdir(join(out, '.claude-plugin'), { recursive: true })
  await mkdir(join(out, 'hooks'), { recursive: true })
  await mkdir(join(out, 'runtime'), { recursive: true })
  await writeFile(join(out, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await copyFile(join(templates, 'hooks.json'), join(out, 'hooks', 'hooks.json'))
  await writeFile(join(out, 'hooks', 'register.ts'), applyRegister(await readFile(join(templates, 'register.ts'), 'utf8'), FIXTURE_CONFIG))
  await writeFile(join(out, 'hooks', 'rewrite-shared.ts'), await readFile(join(templates, 'rewrite-shared.ts'), 'utf8'))
  await copyFile(join(here, 'fake-host.mjs'), join(out, 'runtime', 'claude-host.mjs'))
  await copyFile(join(here, 'fake-host-core.mjs'), join(out, 'runtime', 'fake-host-core.mjs'))
  await copyFile(join(here, 'fake-host-core.d.mts'), join(out, 'runtime', 'fake-host-core.d.mts'))
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`fixture written to ${await buildFixture()}`)
}
