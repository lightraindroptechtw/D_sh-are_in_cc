import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { wrapToolDefinition } from './output-normalization.mjs';
import {lazyDependenciesPlugin} from './lazy-dependencies.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hostAliases = new Map([
  ['@deepseek-ai/dsh-tools', join(here, 'shims/dsh-tools.mjs')],
  ['@deepseek-ai/schemastery', join(here, 'shims/schemastery.mjs')],
  ['schemastery', join(here, 'shims/schemastery.mjs')],
]);
const configMarker = Symbol.for('d-sh-are-in-cc.config-schema');
const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false, strictTuples: false, strictRequired: false, allowUnionTypes: true, validateSchema: false, ownProperties: true });

export class DshBridgeError extends Error {
  constructor(message, { code = 'DSH_BRIDGE_ERROR', unsupported = [], cause } = {}) {
    super(message, { cause }); this.name = 'DshBridgeError'; this.code = code; this.unsupported = unsupported;
  }
}
function json(value, label = 'value') {
  const seen = new Set();
  function visit(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0)) return v;
    if (!v || typeof v !== 'object' || seen.has(v)) throw new TypeError(`${label} must be lossless JSON`);
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new TypeError(`${label} must contain plain JSON objects`);
    if (Object.getOwnPropertySymbols(v).length) throw new TypeError(`${label} cannot contain symbol properties`);
    seen.add(v);
    let out;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) throw new TypeError(`${label} must contain dense JSON arrays`);
      out = Array.from(v, visit);
    } else {
      out = Object.create(null);
      for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
        if (!desc.enumerable || !('value' in desc)) throw new TypeError(`${label} cannot contain accessors or hidden properties`);
        out[key] = visit(desc.value);
      }
    }
    seen.delete(v); return out;
  }
  return visit(value);
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function validator(schema, label) {
  let validate;
  try { validate = ajv.compile(json(schema, `${label} schema`)); }
  catch (error) { throw new DshBridgeError(`Unsupported or invalid ${label} schema: ${error.message}`, { code: 'UNSUPPORTED_SCHEMA', cause: error }); }
  return value => {
    if (!validate(value)) throw new DshBridgeError(`Invalid ${label}: ${ajv.errorsText(validate.errors, { dataVar: label })}`, { code: 'VALIDATION_ERROR' });
  };
}
function applyDefaults(node, value) {
  if (value === undefined && Object.hasOwn(node.schema, 'default')) value = json(node.schema.default, 'configuration default');
  if (node.children && (value === undefined || value !== null && typeof value === 'object' && !Array.isArray(value))) {
    const out = Object.assign(Object.create(null), value ?? {});
    for (const [key, sub] of Object.entries(node.children)) {
      const next = applyDefaults(sub, out[key]);
      if (next !== undefined) out[key] = next;
    }
    value = out;
  }
  return value;
}
function contentBlocks(value) {
  if (!Array.isArray(value)) throw new DshBridgeError('Tool renderer must return a content array', { code: 'INVALID_RESULT' });
  return value.map(block => {
    const b = json(block, 'content block');
    if (b.type === 'text' && typeof b.text === 'string') return b;
    if (['image', 'audio'].includes(b.type) && typeof b.data === 'string' && typeof b.mimeType === 'string') return b;
    if (b.type === 'resource' && b.resource && typeof b.resource.uri === 'string' && (typeof b.resource.text === 'string' || typeof b.resource.blob === 'string')) return b;
    if (b.type === 'resource_link' && typeof b.uri === 'string' && typeof b.name === 'string') return b;
    throw new DshBridgeError(`Unsupported tool content block: ${String(b.type)}`, { code: 'UNSUPPORTED_CONTENT' });
  });
}
function legacyResult(value) {
  const safe = json(value, 'tool result');
  if (safe && !Array.isArray(safe) && typeof safe === 'object' && Array.isArray(safe.content)) {
    if (safe.isError !== undefined && typeof safe.isError !== 'boolean') throw new DshBridgeError('isError must be boolean', { code: 'INVALID_RESULT' });
    return { ...safe, content: contentBlocks(safe.content) };
  }
  return { content: [{ type: 'text', text: typeof safe === 'string' ? safe : JSON.stringify(safe) }], ...(safe && typeof safe === 'object' && !Array.isArray(safe) ? { structuredContent: safe } : {}) };
}

