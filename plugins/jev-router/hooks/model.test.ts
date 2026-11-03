// Dry-run and switching tests for model routing. Jev's answers are given by
// the test; turn.step's bottom is the test's own, so no model is ever called.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { FAKE_KEY, PROMPT, logLines, memoryStore, rankWide, rerank, world, type World } from './testkit'
import { rankWideBody } from './router'
import { FAMILIES, availableFrom, decide, familyOf, learn, monotonic, planStep } from './model'
import { outputEstimate } from './cost'

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

// Jev's feasibility per 'tier::effort'; every other pair asked is judged
// unable (0.1).
const answers = (feasible: Record<string, number> = {}) =>
  (q: Record<string, unknown>) =>
    // Request 1 carries the skill gates and/or the model questions; Jev answers what is asked.
    'catalog_has_match' in q || Object.keys(q).some(k => k.startsWith('feasible::'))
      ? { status: 200, body: rankWide(0.9, 'speckit-specify', feasible, q) }
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

const ON = { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' }

const steps = (w: World) => logLines(w).filter(l => l.type === 'step')

// The session model is opus (world's default) and steps come as sonnet; opus
// and haiku are learned. No context is known here, so pairs are ordered by
// list price, then tier, then effort (unknown test ids: tier, then effort).
describe('model routing', () => {
  test('dry-run: logs what Jev would send and sends the session model unchanged', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, feasibility_threshold: 0.6 } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::high': 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    const result = await step($, 't1', 0)

    expect(seen).toEqual([{ model: SONNET, effort: 'medium', agentId: undefined }])
    expect(result.usage?.model).toBe(SONNET)
    const [s] = steps(w)
    expect(s?.would_model).toBe(OPUS)
    expect(s?.would_effort).toBe('high')
    expect(s?.reasons?.[0]).toBe('dry-run')
    expect(logLines(w).find(l => l.type === 'round')?.decision).toEqual({ family: 'opus', effort: 'high', how: 'cheapest-feasible', threshold: 0.6 })
  })

  test('Jev is asked every routable tier at every effort, apart from cost', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers())
    bottom(on)

    await turn($, w)

    const questions = JSON.parse(w.fetches[0]?.body ?? '{}').questions
    expect(Object.keys(questions).filter(k => k.startsWith('feasible::'))).toEqual(['haiku', 'opus'].flatMap(f => ['low', 'medium', 'high', 'xhigh', 'max'].map(e => `feasible::${f}::${e}`)))
    expect(questions.model_tier).toBeUndefined()
    expect(questions.effort_level).toBeUndefined()
  })

  test('on: every main step of the turn is sent with the learned full id and effort', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::high': 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)
    const second = await step($, 't1', 1)

    expect(seen.map(s => `${s.model}/${String(s.effort)}`)).toEqual([`${OPUS}/high`, `${OPUS}/high`])
    expect(second.usage?.model).toBe(OPUS)
    expect(steps(w).map(s => s.answered_by)).toEqual([OPUS, OPUS])
    expect(w.fetches.length).toBe(2)
  })

  test('on: the cheapest pair Jev judges feasible runs: a lower tier and a lower effort first', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'haiku::medium': 0.9, 'haiku::high': 0.95, 'opus::low': 0.99 }))
    const seen = bottom(on)

    await turn($, w, 'Refactor the entire payment ledger across all services and redesign its architecture.')
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: HAIKU, effort: 'medium', agentId: undefined })
  })

  test('on: xhigh and max are asked about and sent when they are the only able pairs, and cost more than lower efforts', { options: ON }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::xhigh': 0.8, 'opus::max': 0.95 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    const questions = JSON.parse(w.fetches[0]?.body ?? '{}').questions
    expect(questions['feasible::opus::xhigh'].instructions).toContain('Deeper than high')
    expect(questions['feasible::opus::max'].instructions).toContain('most thorough the model offers')
    // Both clear the threshold; the cheaper (xhigh) runs.
    expect(seen[0]).toEqual({ model: OPUS, effort: 'xhigh', agentId: undefined })
    const round = logLines(w).find(l => l.type === 'round')!
    expect(round.candidates.filter((c: any) => c.pair.startsWith('opus/')).map((c: any) => c.pair)).toEqual(['opus/low', 'opus/medium', 'opus/high', 'opus/xhigh', 'opus/max'])
  })

  test('on: max is sent when it is the only pair Jev judges able', { options: ON }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::max': 0.95 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: OPUS, effort: 'max', agentId: undefined })
  })

  test('on: a cheaper pair below the feasibility threshold gives way to a dearer feasible one', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on', feasibility_threshold: 0.6 } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'haiku::low': 0.59, 'opus::medium': 0.8 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: OPUS, effort: 'medium', agentId: undefined })
  })

  test('on: the feasibility threshold comes from settings; with no pair feasible the most able runs', { options: { ...ON, feasibility_threshold: 0.95 } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'haiku::low': 0.6, 'opus::high': 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: OPUS, effort: 'high', agentId: undefined })
    expect(steps(w)[0]?.reasons).toContain('model:none-feasible-most-capable')
  })

  test('on: a Jev error uses the configured fallback model', { options: { ...ON, fallback_model: 'haiku' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, () => ({ status: 500, body: {} }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]?.model).toBe(HAIKU)
    expect(steps(w)[0]?.reasons).toContain('model:fallback-haiku (no-jev-answer)')
  })

  test('the effort descriptions Jev sees come from settings', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { ...LEARNED, advanced: { effort_low: 'my low', effort_high: 'my high' } })
    const w = world(on, answers())
    bottom(on)

    await turn($, w)

    const questions = JSON.parse(w.fetches[0]?.body ?? '{}').questions
    expect(questions['feasible::opus::low'].instructions).toContain('my low')
    expect(questions['feasible::opus::high'].instructions).toContain('my high')
    // An unset level keeps its default.
    expect(questions['feasible::opus::medium'].instructions).toContain('Moderate thoroughness')
  })

  test('on: a tier whose full id has not been learned is neither asked nor sent', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers({ 'opus::high': 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(Object.keys(JSON.parse(w.fetches[0]?.body ?? '{}').questions).some(k => k.startsWith('feasible::'))).toBe(false)
    expect(seen[0]?.model).toBe(SONNET)
    expect(steps(w)[0]?.reasons).toContain('model:none-routable')
  })

  test('on: a tier whose effort support is unknown is not asked about', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { caps: { ...CAPS, families: { haiku: { id: HAIKU, ok: true, at: '' } } } })
    const w = world(on, answers({ 'haiku::low': 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(JSON.parse(w.fetches[0]?.body ?? '{}').questions['feasible::haiku::low']).toBeUndefined()
    expect(seen[0]?.model).toBe(SONNET)
  })

  test('on: a target known to take no effort is sent without one', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { caps: { ...CAPS, families: { haiku: { id: HAIKU, ok: true, effort: false, at: '' } } } })
    const w = world(on, answers({ 'haiku::low': 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]).toEqual({ model: HAIKU, effort: undefined, agentId: undefined })
    expect(steps(w)[0]?.reasons).toContain('effort:target-has-none')
  })

  test('on: a Jev error keeps the session model', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, () => ({ status: 529, body: {} }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(seen[0]?.model).toBe(SONNET)
    expect(steps(w)[0]?.reasons).toContain('model:no-jev-answer')
  })

  test('on: subagent steps keep their own model', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::high': 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0, { agentId: 'a1', model: HAIKU })

    expect(seen[0]).toEqual({ model: HAIKU, effort: 'medium', agentId: 'a1' })
  })

  test('on: a failed routed request is resent on the session model and the model is not tried again', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::high': 0.9 }))
    const seen = bottom(on, [OPUS])

    await turn($, w)
    const first = await step($, 't1', 0)
    await step($, 't1', 1)

    // The routed request, two more after a probe each, then the session model.
    expect(seen.map(s => s.model)).toEqual([OPUS, OPUS, OPUS, SONNET, SONNET])
    expect(first.usage?.model).toBe(SONNET)
    expect(steps(w)[0]?.fallback).toContain('resent on the session model')
    expect(steps(w)[0]?.fallback).toContain('after 2 probes')
    expect(steps(w)[0]?.reprobes).toBe(2)
    expect(steps(w)[1]?.reasons).toContain('model:failed-this-session')
  })

  test('off: Jev is not asked about models and nothing changes', { options: { ...ON, model_routing: 'off' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::high': 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(Object.keys(JSON.parse(w.fetches[0]?.body ?? '{}').questions).some(k => k.startsWith('feasible::'))).toBe(false)
    expect(seen[0]?.model).toBe(SONNET)
  })
})

