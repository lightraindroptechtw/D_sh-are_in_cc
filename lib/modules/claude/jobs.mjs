import {randomUUID} from 'node:crypto';
import {claudeError, guardService} from './common.mjs';

export const descriptor = {
  id: 'jobs', displayName: '背景工作登記模組（Claude Code）', services: ['jobs'],
  requires: {capabilities: []},
  methods: {
    start: {support: 'partial', reason: '行程內登記（沿用 dsh-jobs 的介面：id、輸出環、取消、等待、事件）；不要求 attachController，因為 Claude Code 沒有模型端的工作工具'},
    list: {support: 'full', reason: '依擁有者過濾，登記順序'}, get: {support: 'full', reason: '投影，不動游標'},
    read: {support: 'full', reason: '消費式游標讀取；結算後第一次讀取帶 result'}, readAt: {support: 'full', reason: '絕對位移讀取，不動游標'},
    kill: {support: 'full', reason: '呼叫生產者 cancel，狀態轉 stopping'}, wait: {support: 'full', reason: '等到結算或逾時，不取消工作'},
    remove: {support: 'full', reason: '移除已結算的紀錄'}, events: {support: 'partial', reason: 'subscribe(filter, listener)；owners:"scope" 在此視為 "all"'},
    persistence: {support: 'unsupported', reason: '紀錄只在子程序存活期間存在，沒有寫進 DSH 對話紀錄的 job/registered、job/settled 事件'},
  },
  requirements: [],
};

const RING_LIVE = 4 << 20, RING_SETTLED = 256 << 10, PUMP_MS = 250;
const ownerId = owner => owner === undefined || owner === null ? undefined : typeof owner === 'string' ? owner : (owner.session?.id ?? owner.id ?? undefined);

