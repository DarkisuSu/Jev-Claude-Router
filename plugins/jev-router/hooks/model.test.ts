// Dry-run and switching tests for model routing. Jev's answers are given by
// the test; turn.step's bottom is the test's own, so no model is ever called.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { FAKE_KEY, PROMPT, logLines, rankWide, rerank, world, type World } from './testkit'
import { availableFrom, decide, learn, planStep } from './model'

// Full ids as the engine resolves them; the router never sends a bare alias.
const SONNET = 'claude-sonnet-test-id'
const OPUS = 'claude-opus-test-id'
const HAIKU = 'claude-haiku-test-id'
const BAD = 'jev-router-probe-no-such-model'

type Seen = { model: string; effort?: unknown; agentId?: string }

// The engine beneath: records what each request was sent with and answers as
// the model named, or fails for one listed in `failing`.
const bottom = (on: On, failing: string[] = []) => {
  const seen: Seen[] = []
  on('turn.step', async function* ($, e) {
    seen.push({ model: e.model, effort: e.effort, agentId: e.agentId })
    const failed = failing.includes(e.model)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: failed ? '' : 'OK',
      toolUses: [],
      stopReason: failed ? null : 'end_turn',
      usage: failed
        ? null
        : { model: e.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as never
  })
  return seen
}

const step = async ($: Engine, turnId: string, index: number, extra: Record<string, unknown> = {}) => {
  const s = $.turn.step({ turnId, index, model: SONNET, effort: 'medium', messageCount: 1, ...extra } as never)
  let r = await s.next()
  while (!r.done) r = await s.next()
  return r.value
}

const answers = (choice: string, confidence: number, effort = { score: 2, confidence: 0.9 }) =>
  (q: Record<string, unknown>) =>
    'acts_on_user_system' in q
      ? { status: 200, body: rankWide(0.9, 'speckit-specify', { choice, confidence }, effort) }
      : { status: 200, body: rerank(q, { 'speckit-specify': 0.2 }) }

const CAPS = {
  version: '9.9.9',
  families: {
    opus: { id: OPUS, ok: true, effort: true, at: '' },
    haiku: { id: HAIKU, ok: true, effort: true, at: '' },
  },
  retryOk: true,
}
const LEARNED = { caps: CAPS }

const turn = async ($: Engine, w: World, text = PROMPT) => {
  await $.prompt.submit({ text, asUser: true })
  await $.turn.start({ text, turnId: 't1' })
  return w
}

const steps = (w: World) => logLines(w).filter(l => l.type === 'step')

describe('model routing', () => {
  test('dry-run: logs what Jev would send and sends the session model unchanged', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('opus', 0.9))
    const seen = bottom(on)

    await turn($, w)
    const result = await step($, 't1', 0)

    expect(seen).toEqual([{ model: SONNET, effort: 'medium', agentId: undefined }])
    expect(result.usage?.model).toBe(SONNET)
    const [s] = steps(w)
    expect(s?.would_model).toBe(OPUS)
    expect(s?.would_effort).toBe('high')
    expect(s?.reasons?.[0]).toBe('dry-run')
    expect(logLines(w).find(l => l.type === 'round')?.decision).toEqual({ family: 'opus', effort: 'high' })
  })

  test('on: every main step of the turn is sent with the learned full id and effort', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('opus', 0.9))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)
    const second = await step($, 't1', 1)

    expect(seen.map(s => `${s.model}/${String(s.effort)}`)).toEqual([`${OPUS}/high`, `${OPUS}/high`])
    expect(second.usage?.model).toBe(OPUS)
    expect(steps(w).map(s => s.answered_by)).toEqual([OPUS, OPUS])
    expect(w.fetches.length).toBe(2)
  })

  test('on: Jev may pick haiku for a hard-looking prompt; the router follows Jev, not length', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('haiku', 0.8, { score: 0.1, confidence: 0.9 }))
    const seen = bottom(on)

    await turn($, w, 'Refactor the entire payment ledger across all services and redesign its architecture.')
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: HAIKU, effort: 'low', agentId: undefined })
  })

  test('on: below the threshold the session model stays (fallback session)', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('opus', 0.2, { score: 2, confidence: 0.2 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: SONNET, effort: 'medium', agentId: undefined })
    expect(steps(w)[0]?.reasons).toEqual(['model:low-confidence', 'effort:low-confidence'])
  })

  test('on: at the default threshold of 0.5 the highest probability is taken', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('opus', 0.5, { score: 2, confidence: 0.5 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: OPUS, effort: 'high', agentId: undefined })
  })

  test('on: both thresholds come from settings', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on', model_threshold: 0.95, effort_threshold: 0.95 } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('opus', 0.9, { score: 2, confidence: 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: SONNET, effort: 'medium', agentId: undefined })
    expect(steps(w)[0]?.reasons).toEqual(['model:low-confidence', 'effort:low-confidence'])
  })

  test('on: effort is the most likely level, not the rounded score', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    // score 0.9 would round to medium; the most likely level is low.
    const w = world(on, answers('opus', 0.9, { score: 0.9, confidence: 0.6, probabilities: { '0': 0.5, '1': 0.1, '2': 0.4 } }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: OPUS, effort: 'low', agentId: undefined })
  })

  test('on: the highest probability among routable tiers is taken, whatever Jev\'s own pick', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const body = rankWide(0.9, 'speckit-specify', { choice: 'opus', confidence: 0.7 }, { score: 2, confidence: 0.9 }) as any
    body.answers.model_tier.probabilities = { haiku: 0.7, sonnet: 0.2, opus: 0.1 }
    const w = world(on, q => ('acts_on_user_system' in q ? { status: 200, body } : { status: 200, body: rerank(q, {}) }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]?.model).toBe(HAIKU)
  })

  test('on: below the threshold a configured fallback model is used', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on', fallback_model: 'haiku' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('opus', 0.2, { score: 2, confidence: 0.2 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]?.model).toBe(HAIKU)
    expect(steps(w)[0]?.reasons).toContain('model:fallback-haiku (low-confidence)')
  })

  test('on: a Jev error uses the configured fallback model too', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on', fallback_model: 'opus' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, () => ({ status: 500, body: {} }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]?.model).toBe(OPUS)
  })

  test('the effort level descriptions Jev sees come from settings', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { ...LEARNED, advanced: { effort_low: 'my low', effort_high: 'my high' } })
    const w = world(on, answers('opus', 0.9))
    bottom(on)

    await turn($, w)

    const levels = JSON.parse(w.fetches[0]?.body ?? '{}').questions.effort_level.criteria as string[]
    expect(levels[0]).toBe('my low')
    expect(levels[2]).toBe('my high')
    // An unset level keeps its default.
    expect(levels[1]).toContain('Some context needed')
  })

  test('on: effort has its own lower threshold: 0.45 changes effort while a 0.2 model falls back', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('opus', 0.2, { score: 1, confidence: 0.45, probabilities: { '0': 0.2, '1': 0.55, '2': 0.25 } }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: SONNET, effort: 'medium', agentId: undefined })
    expect(steps(w)[0]?.reasons).toEqual(['model:low-confidence', 'effort:same'])
  })

  test('on: a family whose full id has not been learned is never sent', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers('opus', 0.9))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]?.model).toBe(SONNET)
    expect(steps(w)[0]?.reasons).toContain('model:id-not-learned')
  })

  test('on: a target whose effort support is unknown is not switched to', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { caps: { ...CAPS, families: { haiku: { id: HAIKU, ok: true, at: '' } } } })
    const w = world(on, answers('haiku', 0.9))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]?.model).toBe(SONNET)
    expect(steps(w)[0]?.reasons).toContain('model:effort-support-unknown')
  })

  test('on: a target known to take no effort is sent without one', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { caps: { ...CAPS, families: { haiku: { id: HAIKU, ok: true, effort: false, at: '' } } } })
    const w = world(on, answers('haiku', 0.9))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: HAIKU, effort: undefined, agentId: undefined })
    expect(steps(w)[0]?.reasons).toContain('effort:target-has-none')
  })

  test('on: a Jev error keeps the session model', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, () => ({ status: 529, body: {} }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]?.model).toBe(SONNET)
    expect(steps(w)[0]?.reasons).toContain('model:no-jev-answer')
  })

  test('on: subagent steps keep their own model', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('opus', 0.9))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0, { agentId: 'a1', model: HAIKU })

    expect(seen[0]).toEqual({ model: HAIKU, effort: 'medium', agentId: 'a1' })
  })

  test('on: a failed routed request is resent on the session model and the model is not tried again', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('opus', 0.9))
    const seen = bottom(on, [OPUS])

    await turn($, w)
    const first = await step($, 't1', 0)
    await step($, 't1', 1)

    expect(seen.map(s => s.model)).toEqual([OPUS, SONNET, SONNET])
    expect(first.usage?.model).toBe(SONNET)
    expect(steps(w)[0]?.fallback).toContain('resent on the session model')
    expect(steps(w)[1]?.reasons).toContain('model:failed-this-session')
  })

  test('off: Jev is not asked about models and nothing changes', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('opus', 0.9))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(JSON.parse(w.fetches[0]?.body ?? '{}').questions.model_tier).toBeUndefined()
    expect(seen[0]?.model).toBe(SONNET)
  })
})