describe('learning and probe', () => {
  test('a main step teaches the current family without any probe', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers({ 'opus::high': 0.9 }))
    bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    const status = await $.command.run({ command: 'jev-model', args: '' })
    expect(status.text).toContain(`sonnet: ${SONNET}, seen answering, takes effort (from main-step)`)
  })

  test('probe resolves each alias through a subagent, learns from its step, and arms the resend check', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers({ 'opus::high': 0.9 }))
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

    // The resend check rides the person's next message; nothing is left to
    // probe automatically.
    await $.prompt.submit({ text: 'ok', asUser: true })
    await $.turn.start({ text: 'ok', turnId: 'p1' })
    await step($, 'p1', 0)

    expect(seen.slice(-2).map(s => s.model)).toEqual([BAD, SONNET])
    expect(spawned.length).toBe(3)
    expect(w.fetches.length).toBe(0)

    const status = await $.command.run({ command: 'jev-model', args: '' })
    expect(status.text).toContain(`haiku: ${HAIKU}, seen answering, no effort`)
    expect(status.text).toContain(`opus: ${OPUS}, seen answering, takes effort`)
    expect(status.text).toContain('resend after a failed step: works')
  })
})

describe('automatic probe', () => {
  const spawns = (on: On) => {
    const aliases: string[] = []
    on('agent.spawn', async (_, e) => {
      aliases.push(String(e.model))
      return { model: e.model === 'haiku' ? HAIKU : e.model === 'sonnet' ? SONNET : OPUS } as never
    })
    return aliases
  }

  test('first use: the message waits for the probe, then Jev chooses the model; once per load', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers())
    bottom(on)
    const aliases = spawns(on)

    // opus and haiku are learned; sonnet is not: the message is held for it.
    const submitted = $.prompt.submit({ text: PROMPT, asUser: true })
    await clock.advance(300)
    expect(aliases).toEqual(['sonnet'])
    expect(w.fetches).toHaveLength(0)
    expect(w.status.at(-1)).toContain('probing sonnet before choosing a model')

    // The probe's subagent answers; the message then goes on to Jev.
    await step($, 'sub', 0, { model: SONNET, effort: 'medium', agentId: 'probe-1' })
    await clock.advance(300)
    await submitted
    expect(w.fetches.length).toBeGreaterThan(0)
    await $.turn.start({ text: PROMPT, turnId: 't1' })
    const probe = logLines(w).find(l => l.type === 'probe' && l.kind === 'wait')
    expect(probe).toMatchObject({ families: ['sonnet'], done: true })
    expect(logLines(w).find(l => l.type === 'probe' && l.kind === 'auto')?.families).toEqual(['sonnet'])

    await $.prompt.submit({ text: 'again', asUser: true })
    await $.turn.start({ text: 'again', turnId: 't2' })
    expect(aliases).toEqual(['sonnet'])
  })

  test('a probe that never answers holds the message only for the wait, then it goes on', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers())
    bottom(on)
    spawns(on)

    const submitted = $.prompt.submit({ text: PROMPT, asUser: true })
    await clock.advance(19000)
    expect(w.fetches).toHaveLength(0)
    await clock.advance(2000)
    await submitted
    expect(w.fetches.length).toBeGreaterThan(0)
    expect(logLines(w).find(l => l.type === 'probe' && l.kind === 'wait')).toMatchObject({ families: ['sonnet'], done: false })
  })

  test('probe_wait_ms 0 does not hold the message', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { ...LEARNED, advanced: { probe_wait_ms: 0 } })
    const w = world(on, answers())
    bottom(on)
    const aliases = spawns(on)
    await turn($, w)
    expect(w.fetches.length).toBeGreaterThan(0)
    // The probe still starts, at the turn.
    expect(aliases).toEqual(['sonnet'])
  })

  test('no automatic probe with model routing off', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, model_routing: 'off' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers())
    bottom(on)
    const aliases = spawns(on)
    await turn($, w)
    expect(aliases).toEqual([])
  })

  test('auto_probe off is kept in $.store', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { advanced: { auto_probe: false } })
    const w = world(on, answers())
    bottom(on)
    const aliases = spawns(on)
    await turn($, w)
    expect(aliases).toEqual([])
  })

  test('a routed request that fails probes that family again', { options: ON }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { caps: { ...CAPS, families: { ...CAPS.families, sonnet: { id: SONNET, ok: true, effort: true, at: '' } } } })
    const w = world(on, answers({ 'opus::high': 0.9 }))
    bottom(on, [OPUS])
    const aliases = spawns(on)

    await turn($, w)
    expect(aliases).toEqual([])
    await step($, 't1', 0)
    expect(aliases).toEqual(['opus', 'opus'])
    const whys = logLines(w).filter(l => l.type === 'probe' && l.kind === 'auto').map(l => l.why)
    expect(whys).toEqual(['a routed request to opus failed (probe 1 of 2)', 'a routed request to opus failed (probe 2 of 2)'])
  })
})

