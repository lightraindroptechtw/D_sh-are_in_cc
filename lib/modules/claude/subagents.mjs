import {randomUUID} from 'node:crypto';
import {claudeError, disabledError, guardService, isDisabled} from './common.mjs';

export const descriptor = {
  id: 'subagents', displayName: '子代理服務模組（Claude Code）', services: ['subagents'],
  requires: {capabilities: []},
  methods: {
    list: {support: 'partial', reason: '只有一個供應商名稱 spawn（對應 Claude Code 的 agent.spawn）'},
    getProvider: {support: 'partial', reason: '回傳 spawn 的描述；所有選用能力（agentOptions、agentPreset、outputSchema、depthLimit）都是 false，沒有 prepareContinuable'},
    startActivation: {support: 'partial', reason: '一次性子代理：經 agent.spawn 請 Claude Code 啟動；預設關閉，需開啟 allowAgents。agentOptions（provider、model、推理強度）被忽略；agentPreset、outputSchema 會明確失敗'},
    interrupt: {support: 'partial', reason: '中斷等待；已啟動的子代理是否停止由 Claude Code 決定'},
    waitForChildren: {support: 'full', reason: '等待本模組啟動且尚未結束的子代理'},
    listChildren: {support: 'partial', reason: '只列出本程序啟動過的子代理，不讀 DSH 對話紀錄'},
    startContinuable: {support: 'unsupported', reason: '持續對話（continuable）子代理需要 DSH 對話與收件匣，Claude Code 子代理沒有'},
    sendMessage: {support: 'unsupported', reason: '無法對已啟動的 Claude Code 子代理送訊息'},
    registerProvider: {support: 'unsupported', reason: '不可替換子代理供應商'},
  },
  requirements: ['userConfig.allowAgents=true，否則 result 以 DSH_AGENTS_DISABLED 拒絕'],
};

const PROVIDER = 'spawn';
const replyText = reply => typeof reply === 'string' ? reply : typeof reply?.text === 'string' ? reply.text : typeof reply?.result === 'string' ? reply.result : null;
const blocksToText = (blocks, method) => {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks) || !blocks.length) throw claudeError('subagents', method, 'prompt 必須是文字區塊陣列');
  return blocks.map(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string') throw claudeError('subagents', method, `不支援 ${block?.type ?? '未知'} 區塊；子代理只能收到文字`);
    return block.text;
  }).join('\n');
};