export function createClaudeJobsService({now = Date.now} = {}) {
  const jobs = new Map(); // id -> record
  const listeners = new Set();
  const controllers = new Set();
  let closed = false;

  const emit = event => { for (const {filter, listener} of [...listeners]) { try { if (!filter.owner || filter.owner === event.job.owner) listener(event); } catch { /* contained */ } } };
  const bytes = text => Buffer.byteLength(text);
  function view(r) {
    return Object.freeze({
      id: r.id, kind: r.kind, label: r.label, ...(r.owner ? {owner: r.owner} : {}), ...(r.outputLimitBytes ? {outputLimitBytes: r.outputLimitBytes} : {}),
      status: r.status, ...(r.progress ? {progress: r.progress} : {}), ...(r.detail ? {detail: r.detail} : {}), startedAt: r.startedAt, ...(r.finishedAt ? {finishedAt: r.finishedAt} : {}),
      output: Object.freeze({total: r.total, earliest: r.earliest}),
    });
  }
  function access(id, caller) {
    const r = jobs.get(id);
    if (!r || (r.owner && caller !== r.owner)) throw claudeError('jobs', 'get', `沒有這個工作：${String(id)}`, 'DSH_JOB_NOT_FOUND');
    return r;
  }
  function append(r, text, options = {}) {
    if (!text || r.settled) return;
    r.chunks.push({at: r.total, text, ...(options.channel ? {channel: options.channel} : {}), ...(options.gapBefore ? {gapBefore: true} : {})});
    r.total += bytes(text); r.retained += bytes(text);
    trim(r, r.settled ? RING_SETTLED : RING_LIVE);
  }
  function trim(r, cap) {
    while (r.retained > cap && r.chunks.length > 1) { const c = r.chunks.shift(); r.retained -= bytes(c.text); r.earliest = r.chunks[0].at; }
  }
  function pump(r) {
    for (const s of r.sources) {
      let read; try { read = s.source.read(s.offset); } catch { continue; }
      if (read.lossy) append(r, read.text, {channel: s.source.channel, gapBefore: true}); else append(r, read.text, {channel: s.source.channel});
      s.offset = read.nextOffset; s.spill = read.spillPath;
    }
  }
  function settle(r, outcome, cause) {
    if (r.settled) return;
    pump(r);
    r.settled = true; clearInterval(r.timer);
    r.status = outcome.status; r.detail = [outcome.detail, r.killReason].filter(Boolean).join(': ') || undefined;
    r.result = outcome.result; r.progress = undefined; r.finishedAt = now();
    trim(r, RING_SETTLED);
    const awaited = r.waiters.size > 0;
    for (const release of [...r.waiters]) release();
    r.waiters.clear();
    emit({type: 'settled', job: view(r), cause, awaited});
  }

  function start(spec = {}) {
    if (closed) throw claudeError('jobs', 'start', '模組已關閉', 'DSH_MODULE_DISPOSED');
    if (typeof spec.kind !== 'string' || !spec.kind || typeof spec.label !== 'string' || typeof spec.run !== 'function') throw claudeError('jobs', 'start', 'kind、label、run 都是必要欄位', 'DSH_JOB_BAD_SPEC');
    const id = `${spec.kind}-${randomUUID().slice(0, 8)}`;
    const r = {id, kind: spec.kind, label: spec.label, owner: ownerId(spec.owner), outputLimitBytes: spec.outputLimitBytes, status: 'running', startedAt: now(),
      chunks: [], total: 0, earliest: 0, retained: 0, cursor: 0, sources: (spec.output ?? []).map(source => ({source, offset: 0})), waiters: new Set(), settled: false, hooks: null};
    const handle = Object.freeze({id, append: (text, options) => append(r, String(text), options), updateProgress: line => { if (!r.settled) { r.progress = String(line); if (r.registered) emit({type: 'progress', job: view(r)}); } }});
    r.hooks = spec.run(handle); // a throw leaves nothing registered
    if (typeof r.hooks?.cancel !== 'function' || !r.hooks?.done?.then) throw claudeError('jobs', 'start', 'run() 必須回傳 { cancel, done }', 'DSH_JOB_BAD_SPEC');
    jobs.set(id, r);
    r.timer = setInterval(() => pump(r), PUMP_MS); r.timer.unref?.();
    r.registered = true;
    emit({type: 'registered', job: view(r)});
    Promise.resolve(r.hooks.done).then(outcome => settle(r, outcome && typeof outcome === 'object' ? outcome : {status: 'failed', detail: 'producer returned no outcome'}, r.killReason !== undefined || r.status === 'stopping' ? 'kill' : 'producer'),
      error => settle(r, {status: 'failed', detail: `producer failed: ${error?.message ?? error}`.slice(0, 300)}, 'producer'));
    return id;
  }

  const chunksFrom = (r, from) => r.chunks.filter(c => c.at + bytes(c.text) > from);
  function read(id, caller) {
    const r = access(id, caller);
    pump(r);
    const lossy = r.cursor < r.earliest;
    const chunks = chunksFrom(r, r.cursor); r.cursor = r.total;
    const result = r.settled && !r.resultDelivered ? r.result : undefined;
    if (r.settled) r.resultDelivered = true;
    return {chunks, lossy, ...(result === undefined ? {} : {result}), job: view(r)};
  }
  function readAt(id, from, caller) {
    if (!Number.isInteger(from) || from < 0) throw claudeError('jobs', 'readAt', 'from 必須是非負整數', 'DSH_JOB_BAD_OFFSET');
    const r = access(id, caller); pump(r);
    return {chunks: chunksFrom(r, from), next: r.total, lossy: from < r.earliest};
  }
  function kill(id, caller, reason) {
    const r = access(id, caller);
    if (r.settled) return 'already-finished';
    if (reason) r.killReason = reason;
    r.hooks.cancel(reason);
    if (!r.settled) { r.status = 'stopping'; emit({type: 'stopping', job: view(r)}); }
    return 'requested';
  }
  async function wait(id, timeoutMs, caller, signal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw claudeError('jobs', 'wait', 'timeoutMs 必須是正的有限毫秒數', 'DSH_JOB_BAD_TIMEOUT');
    const r = access(id, caller);
    if (r.settled) return view(r);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(done, timeoutMs);
      function done() { clearTimeout(timer); r.waiters.delete(release); signal?.removeEventListener('abort', onAbort); resolve(); }
      const release = () => done();
      const onAbort = () => { clearTimeout(timer); r.waiters.delete(release); if (r.settled) resolve(); else reject(claudeError('jobs', 'wait', '等待已取消', 'ABORT_ERR')); };
      r.waiters.add(release);
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, {once: true});
    });
    return view(r);
  }
  function remove(id, caller) {
    const r = access(id, caller);
    if (!r.settled) throw claudeError('jobs', 'remove', '工作還在執行，不能移除', 'DSH_JOB_RUNNING');
    jobs.delete(id); emit({type: 'removed', job: view(r)});
  }

  const service = guardService({
    start, read, readAt, kill, wait, remove,
    list: caller => [...jobs.values()].filter(r => !r.owner || r.owner === caller).map(view),
    get: (id, caller) => view(access(id, caller)),
    attachController: name => { const token = {name}; controllers.add(token); return () => controllers.delete(token); },
    events: Object.freeze({subscribe(filter, listener) { const slot = {filter: filter ?? {owners: 'all'}, listener}; listeners.add(slot); return () => listeners.delete(slot); }}),
  }, 'jobs', '這個 jobs 方法沒有對應到 Claude Code 宿主');
  return {
    service,
    async dispose() {
      closed = true;
      const live = [...jobs.values()].filter(r => !r.settled);
      for (const r of live) { try { r.hooks.cancel('teardown'); } catch { settle(r, {status: 'failed', detail: 'cancel threw during teardown'}, 'teardown'); } }
      let limit;
      await Promise.race([Promise.allSettled(live.map(r => r.hooks.done)), new Promise(resolve => { limit = setTimeout(resolve, 3000); })]);
      clearTimeout(limit);
      for (const r of live) settle(r, {status: 'killed', detail: 'host teardown'}, 'teardown');
      listeners.clear();
    },
  };
}

export async function install() {
  const runtime = createClaudeJobsService();
  return {services: {jobs: runtime.service}, dispose: () => runtime.dispose(), diagnostics: [{module: 'jobs', level: 'info', status: 'partial', reason: '行程內的背景工作登記；紀錄不持久，也沒有模型端的工作工具。'}]};
}
