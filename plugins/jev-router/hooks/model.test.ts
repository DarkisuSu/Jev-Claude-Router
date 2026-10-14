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

// Jev's feasibility per 'tier::effort'; every other pair asked is judged
// unable (0.1).
const answers = (feasible: Record<string, number> = {}) =>
  (q: Record<string, unknown>) =>
    // Request 1 carries the skill gates and/or the model questions; Jev answers what is asked.
    'acts_on_user_system' in q || Object.keys(q).some(k => k.startsWith('feasible::'))
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

const ON = { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' }

const steps = (w: World) => logLines(w).filter(l => l.type === 'step')

// The session model is opus (world's default) and steps come as sonnet; opus
// and haiku are learned. No context is known here, so pairs are ordered by
// list price, then tier, then effort (unknown test ids: tier, then effort).
describe('model routing', () => {
  test('dry-run: logs what Jev would send and sends the session model unchanged', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
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

  test('Jev is asked every routable tier at every effort, apart from cost', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
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

  test('on: every main step of the turn is sent with the learned full id and effort', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
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

  test('on: the cheapest pair Jev judges feasible runs: a lower tier and a lower effort first', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
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
    expect(questions['feasible::opus::xhigh'].instructions).toContain('Deeper reasoning than high')
    expect(questions['feasible::opus::max'].instructions).toContain('most thorough reasoning')
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

  test('on: a cheaper pair below the feasibility threshold gives way to a dearer feasible one', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
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

  test('the effort descriptions Jev sees come from settings', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { ...LEARNED, advanced: { effort_low: 'my low', effort_high: 'my high' } })
    const w = world(on, answers())
    bottom(on)

    await turn($, w)

    const questions = JSON.parse(w.fetches[0]?.body ?? '{}').questions
    expect(questions['feasible::opus::low'].instructions).toContain('my low')
    expect(questions['feasible::opus::high'].instructions).toContain('my high')
    // An unset level keeps its default.
    expect(questions['feasible::opus::medium'].instructions).toContain('Moderate reasoning')
  })

  test('on: a tier whose full id has not been learned is neither asked nor sent', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
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

  test('on: a tier whose effort support is unknown is not asked about', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { caps: { ...CAPS, families: { haiku: { id: HAIKU, ok: true, at: '' } } } })
    const w = world(on, answers({ 'haiku::low': 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    expect(JSON.parse(w.fetches[0]?.body ?? '{}').questions['feasible::haiku::low']).toBeUndefined()
    expect(seen[0]?.model).toBe(SONNET)
  })

  test('on: a target known to take no effort is sent without one', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, { caps: { ...CAPS, families: { haiku: { id: HAIKU, ok: true, effort: false, at: '' } } } })
    const w = world(on, answers({ 'haiku::low': 0.9 }))
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
    const w = world(on, answers({ 'opus::high': 0.9 }))
    const seen = bottom(on)

    await turn($, w)
    await step($, 't1', 0, { agentId: 'a1', model: HAIKU })

    expect(seen[0]).toEqual({ model: HAIKU, effort: 'medium', agentId: 'a1' })
  })

  test('on: a failed routed request is resent on the session model and the model is not tried again', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers({ 'opus::high': 0.9 }))
    const seen = bottom(on, [OPUS])

    await turn($, w)
    const first = await step($, 't1', 0)
    await step($, 't1', 1)

    expect(seen.map(s => s.model)).toEqual([OPUS, SONNET, SONNET])
    expect(first.usage?.model).toBe(SONNET)
    expect(steps(w)[0]?.fallback).toContain('resent on the session model')
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
  test('a main step teaches the current family without any probe', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers({ 'opus::high': 0.9 }))
    bottom(on)

    await turn($, w)
    await step($, 't1', 0)

    const status = await $.command.run({ command: 'jev-model', args: '' })
    expect(status.text).toContain(`sonnet: ${SONNET}, seen answering, takes effort (from main-step)`)
  })

  test('probe resolves each alias through a subagent, learns from its step, and arms the resend check', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
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

  test('first use: a turn start probes each family not known yet, once per load', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers())
    bottom(on)
    const aliases = spawns(on)

    await turn($, w)
    // opus and haiku are learned; sonnet is not.
    expect(aliases).toEqual(['sonnet'])
    expect(logLines(w).find(l => l.type === 'probe' && l.kind === 'auto')?.families).toEqual(['sonnet'])
    await $.prompt.submit({ text: 'again', asUser: true })
    await $.turn.start({ text: 'again', turnId: 't2' })
    expect(aliases).toEqual(['sonnet'])
  })

  test('no automatic probe with model routing off', { options: { typesafe_api_key: FAKE_KEY, model_routing: 'off' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    const w = world(on, answers())
    bottom(on)
    const aliases = spawns(on)
    await turn($, w)
    expect(aliases).toEqual([])
  })

  test('auto_probe off is kept in $.store', { options: { typesafe_api_key: FAKE_KEY } }, async ($, on) => {
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
    expect(aliases).toEqual(['opus'])
    expect(logLines(w).find(l => l.type === 'probe' && l.kind === 'auto')?.why).toBe('a routed request to opus failed')
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
    expect(Object.keys(wideQuestions(w))).toEqual(expect.arrayContaining(['which', 'acts_on_user_system', 'feasible::opus::high']))
    expect(logLines(w).find(l => l.type === 'round')?.skill_routing).toBe(true)
  })

  test('off: no skill is asked about or suggested, and model routing carries on', { options: { ...ON, skill_routing: false } }, async ($, on) => {
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

  test('off with model routing off too: Jev is not called at all', { options: { ...ON, skill_routing: false, model_routing: 'off' } }, async ($, on) => {
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

  test('defaults turns skill selection back on', { options: { ...ON, skill_routing: false } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, LEARNED)
    const w = world(on, answers())
    bottom(on)
    await $.command.run({ command: 'jev-model', args: 'defaults' })
    expect(w.configRows.find(r => r.key.endsWith('.skill_routing'))?.value).toBe(true)
  })
})

describe('settings kept off the page', () => {
  test('set applies at once, unset restores the default, bad values change nothing', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
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

  test('an effort description keeps its case and spaces, and settings lists the change', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
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

  test('an unknown name is refused with the list', { options: { typesafe_api_key: FAKE_KEY } }, async ($, on) => {
    mock.clock(on)
    mock.store(on, {})
    world(on, answers({ 'opus::high': 0.9 }))
    const out = await $.command.run({ command: 'jev-model', args: 'set nope 1' })
    expect(out.text).toContain('unknown setting "nope"')
    expect(out.text).toContain('timeout_ms')
  })
})

describe('reset to defaults', () => {
  test('/jev-model defaults restores changed settings, keeps the API key and switches the flag off', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, answers({ 'opus::high': 0.9 }))

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

  test('a switched turn says which model answered and what Jev chose', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' } }, async ($, on) => {
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

  test('a fallback turn names the fallback', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on', fallback_model: 'haiku' } }, async ($, on) => {
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

  test('a dry-run turn says nothing was switched', { options: { typesafe_api_key: FAKE_KEY, write_log: true } }, async ($, on) => {
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