describe('skill selection switch', () => {
  const wideQuestions = (w: World) => JSON.parse(w.fetches[0]?.body ?? '{}').questions as Record<string, unknown>

  test('on by default: skills are ranked and gated beside the model questions', { options: ON }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::high': 0.9 }))
    bottom(on)
    await turn($, w)
    expect(Object.keys(wideQuestions(w))).toEqual(expect.arrayContaining(['which', 'catalog_has_match', 'feasible::opus::high']))
    expect(logLines(w).find(l => l.type === 'round')?.skill_routing).toBe(true)
  })

  test('off: no skill is asked about or suggested, and model routing carries on', { options: { ...ON, skill_routing: false, tool_routing: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::high': 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    // One request, with the model questions alone.
    expect(w.fetches.length).toBe(1)
    const keys = Object.keys(wideQuestions(w))
    expect(keys.every(k => k.startsWith('feasible::'))).toBe(true)
    expect(keys.length).toBe(10)
    // Nothing is added beside the prompt, and the model still switches.
    expect(w.seen?.context ?? []).toEqual([])
    expect(seen[0]).toEqual({ model: OPUS, effort: 'high', agentId: undefined })
    const round = logLines(w).find(l => l.type === 'round')!
    expect(round).toMatchObject({ skill_routing: false, outcome: 'no-match', reason: 'skill-routing-off', index_size: 0 })
    expect(round.decision.family).toBe('opus')
  })

  test('off with model routing off too: Jev is not called at all', { options: { ...ON, skill_routing: false, tool_routing: true, model_routing: 'off' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::high': 0.9 }))
    bottom(on)
    await turn($, w)
    expect(w.fetches.length).toBe(0)
    expect(logLines(w).find(l => l.type === 'round')?.reason).toBe('skill-routing-off')
  })

  test('/jev-model skills writes the setting and applies at once; the status line shows it', { options: ON }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::high': 0.9 }))
    bottom(on)

    expect((await $.command.run({ command: 'jev-model', args: 'skills' })).text).toContain('skill selection is on')
    const off = await $.command.run({ command: 'jev-model', args: 'skills off' })
    expect(off.text).toContain('skill selection is now off')
    expect(w.sets).toEqual([{ key: 'jev-router@inline.skill_routing', value: false }])
    expect((await $.command.run({ command: 'jev-model', args: '' })).text).toContain('skill selection: off')

    await turn($, w)
    expect(Object.keys(wideQuestions(w)).every(k => k.startsWith('feasible::'))).toBe(true)

    const back = await $.command.run({ command: 'jev-model', args: 'skills on' })
    expect(back.text).toContain('skill selection is now on')
    expect(w.sets.at(-1)).toEqual({ key: 'jev-router@inline.skill_routing', value: true })
    expect((await $.command.run({ command: 'jev-model', args: '' })).text).toContain('skill selection: on')
  })

  test('defaults turns skill selection back off', { options: { ...ON, skill_routing: true, tool_routing: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers())
    bottom(on)
    await $.command.run({ command: 'jev-model', args: 'defaults' })
    expect(w.configRows.find(r => r.key.endsWith('.skill_routing'))?.value).toBe(false)
  })
})

describe('settings kept off the page', () => {
  test('set applies at once, unset restores the default, bad values change nothing', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers({ 'opus::high': 0.9 }))
    const requestChars = () => (JSON.parse(w.fetches.at(-1)?.body ?? '{}').state.request as string).length

    expect((await $.command.run({ command: 'jev-model', args: 'set max_prompt_chars 300' })).text).toContain('max_prompt_chars = 300')
    await $.prompt.submit({ text: 'x'.repeat(1000), asUser: true })
    expect(requestChars()).toBe(300)

    expect((await $.command.run({ command: 'jev-model', args: 'set max_prompt_chars 50' })).text).toContain('between 200 and 20000')
    await $.prompt.submit({ text: 'x'.repeat(1000), asUser: true })
    expect(requestChars()).toBe(300)

    expect((await $.command.run({ command: 'jev-model', args: 'unset max_prompt_chars' })).text).toContain('back to its default (4000)')
    await $.prompt.submit({ text: 'x'.repeat(1000), asUser: true })
    expect(requestChars()).toBe(1000)
  })

  test('an effort description keeps its case and spaces, and settings lists the change', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::high': 0.9 }))

    await $.command.run({ command: 'jev-model', args: 'set effort_high Weigh Several Approaches carefully' })
    await $.prompt.submit({ text: PROMPT, asUser: true })

    expect(JSON.parse(w.fetches[0]?.body ?? '{}').questions['feasible::opus::high'].instructions).toContain('Weigh Several Approaches carefully')
    const list = (await $.command.run({ command: 'jev-model', args: 'settings' })).text
    expect(list).toContain('effort_high = Weigh Several Approaches carefully  [changed')
    expect(list).toContain('timeout_ms = 9000  [default]')
  })

  test('an unknown name is refused with the list', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    world(on, answers({ 'opus::high': 0.9 }))
    const out = await $.command.run({ command: 'jev-model', args: 'set nope 1' })
    expect(out.text).toContain('unknown setting "nope"')
    expect(out.text).toContain('timeout_ms')
  })
})