export function createClaudeSubagentsService({requestHost, emit = () => {}} = {}) {
  const children = new Map(); // childId -> {label, controller, settled, parent}
  let closed = false;
  const publish = (event, ...args) => { try { const r = emit(event, ...args); r?.catch?.(() => {}); } catch { /* observers must not break the run */ } };

  const provider = Object.freeze({
    name: PROVIDER, inheritsParentContext: false,
    capabilities: Object.freeze({agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false}),
    start: undefined, prepareContinuable: undefined,
  });
  const expectProvider = (name, method) => {
    if (name !== PROVIDER) throw claudeError('subagents', method, `沒有子代理供應商 "${String(name)}"（可用：${PROVIDER}）`, 'DSH_SUBAGENT_PROVIDER_UNKNOWN');
  };
  const parentIdOf = parent => parent?.session?.id ?? parent?.id ?? null;

  async function startActivation(spec = {}) {
    if (closed) throw claudeError('subagents', 'startActivation', '模組已關閉', 'DSH_MODULE_DISPOSED');
    if (typeof requestHost !== 'function') throw claudeError('subagents', 'startActivation', '沒有 Claude Code 的反向請求通道');
    expectProvider(spec.provider, 'startActivation');
    const request = spec.request ?? {};
    if (request.agentPreset !== undefined) throw claudeError('subagents', 'startActivation', 'agentPreset 沒有對應');
    if (request.outputSchema !== undefined) throw claudeError('subagents', 'startActivation', 'outputSchema 沒有對應：Claude Code 子代理無法保證結構化輸出');
    if (spec.signal?.aborted) throw claudeError('subagents', 'startActivation', '啟動已取消', 'ABORT_ERR');
    const prompt = blocksToText(request.prompt, 'startActivation');
    const subagentType = request.agentOptions?.subagentType ?? request.subagentType;
    const childId = request.childId ?? spec.childId ?? `claude-subagent-${randomUUID()}`;
    const controller = new AbortController();
    const slot = {label: String(spec.label ?? ''), controller, settled: false, parent: parentIdOf(request.parent), done: null};
    children.set(childId, slot);
    spec.signal?.addEventListener('abort', () => controller.abort(), {once: true});
    publish('subagent/start', {runId: childId, provider: PROVIDER, id: childId, local: false});
    const result = (async () => {
      try {
        const reply = await requestHost('agent.spawn', {prompt, description: slot.label || undefined, ...(subagentType ? {subagentType: String(subagentType)} : {})}, {signal: controller.signal});
        const text = replyText(reply);
        if (text === null) throw claudeError('subagents', 'startActivation', 'agent.spawn 的回覆沒有文字', 'DSH_AGENT_REPLY_INVALID');
        const value = {output: [{type: 'text', text}], stopReason: 'completed'};
        publish('subagent/end', {runId: childId, provider: PROVIDER, id: childId, local: false, stopReason: 'completed', lastAssistantMessage: value.output});
        return value;
      } catch (error) {
        publish('subagent/end', {runId: childId, provider: PROVIDER, id: childId, local: false, stopReason: controller.signal.aborted ? 'aborted' : 'error'});
        if (isDisabled(error)) throw disabledError('subagents', 'startActivation', error, 'allowAgents', 'DSH_AGENTS_DISABLED');
        throw error;
      } finally { slot.settled = true; }
    })();
    slot.done = result.then(() => {}, () => {});
    result.catch(() => {}); // the holder reads `result`; an unread rejection must not end the host
    return {
      childId, result,
      async dispose() { controller.abort(); await slot.done; children.delete(childId); },
    };
  }

  function interrupt(targetId) { children.get(targetId)?.controller.abort(); }
  async function waitForChildren() {
    const pending = [...children.values()].filter(c => !c.settled).map(c => c.done);
    if (!pending.length) return false;
    await Promise.all(pending);
    return true;
  }
  async function listChildren(parentSessionId) {
    return [...children.entries()].filter(([, c]) => parentSessionId === undefined || c.parent === parentSessionId).map(([id, c]) => ({id, label: c.label, mode: 'one-shot', provider: PROVIDER, state: c.settled ? 'settled' : 'running'}));
  }
  async function drainDescendants() { await Promise.all([...children.values()].map(c => { c.controller.abort(); return c.done; })); }

  const service = guardService({
    list: () => [PROVIDER], getProvider: name => name === PROVIDER ? provider : undefined,
    startActivation, interrupt, interruptByParent: id => { interrupt(id); return {accepted: true}; },
    waitForChildren, listChildren, drainDescendants,
    drainChildren: async (_parent, ids = []) => { await Promise.all(ids.map(async id => { const c = children.get(id); c?.controller.abort(); await c?.done; })); },
  }, 'subagents', '這個 subagents 方法沒有對應到 Claude Code 子代理（沒有持續對話與收件匣）');
  return {service, async dispose() { closed = true; await drainDescendants(); children.clear(); }};
}

export async function install({requestHost, emit} = {}) {
  const runtime = createClaudeSubagentsService({requestHost, emit});
  return {services: {subagents: runtime.service}, dispose: () => runtime.dispose(), diagnostics: [{module: 'subagents', level: 'warning', status: 'partial', reason: '一次性子代理經 agent.spawn 交給 Claude Code；預設關閉。沒有 startContinuable、sendMessage，需要持續對話子代理的插件功能會明確失敗。'}]};
}
