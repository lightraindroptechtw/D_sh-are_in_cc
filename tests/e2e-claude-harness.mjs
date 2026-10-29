// Drives a GENERATED Claude plugin (its hooks/register.ts) without Claude Code and without a model.
//
// What is real: the generated register.ts (esbuild strips the types, nothing else changes), the generated
// runtime/claude-host.mjs as a real child process, its stdout JSON lines, the loopback HTTP + Bearer token.
// What is my approximation of the engine (hypothesis: close enough for these paths, not the engine itself):
// the `$` object, the hook chain (`next`, `.catch`), the stream returned by `$.process.spawn` and its `return()`.
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = undefined;
}
export const hasEsbuild = esbuild !== undefined;

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** Child process ids of `pid` (the official host's worker is a child of the claude host). */
export function childPids(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(pid)}').ProcessId`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      return String(r.stdout ?? '').split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
    }
    const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 10000 });
    return String(r.stdout ?? '').split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}
export const processAlive = isAlive;

export async function waitFor(check, { timeoutMs = 10000, everyMs = 50, label = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, everyMs));
  }
}

export const COMPOSE = { model: 'test-model', promptModel: 'test-model', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] };

/**
 * @param pluginDir a generated plugin folder (hooks/register.ts, runtime/claude-host.mjs, ...)
 * @param opts.options  the plugin's userConfig values (allowModelCalls, allowAgents)
 * @param opts.cwd      the session directory (session.start's cwd)
 * @param opts.env      extra variables over the test process's environment, for the child
 */