describe('reset to defaults', () => {
  test('/jev-model defaults restores changed settings, keeps the API key and switches the flag off', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, answers({ 'opus::high': 0.9 }))

    const out = await $.command.run({ command: 'jev-model', args: 'defaults' })

    expect(w.sets).toEqual([
      { key: 'jev-router@inline.model_threshold', value: 0.5 },
      { key: 'jev-router@inline.skill_routing', value: false },
      { key: 'jev-router@inline.fallback_model', value: 'session' },
      { key: 'jev-router@inline.reset_to_defaults', value: false },
    ])
    expect(out.text).toContain('model_threshold, skill_routing, fallback_model')
    expect(w.sets.some(s => s.key.endsWith('typesafe_api_key'))).toBe(false)
  })
})

describe('model policy', () => {
  test('the routable models come from the build\'s own list, special variants left out', () => {
    const a = availableFrom([{ key: 'model', label: 'Model', kind: 'choice', value: 'sonnet', options: ['default', 'sonnet[1m]', 'sonnet', 'opusplan', 'opus', 'haiku', 'fable', 'best'] }])
    expect(a.models).toEqual({ haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', fable: 'fable' })
  })

  test('no model row means nothing is routable', () => {
    expect(availableFrom([]).models).toEqual({})
  })

  const costs = (table: Record<string, number | undefined>) => (family: string, effort: string) => ({ usd: table[`${family}::${effort}`] })

  test('the cheapest pair at or above the threshold is taken, not the most feasible', () => {
    const d = decide('r', { haiku: { high: 0.8 }, sonnet: { low: 0.9 }, opus: { low: 0.4 } }, ['haiku', 'sonnet', 'opus'], costs({ 'haiku::high': 0.5, 'sonnet::low': 0.3, 'opus::low': 0.2 }), 0.6)
    expect([d.family, d.effort, d.how, d.usd]).toEqual(['sonnet', 'low', 'cheapest-feasible', 0.3])
    expect(d.candidates?.map(c => `${c.family}/${c.effort}`)).toEqual(['opus/low', 'sonnet/low', 'haiku/high'])
  })

  test('a known cost sorts before an unknown one; unknown ones by list price, then tier and effort', () => {
    const d = decide('r', { haiku: { low: 0.9, high: 0.9 }, opus: { low: 0.9 } }, ['haiku', 'opus'], (family, effort) => (family === 'opus' ? { usd: 9 } : { rank: effort === 'high' ? 1 : 2 }), 0.6)
    expect(d.candidates?.map(c => `${c.family}/${c.effort}`)).toEqual(['opus/low', 'haiku/high', 'haiku/low'])
    const tie = decide('r', { haiku: { medium: 0.9, low: 0.9 }, sonnet: { low: 0.9 } }, ['haiku', 'sonnet'], () => ({}), 0.6)
    expect([tie.family, tie.effort]).toEqual(['haiku', 'low'])
  })

  test('pairs costing within the tolerance of the cheapest compete on feasibility; farther ones do not', () => {
    const feas = { haiku: { low: 0.65 }, sonnet: { low: 0.8 }, opus: { low: 0.95 } }
    const table = costs({ 'haiku::low': 1.0, 'sonnet::low': 1.02, 'opus::low': 1.1 })
    const d = decide('r', feas, ['haiku', 'sonnet', 'opus'], table, 0.6, 0.03)
    expect([d.family, d.how, d.usd]).toEqual(['sonnet', 'most-feasible-within-tolerance', 1.02])
    // Tolerance 0, or the cheapest already the likeliest: the cheapest runs.
    expect(decide('r', feas, ['haiku', 'sonnet', 'opus'], table, 0.6, 0).family).toBe('haiku')
    expect(decide('r', { haiku: { low: 0.9 }, sonnet: { low: 0.8 } }, ['haiku', 'sonnet'], costs({ 'haiku::low': 1.0, 'sonnet::low': 1.01 }), 0.6, 0.03).how).toBe('cheapest-feasible')
    // Within tolerance and equally likely, or only a hair likelier: the cheaper stays.
    expect(decide('r', { haiku: { low: 0.8 }, sonnet: { low: 0.8 } }, ['haiku', 'sonnet'], costs({ 'haiku::low': 1.0, 'sonnet::low': 1.01 }), 0.6, 0.03).family).toBe('haiku')
    expect(decide('r', { haiku: { low: 0.8 }, sonnet: { low: 0.84 } }, ['haiku', 'sonnet'], costs({ 'haiku::low': 1.0, 'sonnet::low': 1.01 }), 0.6, 0.03).family).toBe('haiku')
    // Each step up must clear the margin from the pair before it: 0.65 to 0.72 is too little, 0.65 to 0.9 is not.
    expect(decide('r', { haiku: { low: 0.65 }, sonnet: { low: 0.72 }, opus: { low: 0.9 } }, ['haiku', 'sonnet', 'opus'], costs({ 'haiku::low': 1.0, 'sonnet::low': 1.01, 'opus::low': 1.02 }), 0.6, 0.03).family).toBe('opus')
    // A pair below the threshold never competes, however close its cost.
    expect(decide('r', { haiku: { low: 0.65 }, sonnet: { low: 0.5 } }, ['haiku', 'sonnet'], costs({ 'haiku::low': 1.0, 'sonnet::low': 1.0 }), 0.6, 0.03).family).toBe('haiku')
    // Without a known cost there is nothing to compare: the list-price order stands.
    expect(decide('r', { haiku: { low: 0.65 }, sonnet: { low: 0.99 } }, ['haiku', 'sonnet'], () => ({}), 0.6, 0.03).family).toBe('haiku')
  })

  test('with no pair feasible, the most able runs, the cheaper of equals', () => {
    const d = decide('r', { haiku: { low: 0.3 }, sonnet: { high: 0.5 }, opus: { high: 0.5 } }, ['haiku', 'sonnet', 'opus'], costs({ 'haiku::low': 0.1, 'sonnet::high': 0.4, 'opus::high': 0.2 }), 0.6)
    expect([d.family, d.effort, d.how]).toEqual(['opus', 'high', 'none-feasible-most-capable'])
  })

  test('with no pair feasible, a cheaper pair within a hair of the likeliest stands in for it', () => {
    const feasible = { opus: { medium: 0.4, high: 0.45, xhigh: 0.47, max: 0.48 } }
    const d = decide('r', feasible, ['opus'], costs({ 'opus::medium': 1, 'opus::high': 1.2, 'opus::xhigh': 1.5, 'opus::max': 2.5 }), 0.5)
    expect([d.family, d.effort, d.how]).toEqual(['opus', 'high', 'none-feasible-most-capable'])
  })

  test('with no pair feasible, a clearly likelier pair still wins over a cheaper one', () => {
    const d = decide('r', { sonnet: { high: 0.2 }, opus: { high: 0.45 } }, ['sonnet', 'opus'], costs({ 'sonnet::high': 0.5, 'opus::high': 2 }), 0.5)
    expect([d.family, d.effort]).toEqual(['opus', 'high'])
  })

  test('only routable tiers are candidates; none answered is no-jev-answer', () => {
    expect(decide('r', { opus: { high: 0.9 } }, ['haiku'], () => ({}), 0.6).modelReason).toBe('none-routable')
    expect(decide('r', undefined, ['haiku'], () => ({}), 0.6).modelReason).toBe('no-jev-answer')
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

  test('a switched turn says which model answered and what Jev chose', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'haiku::low': 0.9 }))
    bottom(on)
    complete(on)

    await turn($, w)
    await step($, 't1', 0)
    const done = await $.turn.complete({ answer: 'hi', durationMs: 1, reason: 'answer', isAborted: false, turnId: 't1', usage: { model: HAIKU, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)

    // One line naming who answered; the answer and cache detail are not repeated.
    expect(done.text).toBe(`jev-router: answered by ${HAIKU} · requested effort low · cheapest feasible haiku/low, cost unknown`)
  })

  test('a fallback turn names the fallback', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on', fallback_model: 'haiku' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, () => ({ status: 500, body: {} }))
    bottom(on)
    complete(on)

    await turn($, w)
    await step($, 't1', 0)
    const done = await $.turn.complete({ answer: 'hi', durationMs: 1, reason: 'answer', isAborted: false, turnId: 't1', usage: { model: HAIKU, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)

    expect(done.text).toContain(`answered by ${HAIKU}`)
    expect(done.text).toContain('fallback haiku (no-jev-answer)')
  })

  test('a dry-run turn says nothing was switched', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'haiku::low': 0.9 }))
    bottom(on)
    complete(on)

    await turn($, w)
    await step($, 't1', 0)
    const done = await $.turn.complete({ answer: 'hi', durationMs: 1, reason: 'answer', isAborted: false, turnId: 't1', usage: { model: SONNET, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)

    expect(done.text).toContain('dry-run, nothing was switched')
    expect(done.text).toContain('cheapest feasible haiku/low')
  })
})

describe('a bigger tier is never rated below a smaller one', () => {
  test('monotonic raises each tier to the best of those below it, effort by effort, and changes nothing else', () => {
    const raw = { haiku: { low: 0.3, high: 0.9 }, sonnet: { low: 0.1, high: 0.5, max: 0.4 }, opus: { low: 0.2, high: 0.95, max: 0.1 } }
    expect(monotonic(raw)).toEqual({ haiku: { low: 0.3, high: 0.9 }, sonnet: { low: 0.3, high: 0.9, max: 0.4 }, opus: { low: 0.3, high: 0.95, max: 0.4 } })
    // A tier not asked about is skipped, not invented.
    expect(monotonic({ sonnet: { low: 0.7 }, opus: { medium: 0.2 } })).toEqual({ sonnet: { low: 0.7 }, opus: { medium: 0.2 } })
    expect(monotonic({})).toEqual({})
    expect(raw.sonnet.low).toBe(0.1)
  })

  test('what Sonnet can do Opus can too: the likelier of the cheaper pairs is not undercut by an inverted Opus', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, model_routing: 'on', write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'sonnet::medium': 0.9 }))
    bottom(on)
    await turn($, w)
    const round = logLines(w).find(l => l.type === 'round')!
    // Jev rated Opus at 0.1 everywhere; the router lifts it to Sonnet's 0.9 at medium.
    expect(round.jev_feasible.opus.medium).toBe(0.9)
    expect(round.jev_feasible_raw.opus.medium).toBe(0.1)
  })

  test('tier_monotonic off uses Jev\'s ratings as given and records no raw copy', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, model_routing: 'on', write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { ...LEARNED, advanced: { tier_monotonic: false } })
    const w = world(on, answers({ 'sonnet::medium': 0.9 }))
    bottom(on)
    await turn($, w)
    const round = logLines(w).find(l => l.type === 'round')!
    expect(round.jev_feasible.opus.medium).toBe(0.1)
    expect(round.jev_feasible_raw).toBeUndefined()
  })

  test('the questions say the tier is judged on ability, and the default descriptions say what each can do', () => {
    const asked = rankWideBody('Fix the bug.', [], { model: 'jev-latest', gateThreshold: 0.3, fitsThreshold: 0.3, shortlist: 3, modelFamilies: ['sonnet', 'opus'] }).questions as Record<string, { instructions: string }>
    const q = asked['feasible::opus::high']!.instructions
    expect(q).toContain('A more capable tier can do everything a less capable one can')
    expect(q).toContain('Anything a smaller tier can complete, it can complete too.')
    expect(q).toContain('routing_context.judging')
    expect(asked['feasible::sonnet::high']!.instructions).toContain('It can do everything the smaller tier can')
  })
})