describe('learning and probe', () => {
  test('a main step teaches the current family without any probe', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers('opus', 0.9))
    bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    const status = await $.command.run({ command: 'jev-model', args: '' })
    expect(status.text).toContain(`sonnet: ${SONNET}, seen answering, takes effort (from main-step)`)
  })

  test('probe resolves each alias through a subagent, learns from its step, and arms the resend check', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers('opus', 0.9))
    const seen = bottom(on, [BAD])
    const ids: Record<string, string> = { haiku: HAIKU, sonnet: SONNET, opus: OPUS }
    // The engine resolves the alias and starts the subagent; its step follows.
    const spawned: string[] = []
    on('agent.spawn', async (_, e) => {
      const id = ids[e.model ?? ''] ?? 'unknown'
      spawned.push(id)
      return { model: id } as never
    })

    const out = await $.command.run({ command: 'jev-model', args: 'probe' })
    expect(spawned).toEqual([HAIKU, SONNET, OPUS])
    // From a hook (as here) agent.spawn may answer the alias; the id then comes from the step.
    expect(out.text).toMatch(/haiku: (haiku resolves to claude-haiku-test-id|subagent started)/)
    expect(out.text).toContain('retry check armed')

    // Each subagent's first step, as the engine would raise it.
    for (const id of spawned) {
      await step($, `sub-${id}`, 0, { model: id, effort: id === HAIKU ? undefined : 'medium', agentId: `a-${id}` })
    }
    await clock.settle()

    // The resend check rides the person's next message.
    await $.prompt.submit({ text: 'ok', asUser: true })
    await $.turn.start({ text: 'ok', turnId: 'p1' })
    await step($, 'p1', 0)

    expect(seen.slice(-2).map(s => s.model)).toEqual([BAD, SONNET])
    expect(w.fetches.length).toBe(0)

    const status = await $.command.run({ command: 'jev-model', args: '' })
    expect(status.text).toContain(`haiku: ${HAIKU}, seen answering, no effort`)
    expect(status.text).toContain(`opus: ${OPUS}, seen answering, takes effort`)
    expect(status.text).toContain('resend after a failed step: works')
  })
})

