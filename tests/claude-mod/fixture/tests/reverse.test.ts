import { describe, expect, test } from 'claude-code/testing'
import { START, resultText, stage, tn, toastsOf } from './sim'

/** The reply the host got to its request, from the "ask" tool's answer. */
function replyOf(answer: unknown): { method: string; reply: { result?: any; error?: { code: string; message: string } } } {
  return JSON.parse(resultText(answer))
}

const HOST = (reverse: string) => ({ tools: [{ dshName: 'ask' }], reverse })

describe('approval.request', () => {
  test('an explicit yes approves', async ($, on) => {
    const world = stage(on, HOST('approval'), { answer: 'Approve' })
    await $.session.start(START)
    const { method, reply } = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(method).toBe('approval.request')
    expect(reply.result).toEqual({ approved: true })
    expect(world.asks.length).toBe(1)
    expect(world.asks[0]?.options).toEqual(['Approve', 'Deny'])
    expect(world.asks[0]?.question).toContain('Run the dangerous thing')
    expect(world.asks[0]?.question.endsWith('?')).toBe(true)
  })

  test('an explicit no does not approve', async ($, on) => {
    stage(on, HOST('approval'), { answer: 'Deny' })
    await $.session.start(START)
    const { reply } = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(reply.result.approved).toBe(false)
  })

  test('free text typed under "Other" is not an approval, even if it says yes', async ($, on) => {
    stage(on, HOST('approval'), { answer: 'yes, go ahead' })
    await $.session.start(START)
    const { reply } = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(reply.result.approved).toBe(false)
  })

  test('a dialog nobody answers is not an approval', async ($, on) => {
    // the dialog is dismissed: the engine's answer holds no answer for the question
    stage(on, HOST('approval'), { answer: null })
    await $.session.start(START)
    const { reply } = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(reply.result.approved).toBe(false)
    expect(reply.result.reason).toMatch(/no approval was given/)
  })
})

describe('model.complete', () => {
  test('is blocked while allowModelCalls is false: a DISABLED error in four parts, a toast, no model call', { options: { allowModelCalls: false } }, async ($, on) => {
    const world = stage(on, HOST('model'))
    await $.session.start(START)
    const { method, reply } = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(method).toBe('model.complete')
    expect(reply.error?.code).toBe('DISABLED')
    const message = reply.error?.message ?? ''
    expect(message).toContain('allowModelCalls')
    expect(message).toStartWith('[被擋下] Fixture plugin 想呼叫模型：「say hi」')
    for (const part of ['\n原因：', '\n怎麼放行：', '\n影響：', '（代碼：DISABLED）']) expect(message).toContain(part)
    expect(reply.result).toBeUndefined()
    expect(world.modelCalls.length).toBe(0)
    expect(toastsOf(world)).toEqual([message])
  })

  test('runs the completion by default (allowModelCalls is on) and says so in a toast', async ($, on) => {
    const world = stage(on, HOST('model'))
    await $.session.start(START)
    const { reply } = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(reply.result.text).toBe('model says hi')
    expect(world.modelCalls).toEqual([{ model: 'test-model', prompt: 'say hi', system: 'be brief' }])
    expect(toastsOf(world).length).toBe(1)
    expect(toastsOf(world)[0]).toContain('Fixture plugin 正在呼叫模型：say hi')
  })

  test('allowAgents does not open model calls', { options: { allowAgents: true, allowModelCalls: false } }, async ($, on) => {
    const world = stage(on, HOST('model'))
    await $.session.start(START)
    expect(replyOf(await $.tool.call({ tool: tn('ask') })).reply.error?.code).toBe('DISABLED')
    expect(world.modelCalls.length).toBe(0)
  })
})

describe('agent.spawn', () => {
  test('is blocked while allowAgents is false, with the task named', { options: { allowAgents: false } }, async ($, on) => {
    const world = stage(on, HOST('agent'))
    await $.session.start(START)
    const { reply } = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(reply.error?.code).toBe('DISABLED')
    expect(reply.error?.message).toContain('allowAgents')
    expect(reply.error?.message).toContain('想開一個子代理執行「fake task」')
    expect(world.agentCalls.length).toBe(0)
    expect(toastsOf(world)[0]).toContain('[被擋下]')
  })

  test('spawns a subagent by default, toasts what it is for, and returns its final answer', async ($, on) => {
    on('turn.complete', () => ({ text: '' }))
    const world = stage(on, HOST('agent'))
    await $.session.start(START)

    const call = $.tool.call({ tool: tn('ask') })
    await world.clock.settle()
    expect(world.agentCalls).toEqual([{ prompt: 'do a thing', description: 'fake task', subagentType: undefined }])
    expect(toastsOf(world)).toEqual(['Fixture plugin 開了一個子代理：fake task（可在插件選項關閉 allowAgents）'])

    // another agent finishing is not the answer
    await $.turn.complete({ reason: 'answer', answer: 'someone else', durationMs: 1, isAborted: false, turnId: 't-0', agentId: 'agent-9' })
    await $.turn.complete({ reason: 'answer', answer: 'the subagent answer', durationMs: 5, isAborted: false, turnId: 't-1', agentId: 'agent-1' })
    const { reply } = replyOf(await call)
    expect(reply.result).toEqual({ agentId: 'agent-1', text: 'the subagent answer' })
  })
})

describe('ui.notify and anything else', () => {
  test('ui.notify shows a toast', async ($, on) => {
    const world = stage(on, HOST('notify'))
    await $.session.start(START)
    const { reply } = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(reply.result).toEqual({ shown: true })
    expect(toastsOf(world)).toEqual(['hello from the host'])
  })

  test('ui.ask puts the question in the engine dialog and returns the chosen text', async ($, on) => {
    const world = stage(on, HOST('ask'), { answer: 'Red' })
    await $.session.start(START)
    const { method, reply } = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(method).toBe('ui.ask')
    expect(reply.result).toEqual({ answer: 'Red' })
    expect(world.asks[0]?.question).toContain('Which colour?')
    expect(world.asks[0]?.options).toEqual(['Red', 'Blue'])
  })

  test('ui.ask: a dismissed dialog is an explicit USER_DISMISSED error, not an empty answer', async ($, on) => {
    stage(on, HOST('ask'), { answer: null })
    await $.session.start(START)
    const { reply } = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(reply.error?.code).toBe('USER_DISMISSED')
    expect(reply.result).toBeUndefined()
  })

  test('an unknown request method gets an error reply, not a made-up success', async ($, on) => {
    stage(on, HOST('unknown'))
    await $.session.start(START)
    const { method, reply } = replyOf(await $.tool.call({ tool: tn('ask') }))
    expect(method).toBe('nothing.known')
    expect(reply.error?.code).toBe('UNSUPPORTED')
    expect(reply.result).toBeUndefined()
  })
})
