import { describe, expect, test } from 'claude-code/testing'
import type { World } from './sim'
import { START, resultText, stage, tn, toastsOf } from './sim'

/** What the person typed in the prompt box. */
const TYPED = { kind: 'composer' } as const

// A plugin that follows the chat (ctx.on('session/event')) and keeps the conversation agent (agent/created).
const FOLLOWS = { tools: [{ dshName: 'echo' }, { dshName: 'ask' }], reverse: 'followup', metadata: { listeners: { sessionEvent: 1, agentCreated: 1 } } }

/** What the newest child got through session.event, without the session id. */
function reported(world: World): Record<string, unknown>[] {
  return (world.cores.at(-1)?.calls ?? [])
    .filter(c => c.method === 'session.event')
    .map(c => {
      const { sessionId: _, ...rest } = c.params as Record<string, unknown>
      return rest
    })
}

/** The conversation events alone (the model is reported once at the start, whatever the plugin follows). */
const events = (world: World): Record<string, unknown>[] => reported(world).filter(e => e.kind !== 'model')

describe('the conversation, for a plugin that follows the chat', () => {
  test('messages, tool calls and the answer reach the host in order, and one toast says so', async ($, on) => {
    const world = stage(on, FOLLOWS)
    on('session.id', () => ({ value: 'session-1' }))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', { tool: 'Read' }, () => ({ result: 'file body' }))
    await $.session.start(START)
    await $.prompt.submit({ text: 'hello there', wait: false, origin: TYPED })
    await $.tool.call({ tool: 'Read', file_path: '/a.txt' })
    await $.tool.call({ tool: tn('echo'), x: 1 })
    await $.turn.complete({ reason: 'answer', answer: 'all done', durationMs: 1, isAborted: false, turnId: 't-1' })
    await world.clock.settle()

    expect(reported(world).filter(e => e.kind === 'model')).toEqual([{ kind: 'model', model: 'test-model' }])
    const seen = events(world)
    expect(seen.map(e => e.kind)).toEqual(['user', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'turn-end'])
    expect(seen[0]).toEqual({ kind: 'user', text: 'hello there' })
    expect(seen[1]).toMatchObject({ kind: 'tool-call', name: 'Read', input: { file_path: '/a.txt' } })
    expect(seen[2]).toMatchObject({ kind: 'tool-result', name: 'Read', text: 'file body', isError: false })
    expect(seen[3]).toMatchObject({ kind: 'tool-call', name: 'echo' }) // the plugin's own tool, under its DSH name
    expect(seen[5]).toEqual({ kind: 'turn-end', answer: 'all done', reason: 'answer', model: 'test-model' })
    const sessions = (world.cores.at(-1)?.calls ?? []).filter(c => c.method === 'session.event').map(c => (c.params as Record<string, unknown>).sessionId)
    expect(new Set(sessions)).toEqual(new Set(['session-1']))
    expect(toastsOf(world).filter(t => t.includes('shareConversation'))).toHaveLength(1)
  })

  test('a subagent turn and a slash command are not the conversation', async ($, on) => {
    const world = stage(on, FOLLOWS)
    on('turn.complete', () => ({ text: '' }))
    await $.session.start(START)
    await $.turn.complete({ reason: 'answer', answer: 'sub', durationMs: 1, isAborted: false, turnId: 't-2', agentId: 'agent-1' })
    await world.clock.settle()
    expect(events(world)).toEqual([])
  })

  test('with shareConversation off nothing is sent, and the status names the option', { options: { shareConversation: false } }, async ($, on) => {
    const world = stage(on, FOLLOWS)
    on('prompt.submit', (_, e) => ({ text: e.text }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start(START)
    await $.prompt.submit({ text: 'secret plans', wait: false, origin: TYPED })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-1' })
    await world.clock.settle()
    expect(events(world)).toEqual([])
    expect(toastsOf(world).some(t => t.includes('shareConversation'))).toBe(false)
  })

  test('a plugin that does not follow the chat gets nothing and no toast', async ($, on) => {
    const world = stage(on, { tools: [{ dshName: 'echo' }] })
    on('prompt.submit', (_, e) => ({ text: e.text }))
    await $.session.start(START)
    await $.prompt.submit({ text: 'hello', wait: false, origin: TYPED })
    await world.clock.settle()
    expect(events(world)).toEqual([])
    expect(toastsOf(world).some(t => t.includes('shareConversation'))).toBe(false)
  })
})

describe('agent.followup (prompt.submit)', () => {
  test('is blocked while allowFollowups is off (the default): DISABLED, one toast however often it tries', async ($, on) => {
    const world = stage(on, FOLLOWS)
    const sent: string[] = []
    on('prompt.submit', (_, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.session.start(START)
    const first = JSON.parse(resultText(await $.tool.call({ tool: tn('ask') })))
    await $.tool.call({ tool: tn('ask') })
    expect(first.method).toBe('prompt.submit')
    expect(first.reply.error?.code).toBe('DISABLED')
    expect(first.reply.error?.message).toContain('allowFollowups')
    expect(sent).toEqual([])
    expect(toastsOf(world).filter(t => t.includes('allowFollowups'))).toHaveLength(1)
  })

  test('turned on: the message is sent, and it reaches the plugin with the source the plugin gave it', { options: { allowFollowups: true } }, async ($, on) => {
    const world = stage(on, FOLLOWS)
    const sent: string[] = []
    on('prompt.submit', (_, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.session.start(START)
    const answer = JSON.parse(resultText(await $.tool.call({ tool: tn('ask') })))
    await world.clock.settle()
    expect(answer.reply.result).toEqual({ queued: true })
    expect(sent).toEqual(['a thought of my own'])
    expect(events(world).filter(e => e.kind === 'user')).toEqual([{ kind: 'user', text: 'a thought of my own', source: { kind: 'mate' } }])
  })
})