describe('settings kept off the page', () => {
  test('set applies at once, unset restores the default, bad values change nothing', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers('opus', 0.9))
    const requestChars = () => (JSON.parse(w.fetches.at(-1)?.body ?? '{}').state.request as string).length

    expect((await $.command.run({ command: 'jev-model', args: 'set max_prompt_chars 300' })).text).toContain('max_prompt_chars = 300')
    await $.prompt.submit({ text: 'x'.repeat(1000), asUser: true })
    expect(requestChars()).toBe(300)

    expect((await $.command.run({ command: 'jev-model', args: 'set max_prompt_chars 50' })).text).toContain('between 200 and 20000')
    await $.prompt.submit({ text: 'x'.repeat(1000), asUser: true })
    expect(requestChars()).toBe(300)

    expect((await $.command.run({ command: 'jev-model', args: 'unset max_prompt_chars' })).text).toContain('back to its default (2000)')
    await $.prompt.submit({ text: 'x'.repeat(1000), asUser: true })
    expect(requestChars()).toBe(1000)
  })

  test('an effort description keeps its case and spaces, and settings lists the change', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers('opus', 0.9))

    await $.command.run({ command: 'jev-model', args: 'set effort_high Weigh Several Approaches carefully' })
    await $.prompt.submit({ text: PROMPT, asUser: true })

    const levels = JSON.parse(w.fetches[0]?.body ?? '{}').questions.effort_level.criteria as string[]
    expect(levels[2]).toBe('Weigh Several Approaches carefully')
    const list = (await $.command.run({ command: 'jev-model', args: 'settings' })).text
    expect(list).toContain('effort_high = Weigh Several Approaches carefully  [changed')
    expect(list).toContain('timeout_ms = 8000  [default]')
  })

  test('an unknown name is refused with the list', { options: { typesafe_api_key: FAKE_KEY } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    world(on, answers('opus', 0.9))
    const out = await $.command.run({ command: 'jev-model', args: 'set nope 1' })
    expect(out.text).toContain('unknown setting "nope"')
    expect(out.text).toContain('timeout_ms')
  })
})