/** Compile only locally available source/dependencies. Never installs packages. */
export async function compileDshEntry({ entry, sourceRoot = dirname(resolve(entry)), outfile, portableRoot, nodePaths = [] }) {
  if (!entry || !outfile) throw new TypeError('compileDshEntry requires entry and outfile');
  const { build, transform } = await import('esbuild');
  const absoluteEntry = resolve(entry);
  const absoluteOutfile = resolve(outfile);
  const portableBase = portableRoot ? resolve(portableRoot) : undefined;
  const isPortableSource = file => {
    if (!portableBase) return false;
    const rel = relative(portableBase, file);
    return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
  };
  if (portableBase && !isPortableSource(absoluteEntry)) throw new TypeError('Portable entry must be within portableRoot');
  const relativeUrl = file => {
    const rel = relative(dirname(absoluteOutfile), file);
    if (isAbsolute(rel)) throw new TypeError('Portable source and outfile must share a filesystem root');
    return rel.split(/[\\/]/).map(encodeURIComponent).join('/');
  };
  const requireUrl = portableBase
    ? `new URL(${JSON.stringify(relativeUrl(absoluteEntry))}, import.meta.url)`
    : JSON.stringify(pathToFileURL(absoluteEntry).href);
  const result = await build({
    entryPoints: [absoluteEntry], absWorkingDir: resolve(sourceRoot), outfile, bundle: true, platform: 'node',
    format: 'esm', target: 'node22', sourcemap: false, logLevel: 'silent', metafile: true, nodePaths,
    // Bundled CommonJS dependencies may require builtins. Source dynamic requires remain source-relative.
    banner: { js: `import { createRequire as __dshBridgeRequire } from 'node:module'; const require = __dshBridgeRequire(${requireUrl});` },
    plugins: [{
      name: 'explicit-dsh-host-compatibility',
      setup(api) {
        api.onResolve({ filter: /^(?:@deepseek-ai\/|schemastery$)/ }, args => {
          if (hostAliases.has(args.path)) return { path: hostAliases.get(args.path) };
          throw new DshBridgeError(`Unsupported DSH host import: ${args.path}`, { code: 'UNSUPPORTED_HOST_IMPORT' });
        });
        api.onLoad({ filter: /\.(?:[cm]?[jt]sx?)$/ }, async args => {
          const ext = extname(args.path).slice(1);
          const loader = { mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts' }[ext] ?? ext;
          const portable = isPortableSource(args.path);
          const placeholder = `__dshBridgeModuleUrl_${createHash('sha256').update(portable ? relativeUrl(args.path) : args.path).digest('hex').slice(0, 16)}`;
          const transformed = await transform(await readFile(args.path, 'utf8'), {
            loader, target: 'node22', sourcefile: args.path,
            // Assets referenced from import.meta.url keep their original source location.
            // A placeholder separates the transformed source from the new bundle-relative
            // import.meta.url expression, preventing recursive replacement.
            define: { 'import.meta.url': portable ? placeholder : JSON.stringify(pathToFileURL(args.path).href) },
          });
          const prelude = portable ? `const ${placeholder} = new URL(${JSON.stringify(relativeUrl(args.path))}, import.meta.url).href;\n` : '';
          return { contents: prelude + transformed.code, loader: 'js', resolveDir: dirname(args.path) };
        });
      },
    },lazyDependenciesPlugin()],
  });
  return { outfile, inputs: Object.keys(result.metafile.inputs) };
}

/** Runs trusted plugin source in this process; this is an adapter, never a sandbox. */
export async function loadDshTools({ entry, config = {}, stateDir, sourceRoot, logger, prebundled = false, lenientOutput = false, nodePaths = [] }) {
  if (!entry) throw new TypeError('entry is required');
  const unsupported = [], cleanup = [], definitions = new Map(), controllers = new Set();
  let phase = 'initialization', disposed = false, temporary, executionQueue = Promise.resolve();
  const log = (level, ...args) => { const fn = typeof logger === 'function' ? logger : logger?.[level]; if (fn) fn.apply(logger, args); };
  const fail = feature => {
    const item = { feature, phase, message: `DSH host feature is unavailable in the Claude Code host: ${feature}` };
    unsupported.push(item);
    throw new DshBridgeError(item.message, { code: 'UNSUPPORTED_HOST_FEATURE', unsupported: [...unsupported] });
  };
  const register = (...args) => {
    if (phase !== 'initialization' || disposed) return fail('tools.register outside initialization');
    if (args.length !== 1) return fail('scoped tools.register');
    const spec = wrapToolDefinition(args[0],lenientOutput === true);
    if (!spec || typeof spec !== 'object') throw new TypeError('Tool definition must be an object');
    if (typeof spec.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(spec.name)) throw new TypeError('Tool name must be 1–128 letters, digits, _, - or .');
    if (definitions.has(spec.name)) throw new Error(`Duplicate tool name: ${spec.name}`);
    if (typeof spec.description !== 'string' || typeof spec.execute !== 'function') throw new TypeError(`Tool ${spec.name} needs description and execute`);
    for (const key of ['projectContent', 'finalizeContent']) if (spec[key] !== undefined) return fail(`tool.${key}`);
    if (spec.timeoutMs !== undefined && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)) throw new TypeError('timeoutMs must be a positive finite number');
    const inputSchema = freeze(json(spec.parameters ?? spec.inputSchema ?? { type: 'object', properties: {} }, 'tool parameters'));
    if (inputSchema.type !== 'object') throw new TypeError(`Tool ${spec.name} input schema must have type object`);
    const checkInput = validator(inputSchema, 'tool arguments');
    let output;
    if (spec.output !== undefined) {
      if (typeof spec.output?.render !== 'function') throw new TypeError('Tool output.render must be a function');
      output = { check: validator(spec.output.schema, 'tool output'), render: spec.output.render };
    }
    definitions.set(spec.name, { ...spec, inputSchema, checkInput, output });
    const unregister = () => definitions.delete(spec.name);
    cleanup.push(unregister); return unregister;
  };
  const toolService = new Proxy({ register }, { get(target, key) { return key in target ? target[key] : fail(`tools.${String(key)}`); } });
  const loggerObject = Object.fromEntries(['debug', 'info', 'warn', 'error', 'success'].map(level => [level, (...args) => log(level === 'success' ? 'info' : level, ...args)]));
  const values = {
    tools: toolService, logger: Object.assign(() => loggerObject, loggerObject),
    baseDir: stateDir ? resolve(stateDir) : undefined,
    effect(callback) {
      if (phase !== 'initialization') return fail('effect outside initialization');
      if (typeof callback !== 'function') throw new TypeError('effect requires a function');
      const dispose = callback();
      if (dispose?.then) return fail('asynchronous ctx.effect');
      if (dispose !== undefined && typeof dispose !== 'function') return fail('ctx.effect non-disposer result');
      if (dispose) cleanup.push(dispose);
      return dispose;
    },
    get(key) { if (Object.hasOwn(values, key)) return values[key]; return fail(`ctx.get(${String(key)})`); },
  };
  const ctx = new Proxy(values, { get(target, key) { return Object.hasOwn(target, key) ? target[key] : fail(`ctx.${String(key)}`); } });
  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const controller of controllers) controller.abort(new Error('DSH bridge disposed'));
    const errors = [];
    for (const fn of cleanup.splice(0).reverse()) { try { await fn(); } catch (error) { errors.push(error); } }
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed');
  }
  try {
    if (stateDir) await mkdir(resolve(stateDir), { recursive: true });
    let modulePath = resolve(entry);
    if (!prebundled) {
      temporary = await mkdtemp(join(tmpdir(), 'd-sh-are-in-cc-'));
      modulePath = join(temporary, 'plugin.mjs');
      await compileDshEntry({ entry, sourceRoot, outfile: modulePath, nodePaths });
    }
    const module = await import(`${pathToFileURL(modulePath).href}?bridge=${randomUUID()}`);
    const plugin = typeof module.apply === 'function' ? module : module.default;
    const apply = typeof plugin === 'function' ? plugin : plugin?.apply;
    if (typeof apply !== 'function') throw new DshBridgeError('Plugin must export apply(ctx, config) or a default function/object', { code: 'UNSUPPORTED_ENTRY' });
    const inject = plugin.inject ?? module.inject ?? [];
    if (!Array.isArray(inject) && (!inject || typeof inject !== 'object' || Object.keys(inject).some(k => !['required', 'optional'].includes(k)))) throw new TypeError('Unsupported inject declaration');
    const required = Array.isArray(inject) ? inject : inject?.required ?? [];
    if (!Array.isArray(required) || required.some(v => typeof v !== 'string')) throw new TypeError('Unsupported inject declaration');
    if (!Array.isArray(inject) && inject.optional !== undefined && (!Array.isArray(inject.optional) || inject.optional.some(v => typeof v !== 'string'))) throw new TypeError('Unsupported optional inject declaration');
    for (const service of required) if (!['tools', 'logger'].includes(service)) fail(`inject:${service}`);
    let effectiveConfig = json(config, 'configuration');
    const Config = plugin.Config ?? module.Config;
    if (Config !== undefined) {
      if (!Config?.[configMarker]) fail('non-supported Config schema');
      effectiveConfig = applyDefaults(Config, effectiveConfig);
      validator(Config.schema, 'configuration')(effectiveConfig);
    }
    await apply(ctx, effectiveConfig);
    // A plugin catching an unsupported API does not establish independence of its tools.
    if (unsupported.length) throw new DshBridgeError('Plugin attempted unsupported host behavior during initialization', { code: 'UNSUPPORTED_HOST_FEATURE', unsupported: [...unsupported] });
    phase = 'execution';
    const tools = [...definitions.values()].map(spec => ({
      name: spec.name, description: spec.description, inputSchema: spec.inputSchema,
      execute(args = {}, options = {}) {
        const run = async () => {
        if (disposed || definitions.get(spec.name) !== spec) throw new DshBridgeError('Tool has been disposed', { code: 'DISPOSED' });
        if (unsupported.length) throw new DshBridgeError('Plugin depends on unsupported host behavior; restart after correcting the plugin', { code: 'UNSUPPORTED_HOST_FEATURE', unsupported: [...unsupported] });
        const input = freeze(json(args, 'tool arguments'));
        spec.checkInput(input);
        const controller = new AbortController(); controllers.add(controller);
        const signals = [controller.signal];
        if (options.signal) signals.push(options.signal);
        if (spec.timeoutMs !== undefined) signals.push(AbortSignal.timeout(spec.timeoutMs));
        const signal = AbortSignal.any(signals);
        const callId = options.callId ?? randomUUID();
        const startUnsupported = unsupported.length;
        const exec = new Proxy(Object.freeze({ callId, rootCallId: callId, name: spec.name, arguments: input, token: Symbol(callId), signal }), {
          get(target, key) { if (Object.hasOwn(target, key)) return target[key]; return fail(`exec.${String(key)}`); },
        });
        try {
          signal.throwIfAborted();
          const value = await spec.execute(input, exec);
          signal.throwIfAborted();
          if (unsupported.length !== startUnsupported) throw new DshBridgeError('Tool attempted unsupported host behavior', { code: 'UNSUPPORTED_HOST_FEATURE', unsupported: unsupported.slice(startUnsupported) });
          if (!spec.output) return legacyResult(value);
          const canonical = freeze(json(value, 'tool output'));
          spec.output.check(canonical);
          const content = contentBlocks(await spec.output.render(input, canonical));
          if (unsupported.length !== startUnsupported) throw new DshBridgeError('Tool renderer attempted unsupported host behavior', { code: 'UNSUPPORTED_HOST_FEATURE', unsupported: unsupported.slice(startUnsupported) });
          return { content, ...(canonical && typeof canonical === 'object' && !Array.isArray(canonical) ? { structuredContent: canonical } : {}) };
        } finally { controllers.delete(controller); }
        };
        // DSH defaults to exclusive calls. Serial execution is also safe for opt-in tools.
        const pending = executionQueue.then(run);
        executionQueue = pending.catch(() => {});
        return pending;
      },
    }));
    return { tools, dispose, unsupported };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { log('error', 'Plugin cleanup failed', cleanupError.message); }
    if (error instanceof DshBridgeError) { error.unsupported = [...unsupported, ...error.unsupported.filter(v => !unsupported.includes(v))]; throw error; }
    throw new DshBridgeError(`Cannot initialize DSH plugin: ${error.message}`, { code: 'PLUGIN_INITIALIZATION_FAILED', cause: error, unsupported: [...unsupported] });
  }
}