describe('escalating when the work goes wrong', () => {
  const ESCALATE = { ...ON, escalation: 'on' }

  // The tool beneath: a command starting "fail" errors, any other works.
  const tools = (on: On) => {
    on('tool.call', async (_$, e) => ({ isError: String((e as { command?: unknown }).command ?? '').startsWith('fail') ? true : undefined, result: 'x' }) as never)
  }
  const call = ($: Engine, command: string, tool = 'Bash') => $.tool.call({ tool, command, file_path: command } as never)
  const sent = (seen: Seen[]) => seen.map(s => `${s.model}/${String(s.effort)}`)

  test('three failed commands in a row raise the effort for the steps after, and it stays raised', { options: ESCALATE }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::medium': 0.9 }))
    const seen = bottom(on)
    tools(on)

    await turn($, w)
    await step($, 't1', 0)
    await call($, 'fail one')
    await call($, 'fail two')
    await call($, 'fail three')
    await step($, 't1', 1)
    await step($, 't1', 2)

    expect(sent(seen)).toEqual([`${OPUS}/medium`, `${OPUS}/high`, `${OPUS}/high`])
    const escalations = steps(w).map(s => s.escalation).filter(Boolean)
    expect(escalations).toHaveLength(1)
    expect(escalations[0]).toMatchObject({ trigger: 'failures', kind: 'effort', to_effort: 'high', live: true })
    expect(steps(w)[1]!.reasons).toContain('escalate:failures')
  })

  test('a command that works in between ends the run, so nothing is raised', { options: ESCALATE }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::medium': 0.9 }))
    const seen = bottom(on)
    tools(on)

    await turn($, w)
    await step($, 't1', 0)
    await call($, 'fail one')
    await call($, 'fail two')
    await call($, 'fine')
    await call($, 'fail three')
    await step($, 't1', 1)

    expect(sent(seen)).toEqual([`${OPUS}/medium`, `${OPUS}/medium`])
    expect(steps(w).some(s => s.escalation)).toBe(false)
  })

  test('failed reads and searches are ordinary searching', { options: ESCALATE }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::medium': 0.9 }))
    const seen = bottom(on)
    tools(on)

    await turn($, w)
    await step($, 't1', 0)
    for (const tool of ['Read', 'Grep', 'Read', 'Glob']) await call($, 'fail x', tool)
    await step($, 't1', 1)

    expect(sent(seen)).toEqual([`${OPUS}/medium`, `${OPUS}/medium`])
  })

  test('dry-run only logs what it would do', { options: { ...ON, escalation: 'dry-run' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::medium': 0.9 }))
    const seen = bottom(on)
    tools(on)

    await turn($, w)
    await step($, 't1', 0)
    for (const c of ['fail 1', 'fail 2', 'fail 3']) await call($, c)
    await step($, 't1', 1)

    expect(sent(seen)).toEqual([`${OPUS}/medium`, `${OPUS}/medium`])
    expect(steps(w)[1]!.escalation).toMatchObject({ trigger: 'failures', to_effort: 'high', live: false })
  })

  test('off watches nothing', { options: { ...ON, escalation: 'off' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::medium': 0.9 }))
    const seen = bottom(on)
    tools(on)

    await turn($, w)
    await step($, 't1', 0)
    for (const c of ['fail 1', 'fail 2', 'fail 3']) await call($, c)
    await step($, 't1', 1)

    expect(sent(seen)).toEqual([`${OPUS}/medium`, `${OPUS}/medium`])
    expect(steps(w).some(s => s.escalation)).toBe(false)
  })

  test('with model routing dry-run nothing is switched, whatever escalation says', { options: { ...ESCALATE, model_routing: 'dry-run' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::medium': 0.9 }))
    const seen = bottom(on)
    tools(on)

    await turn($, w)
    await step($, 't1', 0)
    for (const c of ['fail 1', 'fail 2', 'fail 3']) await call($, c)
    await step($, 't1', 1)

    expect(sent(seen)).toEqual([`${SONNET}/medium`, `${SONNET}/medium`])
    expect(steps(w)[1]!.escalation).toMatchObject({ live: false })
  })

  test('a new turn starts clean', { options: ESCALATE }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::medium': 0.9 }))
    const seen = bottom(on)
    tools(on)
    on('turn.complete', () => ({ text: '' }) as never)

    await turn($, w)
    await step($, 't1', 0)
    for (const c of ['fail 1', 'fail 2', 'fail 3']) await call($, c)
    await step($, 't1', 1)
    await $.turn.complete({ turnId: 't1', answer: 'OK', durationMs: 1, isAborted: false } as never)
    await $.prompt.submit({ text: PROMPT, asUser: true })
    await $.turn.start({ text: PROMPT, turnId: 't2' })
    await step($, 't2', 0)

    expect(sent(seen)).toEqual([`${OPUS}/medium`, `${OPUS}/high`, `${OPUS}/medium`])
  })
})