describe('reset to defaults', () => {
  test('/jev-model defaults restores changed settings, keeps the API key and switches the flag off', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, answers('opus', 0.9))

    const out = await $.command.run({ command: 'jev-model', args: 'defaults' })

    expect(w.sets).toEqual([
      { key: 'jev-router@inline.model_threshold', value: 0.5 },
      { key: 'jev-router@inline.fallback_model', value: 'session' },
      { key: 'jev-router@inline.reset_to_defaults', value: false },
    ])
    expect(out.text).toContain('model_threshold, fallback_model')
    expect(w.sets.some(s => s.key.endsWith('typesafe_api_key'))).toBe(false)
  })
})

describe('model policy', () => {
  test('the routable models come from the build\'s own list, special variants left out', () => {
    const a = availableFrom([{ key: 'model', label: 'Model', kind: 'choice', value: 'sonnet', options: ['default', 'sonnet[1m]', 'sonnet', 'opusplan', 'opus', 'haiku', 'fable', 'best'] }])
    expect(a.models).toEqual({ haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' })
  })

  test('no model row means nothing is routable', () => {
    expect(availableFrom([]).models).toEqual({})
  })

  test('effort outside low, medium and high is never produced', () => {
    const d = decide('r', undefined, { score: 9, confidence: 1 }, { models: {}, source: '', raw: [] }, { model: 0.5, effort: 0.4 })
    expect(d.effort).toBe('high')
  })

  test('the same family keeps the step\'s own model string', () => {
    const p = planStep({ model: 'claude-sonnet-x', effort: 'high' }, { round: 'r', family: 'sonnet', effort: 'high' }, 'on', undefined, new Set())
    expect(p.changed).toBe(false)
    expect(p.reasons).toEqual(['model:same-family', 'effort:same'])
  })

  test('a bare alias is never learned as an id', () => {
    expect(learn({ version: 'v', families: {} }, { model: 'opus' }, true, 't', '')).toBeUndefined()
  })
})

describe('turn note', () => {
  // The engine's own answer for a turn: the model's text, shown as it is.
  const complete = (on: On) => on('turn.complete', () => ({ text: 'hi' }) as never)

  test('a switched turn says which model answered and what Jev chose', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('haiku', 1, { score: 0.06, confidence: 0.91 }))
    bottom(on)
    complete(on)

    await turn($, w)
    await step($, 't1', 0)
    const done = await $.turn.complete({ answer: 'hi', durationMs: 1, reason: 'answer', isAborted: false, turnId: 't1', usage: { model: HAIKU, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)

    // The note alone: the answer itself is never repeated beneath it.
    expect(done.text).toBe(`jev-router: answered by ${HAIKU} · effort low · Jev chose haiku/low`)
  })

  test('a fallback turn names the fallback', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on', fallback_model: 'haiku' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('opus', 0.2, { score: 2, confidence: 0.2 }))
    bottom(on)
    complete(on)

    await turn($, w)
    await step($, 't1', 0)
    const done = await $.turn.complete({ answer: 'hi', durationMs: 1, reason: 'answer', isAborted: false, turnId: 't1', usage: { model: HAIKU, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)

    expect(done.text).toContain(`answered by ${HAIKU}`)
    expect(done.text).toContain('fallback haiku (low-confidence)')
  })

  test('a dry-run turn says nothing was switched', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers('haiku', 1, { score: 0.06, confidence: 0.91 }))
    bottom(on)
    complete(on)

    await turn($, w)
    await step($, 't1', 0)
    const done = await $.turn.complete({ answer: 'hi', durationMs: 1, reason: 'answer', isAborted: false, turnId: 't1', usage: { model: SONNET, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)

    expect(done.text).toContain('dry-run, nothing was switched')
    expect(done.text).toContain('Jev chose haiku/low')
  })
})
