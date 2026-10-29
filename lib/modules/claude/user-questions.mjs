import {claudeError, guardService} from './common.mjs';

export const descriptor = {
  id: 'userQuestions', displayName: '使用者提問模組（Claude Code）', services: ['userQuestions'],
  requires: {capabilities: []},
  methods: {
    ask: {support: 'partial', reason: '每個問題送一個 ui.ask 反向請求，mod 用 $.ui.ask 問使用者並阻塞到回答；Claude 對話框每題 2 到 4 個選項，超過 4 個選項時把完整清單寫進問題文字改用自由輸入，再用文字比對還原選項；沒有 plan-review 的專屬畫面'},
    askTimed: {support: 'unsupported', reason: '沒有限時等待與延後回覆'},
    answer: {support: 'unsupported', reason: '沒有延後回覆（continued question）'},
    attachWait: {support: 'unsupported', reason: '沒有限時等待'},
  },
  requirements: ['使用者取消或在非互動模式（-p）時，ask 以 DSH_USER_QUESTION_CANCELLED 拒絕'],
};

const MAX_OPTIONS = 4;
const labelOf = option => typeof option === 'string' ? option : option?.label;

/** Turn one DSH question into the arguments of $.ui.ask. */
export function toAskParams(question) {
  const labels = (question.options ?? []).map(labelOf).filter(x => typeof x === 'string' && x);
  const parts = [String(question.question ?? '').trim()];
  if (question.detail) parts.push(String(question.detail).trim());
  let options = labels;
  if (labels.length > MAX_OPTIONS) {
    parts.push(`Options: ${labels.join(' / ')}${question.multiSelect ? ' (separate several with commas)' : ''}`);
    options = [];
  } else if (question.options?.some(o => o?.description)) {
    parts.push(question.options.filter(o => o?.description).map(o => `${labelOf(o)}: ${o.description}`).join('\n'));
  }
  return {
    question: parts.filter(Boolean).join('\n'),
    ...(question.header ? {header: String(question.header).slice(0, 12)} : {}),
    ...(options.length ? {options} : {}),
    ...(question.multiSelect ? {multiSelect: true} : {}),
    labels,
  };
}

/** Map the text $.ui.ask returned back onto the offered labels; anything else is the free-text answer. */
export function fromAnswer(question, text, labels) {
  const raw = String(text ?? '');
  const pieces = question.multiSelect ? raw.split(',').map(s => s.trim()).filter(Boolean) : [raw.trim()];
  const selected = pieces.filter(p => labels.includes(p));
  const rest = pieces.filter(p => !labels.includes(p));
  if (selected.length && !rest.length) return {id: question.id, selected};
  if (!selected.length && !rest.length) return {id: question.id, selected: []};
  return {id: question.id, selected, custom: question.multiSelect ? rest.join(', ') : raw.trim()};
}

export function createClaudeUserQuestionsService({requestHost} = {}) {
  async function ask(request = {}) {
    const questions = request.questions;
    if (!Array.isArray(questions) || !questions.length) throw claudeError('userQuestions', 'ask', 'questions 必須是非空陣列', 'DSH_USER_QUESTION_BAD_REQUEST');
    for (const q of questions) if (typeof q?.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question.trim()) throw claudeError('userQuestions', 'ask', '每個問題都要有 id 與 question', 'DSH_USER_QUESTION_BAD_REQUEST');
    if (typeof requestHost !== 'function') throw claudeError('userQuestions', 'ask', '沒有 Claude Code 的反向請求通道，無法問使用者', 'DSH_USER_QUESTION_UNAVAILABLE');
    const answers = [];
    for (const question of questions) {
      if (request.signal?.aborted) throw claudeError('userQuestions', 'ask', '提問已取消', 'ASK_ABORTED');
      const {labels, ...params} = toAskParams(question);
      let reply;
      try { reply = await requestHost('ui.ask', params, {signal: request.signal}); }
      catch (error) {
        if (request.signal?.aborted) throw claudeError('userQuestions', 'ask', '提問已取消', 'ASK_ABORTED');
        const why = error?.code === 'USER_DISMISSED' ? '使用者關閉了問題' : error?.message ? String(error.message).slice(0, 200) : '沒有取得回答';
        throw claudeError('userQuestions', 'ask', `${why}；問題沒有被回答`, 'DSH_USER_QUESTION_CANCELLED');
      }
      const text = typeof reply === 'string' ? reply : reply?.answer;
      if (typeof text !== 'string') throw claudeError('userQuestions', 'ask', 'mod 的 ui.ask 回覆沒有文字', 'DSH_USER_QUESTION_REPLY_INVALID');
      answers.push(fromAnswer(question, text, labels));
    }
    return {answers};
  }
  return guardService({ask}, 'userQuestions', '這個 userQuestions 方法沒有對應到 Claude Code（只有同步的 ask）');
}

export async function install({requestHost} = {}) {
  return {services: {userQuestions: createClaudeUserQuestionsService({requestHost})}, dispose: async () => {}, diagnostics: [{module: 'userQuestions', level: 'info', status: 'partial', reason: '提問經 ui.ask 交給 Claude Code 的提問對話框；非互動模式會失敗。'}]};
}