describe('Fable, the tier above Opus', () => {
  test('it is routable when the Model row lists it, and its special variants are not', () => {
    const a = availableFrom([{ key: 'model', label: 'Model', kind: 'choice', value: 'sonnet', options: ['default', 'sonnet', 'opus', 'haiku', 'fable', 'best', 'fable[1m]', 'opusplan'] }])
    expect(a.models.fable).toBe('fable')
    expect(availableFrom([{ key: 'model', label: 'Model', kind: 'choice', value: 'sonnet', options: ['sonnet', 'fable[1m]'] }]).models.fable).toBeUndefined()
  })

  test('a full id names its family, and Fable is above Opus in the ordering', () => {
    expect(familyOf('claude-fable-5-1')).toBe('fable')
    expect(FAMILIES.indexOf('fable')).toBeGreaterThan(FAMILIES.indexOf('opus'))
  })

  test('a bigger tier is never rated below a smaller one, Fable included', () => {
    const out = monotonic({ opus: { high: 0.6 }, fable: { high: 0.4 }, sonnet: { high: 0.8 } })
    expect(out.fable!.high).toBe(0.8)
    expect(out.opus!.high).toBe(0.8)
  })

  test('with no known price Fable costs last: Opus runs when it is feasible, Fable only when nothing cheaper is', () => {
    const cost = (family: string) => ({ usd: family === 'fable' ? undefined : 1, rank: undefined })
    const both = decide('r', { opus: { high: 0.9 }, fable: { high: 0.95 } }, ['opus', 'fable'] as never, cost as never, 0.6, 0)
    expect(both.family).toBe('opus')
    const only = decide('r', { opus: { high: 0.3 }, fable: { high: 0.9 } }, ['opus', 'fable'] as never, cost as never, 0.6, 0)
    expect(only.family).toBe('fable')
  })
})