export async function loadGeneratedMod(pluginDir, { options = {}, cwd = process.cwd(), env = {}, ask = 'Approve', modelText = 'model says hi', agentAnswer = 'subagent says hi' } = {}) {
  if (esbuild === undefined) throw new Error('esbuild is not installed');
  const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  const hooksJson = JSON.parse(await fs.readFile(path.join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
  // Bundled, so the module's own imports (hooks/rewrite-shared.ts, a rewritten part) come along; claude-code is types only.
  const built = await esbuild.build({ entryPoints: [path.resolve(pluginDir, 'hooks', hooksJson.modules[0])], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', external: ['claude-code'] });
  const code = built.outputFiles[0].text;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-mod-'));
  const file = path.join(dir, 'register.mjs');
  await fs.writeFile(file, code);
  const { register } = await import(pathToFileURL(file).href);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  const hooks = [];
  register((event, ...rest) => {
    const hook = rest.at(-1);
    const matcher = rest.length === 2 ? rest[0] : undefined;
    const entry = { event, matcher, hook, catcher: undefined };
    hooks.push(entry);
    return { catch: fn => { entry.catcher = fn; } };
  }, options);

  const world = {
    manifest,
    registered: [], // every $.tool.register call, in order
    fullNames: new Map(), // short name -> mcp__<plugin>__<short>
    commands: [],
    logs: [], debugLogs: [], statuses: [], toasts: [],
    asks: [], modelCalls: [], agentCalls: [],
    spawns: [], children: [], streams: [],
    ask, modelText, agentAnswer,
  };
  const killers = [];

  const spawnStream = request => {
    const child = spawnChild(request.argv[0], request.argv.slice(1), {
      cwd: request.cwd,
      env: { ...process.env, ...env, ...request.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    world.spawns.push({ argv: request.argv, cwd: request.cwd, env: request.env });
    world.children.push(child);
    const queue = [];
    let wake;
    let result;
    const push = which => chunk => { queue.push({ stream: which, text: chunk.toString('utf8') }); wake?.(); };
    child.stdout.on('data', push('stdout'));
    child.stderr.on('data', push('stderr'));
    child.on('error', error => { result = { error }; wake?.(); });
    child.on('exit', (code, signal) => { result = { code, signal }; wake?.(); });
    killers.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const stream = {
      async next() {
        for (;;) {
          if (queue.length) return { done: false, value: queue.shift() };
          if (result) {
            if (result.error) throw result.error;
            return { done: true, value: result };
          }
          await new Promise(r => { wake = r; });
        }
      },
      // The engine kills the child when the loop is left (documented for `$.process.spawn`).
      async return(value) {
        stream.returned = true;
        if (child.exitCode === null && child.signalCode === null) child.kill();
        wake?.();
        return { done: true, value };
      },
      returned: false,
      [Symbol.asyncIterator]() { return this; },
    };
    world.streams.push(stream);
    return stream;
  };

  const run = (event, e, { terminal } = {}) => {
    const end = terminal ?? (async x => x);
    const list = hooks.filter(h => h.event === event && (h.matcher === undefined || Object.entries(h.matcher).every(([k, v]) => e[k] === v)));
    const signal = new AbortController().signal;
    const step = async (i, input) => {
      if (i >= list.length) return end(input);
      const h = list[i];
      const next = async x => { next.called = true; return step(i + 1, x ?? input); };
      next.called = false;
      next.signal = signal;
      next.error = undefined;
      try {
        return await h.hook($, input, next);
      } catch (error) {
        if (h.catcher) {
          next.error = { message: error?.message ?? String(error), kind: 'throw' };
          return h.catcher($, input, next);
        }
        throw error;
      }
    };
    return step(0, e);
  };

  const $ = {
    plugin: { name: manifest.name, root: pluginDir },
    clock: {
      now: () => Date.now(),
      after: (ms, fn) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return { cancel: () => clearTimeout(t) };
      },
    },
    http: {
      fetch: async (url, init) => {
        const r = await fetch(url, init);
        return { status: r.status, ok: r.ok, headers: {}, text: await r.text() };
      },
    },
    process: { spawn: spawnStream },
    tool: {
      register: async spec => {
        world.registered.push(spec);
        const full = `mcp__${manifest.name}__${spec.name}`;
        world.fullNames.set(spec.name, full);
        return { tool: full };
      },
    },
    command: { register: async spec => (world.commands.push(spec), { command: spec.name }) },
    ui: {
      log: (text, o) => { (o?.to === 'debug' ? world.debugLogs : world.logs).push(text); },
      status: text => { world.statuses.push(text); },
      toast: text => { world.toasts.push(text); },
      ask: async (question, o) => {
        world.asks.push({ question, options: o?.options ?? [] });
        if (world.ask instanceof Error) throw world.ask;
        return world.ask;
      },
    },
    session: { model: async () => 'test-model', cwd: async () => cwd },
    model: {
      complete: async request => {
        world.modelCalls.push(request);
        return { isAnswered: true, text: world.modelText, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
    agent: {
      spawn: async request => {
        world.agentCalls.push(request);
        const agentId = `agent-${world.agentCalls.length}`;
        // The subagent's final answer reaches the mod as its `turn.complete` (what register.ts listens to).
        setTimeout(() => void run('turn.complete', { agentId, reason: 'answer', answer: world.agentAnswer }), 30).unref?.();
        return { agentId };
      },
    },
  };

  return {
    $, run, world, hooks,
    start: (e = {}) => run('session.start', { cwd, surface: 'terminal', isInteractive: true, ...e }),
    end: (e = {}) => run('session.end', { reason: 'other', sessionId: 's1', ...e }),
    toolCall: (shortName, args = {}, id = 'toolu_1') => run('tool.call', { tool: world.fullNames.get(shortName) ?? `mcp__${manifest.name}__${shortName}`, tool_use_id: id, ...args }),
    command: (command, args = '') => run('command.run', { command, args, origin: { kind: 'composer' } }),
    compose: () => run('prompt.compose', COMPOSE, { terminal: async () => ({ sections: [{ id: 'engine', text: 'Engine prompt.' }] }) }),
    statusName: `${manifest.name}-status`,
    /** Kills every child still running (the test's safety net). Resolves when they are gone. */
    async stop() {
      killers.forEach(k => k());
      await Promise.all(world.children.map(c => (c.exitCode !== null || c.signalCode !== null ? null : new Promise(r => c.once('exit', r)))));
    },
  };
}

/** Runs `node bin/d-sh-are-in-cc.mjs <args>` and returns {code, stdout, stderr, report}. */
export function runConverter(projectRoot, args, { timeoutMs = 240000 } = {}) {
  return new Promise(resolve => {
    const child = spawnChild(process.execPath, [path.join(projectRoot, 'bin', 'd-sh-are-in-cc.mjs'), ...args], { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => {
      clearTimeout(timer);
      let report;
      try { report = JSON.parse(stdout); } catch { report = undefined; }
      resolve({ code, stdout, stderr, report });
    });
  });
}