describe('Jev decides how to escalate', () => {
  const ESC = { ...ON, escalation: 'on', fable_routing: true }
  const FABLE = 'claude-fable-test-id'
  const WITH_FABLE = { caps: { ...CAPS, families: { ...CAPS.families, fable: { id: FABLE, ok: true, effort: true, at: '' } } } }

  const tools = (on: On) => {
    on('tool.call', async (_$, e) => ({ isError: String((e as { command?: unknown }).command ?? '').startsWith('fail') ? true : undefined, result: 'x' }) as never)
  }
  const trouble = async ($: Engine) => {
    for (const command of ['fail one', 'fail two', 'fail three']) await $.tool.call({ tool: 'Bash', command } as never)
  }
  // Jev's answer to the trouble question, or an error; the rest as for routing.
  const jev = (change: Record<string, number> | 'broken') => (q: Record<string, unknown>) =>
    'change' in q
      ? change === 'broken'
        ? { status: 500, body: {} }
        : { status: 200, body: { model: 'jev-test-1', answers: { change: { type: 'choice', choice: Object.keys(change)[0], probabilities: change, confidence: 0.8 } }, usage: { input_tokens: 300, output_tokens: 5 } } }
      : answers({ 'opus::medium': 0.9 })(q)
  const sent = (seen: Seen[]) => seen.map(s => `${s.model}/${String(s.effort)}`)
  const asked = (w: World) => w.fetches.map(f => JSON.parse(f.body)).find(b => b.questions && 'change' in b.questions)
  const run = async ($: Engine, on: On, change: Record<string, number> | 'broken', store: object = { caps: CAPS }) => {
    mock.clock(on)
    mock.store(on, store)
    const w = world(on, jev(change))
    const seen = bottom(on)
    tools(on)
    await turn($, w)
    await step($, 't1', 0)
    await trouble($)
    await step($, 't1', 1)
    await step($, 't1', 2)
    return { w, seen }
  }

  test('Jev says the model lacked thoroughness: the effort goes up', { options: ESC }, async ($, on) => {
    const { w, seen } = await run($, on, { more_effort: 0.7, larger_model: 0.2, no_change: 0.1 }, WITH_FABLE)
    expect(sent(seen)).toEqual([`${OPUS}/medium`, `${OPUS}/high`, `${OPUS}/high`])
    expect(steps(w).map(s => s.escalation).find(Boolean)).toMatchObject({ trigger: 'failures', by: 'jev', kind: 'effort', jev: { choice: 'more_effort' }, live: true })
  })

  test('Jev says the model tried and was still wrong: the next larger model runs', { options: ESC }, async ($, on) => {
    const { w, seen } = await run($, on, { larger_model: 0.8, more_effort: 0.1, no_change: 0.1 }, WITH_FABLE)
    expect(sent(seen)).toEqual([`${OPUS}/medium`, `${FABLE}/high`, `${FABLE}/high`])
    expect(steps(w).map(s => s.escalation).find(Boolean)).toMatchObject({ by: 'jev', kind: 'model', jev: { choice: 'larger_model' } })
  })

  test('Jev says the failures are ordinary: nothing changes', { options: ESC }, async ($, on) => {
    const { w, seen } = await run($, on, { no_change: 0.8, more_effort: 0.1, larger_model: 0.1 }, WITH_FABLE)
    expect(sent(seen)).toEqual([`${OPUS}/medium`, `${OPUS}/medium`, `${OPUS}/medium`])
    expect(steps(w).map(s => s.escalation).find(Boolean)).toMatchObject({ by: 'jev', kind: 'none', jev: { choice: 'no_change' } })
  })

  test('without an answer from Jev the cheaper rung, more effort, is taken', { options: ESC }, async ($, on) => {
    const { w, seen } = await run($, on, 'broken')
    expect(sent(seen)).toEqual([`${OPUS}/medium`, `${OPUS}/high`, `${OPUS}/high`])
    expect(steps(w).map(s => s.escalation).find(Boolean)).toMatchObject({ by: 'fallback', kind: 'effort' })
  })

  test('Jev is told the request, the counts and Anthropic\'s diagnosis, and offered only the options that exist', { options: ESC }, async ($, on) => {
    const { w } = await run($, on, { more_effort: 0.6, no_change: 0.4 })
    const body = asked(w)
    expect(body.state.request).toBe(PROMPT)
    expect(body.state.escalation).toMatchObject({ trigger: 'failures', failed_calls_in_a_row: 3, current: { effort: 'medium' } })
    expect(body.questions.change.instructions).toContain('clearly tried but was still wrong')
    expect(body.questions.change.instructions).toContain('did not try hard enough')
    // No larger model is known here, so it is not offered.
    expect(Object.keys(body.questions.change.criteria)).toEqual(['no_change', 'more_effort'])
  })

  test('with a larger model known, all three options are offered', { options: ESC }, async ($, on) => {
    const { w } = await run($, on, { more_effort: 0.6, no_change: 0.4 }, WITH_FABLE)
    expect(Object.keys(asked(w).questions.change.criteria)).toEqual(['no_change', 'more_effort', 'larger_model'])
  })

  test('dry-run asks Jev too, and records the answer without switching', { options: { ...ESC, escalation: 'dry-run' } }, async ($, on) => {
    const { w, seen } = await run($, on, { larger_model: 0.8, more_effort: 0.1, no_change: 0.1 }, WITH_FABLE)
    expect(sent(seen)).toEqual([`${OPUS}/medium`, `${OPUS}/medium`, `${OPUS}/medium`])
    expect(steps(w).map(s => s.escalation).find(Boolean)).toMatchObject({ by: 'jev', jev: { choice: 'larger_model' }, live: false })
  })

  test('what Jev is sent about the work follows the switches: no code with sharing off', { options: { ...ESC, jev_context_enabled: false } }, async ($, on) => {
    const { w } = await run($, on, { more_effort: 0.6, no_change: 0.4 })
    expect(asked(w).state.escalation.work).toBeUndefined()
  })
})

describe('what the log showed', () => {
  const FABLE = 'claude-fable-test-id'
  const ALL = { version: '9.9.9', families: { haiku: { id: HAIKU, ok: true, effort: true, at: '' }, sonnet: { id: SONNET, ok: true, effort: true, at: '' }, opus: { id: OPUS, ok: true, effort: true, at: '' } }, retryOk: true }
  const WITH_FABLE = { ...ALL, families: { ...ALL.families, fable: { id: FABLE, ok: true, effort: true, at: '' } } }
  const feasibleIds = (w: World) => Object.keys(JSON.parse(w.fetches[0]!.body).questions).filter(id => id.startsWith('feasible::'))

  test('an effort never costs less than a lower one, whatever the medians say', () => {
    const many = (tokens: number, n = 40) => Array.from({ length: n }, () => tokens)
    const stats = { low: many(386), medium: many(1226), high: many(1205), xhigh: many(1187), max: many(2117) }
    expect(outputEstimate(stats, 'low').tokens).toBe(386)
    expect(outputEstimate(stats, 'medium').tokens).toBe(1226)
    expect(outputEstimate(stats, 'high').tokens).toBe(1226)
    expect(outputEstimate(stats, 'xhigh').tokens).toBe(1226)
    expect(outputEstimate(stats, 'max').tokens).toBe(2117)
    // An effort without enough samples of its own is left to the pooled median.
    expect(outputEstimate({ medium: many(1226), xhigh: many(300, 4) }, 'xhigh').basis).toBe('pooled')
  })

  test('so xhigh no longer wins as the "cheapest" pair when medium is able', () => {
    const flat = (family: string, effort: string) => ({ usd: effort === 'medium' || effort === 'high' || effort === 'xhigh' ? 0.2 : 0.3, rank: undefined })
    const d = decide('r', { sonnet: { low: 0.5, medium: 0.7, high: 0.69, xhigh: 0.71, max: 0.72 } }, ['sonnet'] as never, flat as never, 0.6, 0.03)
    expect(d.effort).toBe('medium')
  })

  test('Fable is not asked about unless Route to Fable is on, even when it is listed and learned', { options: { ...ON, skill_routing: false } }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps: WITH_FABLE })
    const w = world(on, answers())
    await turn($, w)
    expect(feasibleIds(w).some(id => id.includes('::fable::'))).toBe(false)
    expect(feasibleIds(w).some(id => id.includes('::opus::'))).toBe(true)
  })

  test('with Route to Fable on, it is asked about like the other tiers', { options: { ...ON, skill_routing: false, fable_routing: true } }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps: WITH_FABLE })
    const w = world(on, answers())
    await turn($, w)
    expect(feasibleIds(w).filter(id => id.includes('::fable::'))).toHaveLength(5)
  })

  test('Fable is not probed while it is off, so no message waits for it', { options: { ...ON, skill_routing: false } }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps: ALL })
    const aliases: string[] = []
    on('agent.spawn', async (_, e) => { aliases.push(String(e.model)); return { model: FABLE } as never })
    const w = world(on, answers())
    await turn($, w)
    expect(aliases).toEqual([])
    expect(w.fetches.length).toBeGreaterThan(0)
  })

  test('a family probed lately that taught nothing is not probed again for a day, when others are routable', { options: { ...ON, skill_routing: false, fable_routing: true } }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps: ALL, 'probe-tried': { fable: 0 } })
    const aliases: string[] = []
    on('agent.spawn', async (_, e) => { aliases.push(String(e.model)); return { model: FABLE } as never })
    const w = world(on, answers())
    await turn($, w)
    expect(aliases).toEqual([])
    expect(w.fetches.length).toBeGreaterThan(0)
  })

  test('the first probe is remembered, so the next session does not repeat it', { options: { ...ON, skill_routing: false, fable_routing: true } }, async ($, on) => {
    mock.clock(on)
    const saved = memoryStore(on, { caps: ALL, advanced: { probe_wait_ms: 0 } })
    const aliases: string[] = []
    on('agent.spawn', async (_, e) => { aliases.push(String(e.model)); return { model: FABLE } as never })
    const w = world(on, answers())
    await turn($, w)
    expect(aliases).toEqual(['fable'])
    expect(saved['probe-tried']).toMatchObject({ fable: expect.any(Number) })
  })
})
