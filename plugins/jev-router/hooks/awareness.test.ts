import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { STATE_CHAR_BUDGET, recentContext, routingFacts, scrubText, type MessageLike } from './awareness'
import { cacheEvidence, observeUsage, withContext } from './cache'
import { sharedConfig } from './settings'
import { rankWideBody, route } from './router'
import { FAKE_KEY, logLines, memoryStore, rankWide, rerank, world, type World } from './testkit'
import { learn, noteContext, type Caps } from './model'
import { horizonFor, learnOutput, normalizeStats, outputEstimate, outputSummary, pairCost } from './cost'

const SONNET = 'claude-sonnet-4-6'
const OPUS = 'claude-opus-4-6'
const HAIKU = 'claude-haiku-4-5-20251001'
const config = sharedConfig({})
const caps: Caps = { version: '9.9.9', families: { sonnet: { id: SONNET, ok: true, effort: true, at: '' }, opus: { id: OPUS, ok: true, effort: true, at: '' }, haiku: { id: HAIKU, ok: true, effort: true, at: '' } }, retryOk: true }
const failed = new Set<never>()
const usage = (model: string) => ({ model, input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 99000, cache_creation_input_tokens: 0 })
const hot = (model = SONNET, effort = 'high') => withContext(observeUsage({}, usage(model), { model, effort }, 0), 100000)

describe('bounded task context', () => {
  test('follow-up evidence excludes the current prompt, tools, subagents and code/skill bodies', () => {
    const messages: MessageLike[] = [
      { role: 'user', text: 'Fix concurrency in the payment ledger.' },
      { role: 'assistant', text: 'We need a transactional lock. ```secret code``` <skill_instructions name="x">private skill body</skill_instructions>' },
      { role: 'tool', text: 'private tool body' },
      { role: 'assistant', text: 'private agent text', agentId: 'a' },
      { role: 'user', text: 'private tool result', toolResults: [{}] },
      { role: 'assistant', text: 'private tool call', toolUses: [{}] },
      { role: 'user', text: '/jev-model settings' },
      { role: 'assistant', text: 'jev-router: answered by sonnet' },
      { role: 'user', text: 'Apply that fix.' },
    ]
    const recent = recentContext(messages, 'Apply that fix.', config.awareness)
    expect(recent.text).toContain('payment ledger')
    expect(recent.text).toContain('transactional lock')
    expect(recent.messages).toBe(2)
    for (const sensitive of ['Apply that fix.', 'secret code', 'private skill body', 'private tool body', 'private agent text', 'private tool result', 'private tool call']) expect(recent.text.includes(sensitive)).toBe(false)
  })
  test('budget is bounded and credentials are removed before truncation', () => {
    const secret = 'my-private-key-value'
    const recent = recentContext([{ role: 'user', text: `Goal ${secret} password=hidden sk-ant-secret12345678 ${'x'.repeat(2000)}` }], 'Continue', { ...config.awareness, maxChars: 120 }, [secret])
    expect(recent.text.length <= 120).toBe(true)
    expect(recent.truncated).toBe(true)
    for (const sensitive of [secret, 'hidden', 'sk-ant-secret12345678']) expect(recent.text.includes(sensitive)).toBe(false)
    expect(scrubText('Authorization: Bearer secret123456789')).toContain('[redacted]')
  })
  test('short messages keep all of theirs and the long one takes the rest of the budget, keeping its start and its end', () => {
    const long = `START ${'middle '.repeat(3000)} CONCLUSION: use the lock`
    const messages: MessageLike[] = [{ role: 'user', text: 'First short question.' }, { role: 'assistant', text: long }, { role: 'user', text: 'Second short question.' }]
    const recent = recentContext(messages, 'Continue', { ...config.awareness, maxChars: 1000, messages: 10 })
    expect(recent.text.length).toBeLessThanOrEqual(1000)
    expect(recent.text.length).toBeGreaterThan(950)
    expect(recent.text).toContain('user: First short question.')
    expect(recent.text).toContain('user: Second short question.')
    expect(recent.text).toContain('assistant: START')
    expect(recent.text).toContain('CONCLUSION: use the lock')
    expect(recent.text).toContain(' … ')
    expect(recent.truncated).toBe(true)
  })
  test('what fits is sent whole: no ellipsis and nothing marked truncated', () => {
    const recent = recentContext([{ role: 'user', text: 'Fix the ledger.' }, { role: 'assistant', text: 'Added a lock.' }], 'Continue', { ...config.awareness, maxChars: 1000, messages: 10 })
    expect(recent.text).toBe('user: Fix the ledger.\nassistant: Added a lock.')
    expect(recent.truncated).toBe(false)
  })
  test('the conversation sent to Jev defaults to a large share of what Jev takes', () => {
    expect(config.awareness).toEqual({ enabled: true, maxChars: 12000, messages: 16 })
    expect(STATE_CHAR_BUDGET).toBe(24000)
  })
  test('disabled or unavailable context has no invented summary', () => {
    expect(recentContext(undefined, 'Continue', config.awareness).source).toBe('unavailable')
    expect(recentContext([{ role: 'user', text: 'old task' }], 'Continue', { ...config.awareness, enabled: false })).toEqual({ text: '', messages: 0, source: 'disabled', truncated: false })
  })
  test('Jev is given the facts for judging ability, and no costs: the router costs each pair itself', () => {
    const facts = routingFacts(hot(), { model: SONNET, effort: 'high' }, caps, failed, { modelRequestFailed: true, toolFailures: 2, deniedTools: 0, correctness: 'unknown' }, 100, config.cache)
    expect(facts.current_configuration).toEqual({ model: SONNET, source: 'last-response', requested_effort: 'high' })
    expect(facts.previous_attempt?.toolFailures).toBe(2)
    expect(facts.answer_correctness_verified).toBe('unknown')
    expect('model_costs' in facts).toBe(false)
    const unknown = routingFacts({}, undefined, caps, failed, undefined, 0, config.cache)
    expect(unknown.context.conversation_tokens).toBe(null)
    expect(unknown.current_configuration).toBe(null)
  })
})

describe('context capacity facts for Jev', () => {
  test('the largest context a model answered over grows, never shrinks, and only for its own id', () => {
    const grown = noteContext(caps, SONNET, 100000)!
    expect(grown.families.sonnet?.maxContext).toBe(100000)
    expect(noteContext(grown, SONNET, 50000)).toBeUndefined()
    expect(noteContext(grown, 'claude-sonnet-other-id', 900000)).toBeUndefined()
    expect(noteContext(grown, 'sonnet', 900000)).toBeUndefined()
  })
  test('learning an id again keeps what was seen of its context', () => {
    const grown = noteContext(caps, SONNET, 100000)!
    const relearned = learn({ ...grown, families: { ...grown.families, sonnet: { ...grown.families.sonnet!, ok: false } } }, { model: SONNET, effort: 'high' }, true, 'main-step', '')!
    expect(relearned.families.sonnet?.maxContext).toBe(100000)
  })
  test('Jev is told the conversation size and what each tier is known to hold, with unknowns as null', () => {
    const facts = routingFacts(hot(), { model: SONNET, effort: 'high' }, noteContext(caps, SONNET, 100000), failed, undefined, 100, config.cache, { sonnet: 1000000 })
    expect(facts.context.conversation_tokens).toBe(100000)
    expect(facts.context.per_tier.sonnet).toEqual({ largest_context_answered: 100000, context_window_reported: 1000000, failed_this_session: false })
    expect(facts.context.per_tier.haiku).toEqual({ largest_context_answered: null, context_window_reported: null, failed_this_session: false })
  })
})

const H55 = 'claude-haiku-5-5', S55 = 'claude-sonnet-5-5', O55 = 'claude-opus-5-5'
const caps55: Caps = { version: '9.9.9', families: { haiku: { id: H55, ok: true, effort: true, at: '' }, sonnet: { id: S55, ok: true, effort: true, at: '' }, opus: { id: O55, ok: true, effort: true, at: '' } }, retryOk: true }
const cost5 = { horizon: 5 }
// 865k tokens of conversation, first seen after a reload: cache state unknown.
const reloaded = (subscription = false) => cacheEvidence(withContext({}, 865000), 0, { ...config.cache, subscription })
const onOpusHigh = { model: O55, effort: 'high' }
// Ten requests at high effort, 2000 output tokens each: high has its own median; every other effort shares it.
const seenHigh = { high: Array<number>(10).fill(2000) }

describe('pair costs', () => {
  test('a conversation first seen mid-way (a plugin reload) has an unknown cache, not a cold one', () => {
    expect(reloaded().status).toBe('unknown')
    expect(cacheEvidence(withContext({}, undefined), 0, config.cache).status).toBe('cold')
  })
  test('staying reads the cache back, a model switch rebuilds it, and an effort change does not', () => {
    // Staying: 5 cached reads of 865k on Opus 5.5, plus 5 x 2000 output tokens at the effort's own median.
    expect(pairCost(O55, 'high', onOpusHigh, reloaded(), seenHigh, cost5)).toEqual({ usd: 1.065, context_usd: 0.865, output_usd: 0.2, output_tokens: 2000, output_basis: 'own', stays: true, rank: 20 })
    // Same model, other effort: the cache is kept and the pooled median stands in, so the cost is the same.
    expect(pairCost(O55, 'low', onOpusHigh, reloaded(), seenHigh, cost5)).toEqual({ usd: 1.065, context_usd: 0.865, output_usd: 0.2, output_tokens: 2000, output_basis: 'pooled', stays: true, rank: 20 })
    // Another model: its whole context is written once. Haiku 5.5 above 100k is priced at its long-context rate.
    expect(pairCost(H55, 'low', onOpusHigh, reloaded(), seenHigh, cost5)).toMatchObject({ stays: false, context_usd: 0.713625, output_usd: 0.025, usd: 0.738625 })
    expect(pairCost(S55, 'high', onOpusHigh, reloaded(), seenHigh, cost5).usd).toBe(2.6085)
  })
  test('on a subscription the cache lasts an hour, and a rebuild is written at the hour rate', () => {
    expect(reloaded(true).ttlSource).toBe('subscription-1h')
    expect(pairCost(H55, 'low', onOpusHigh, reloaded(true), {}, cost5).context_usd).toBe(1.038)
    expect(pairCost(O55, 'medium', onOpusHigh, reloaded(true), {}, cost5).context_usd).toBe(0.865)
  })
  test('unknowns stay unknown: no id, no price, no context, too little output', () => {
    expect(pairCost(undefined, 'low', onOpusHigh, reloaded(), seenHigh, cost5)).toEqual({ stays: false, output_basis: 'none' })
    expect(pairCost('claude-opus-future', 'low', onOpusHigh, reloaded(), seenHigh, cost5).usd).toBeUndefined()
    expect(pairCost(O55, 'low', onOpusHigh, cacheEvidence({}, 0, config.cache), seenHigh, cost5).usd).toBeUndefined()
    const noOutput = pairCost(O55, 'high', onOpusHigh, reloaded(), {}, cost5)
    expect([noOutput.usd, noOutput.output_usd, noOutput.output_basis]).toEqual([0.865, undefined, 'none'])
  })
  test('output samples are kept, the median resists outliers, and an effort needs enough samples of its own', () => {
    let stats = learnOutput({}, 'high', 100)!
    expect(learnOutput(stats, 'turbo', 100)).toBeUndefined()
    expect(learnOutput(stats, 'high', -1)).toBeUndefined()
    expect(learnOutput(stats, 'max', 300)).toEqual({ high: [100], max: [300] })
    // Fewer than three samples overall: no output is assumed.
    expect(outputEstimate(stats, 'high')).toEqual({ basis: 'none' })
    for (const n of [120, 8000]) stats = learnOutput(stats, 'high', n)!
    // Three samples: the pooled median, whatever the effort, and the outlier does not drag it.
    expect(outputEstimate(stats, 'low')).toEqual({ tokens: 120, basis: 'pooled' })
    for (let i = 0; i < 7; i++) stats = learnOutput(stats, 'high', 110)!
    // Ten at high: high has its own median; low still shares the pooled one.
    expect(outputEstimate(stats, 'high')).toEqual({ tokens: 110, basis: 'own' })
    expect(outputEstimate(stats, 'low').basis).toBe('pooled')
    // Only the latest 40 are kept.
    for (let i = 0; i < 60; i++) stats = learnOutput(stats, 'high', i)!
    expect(stats.high).toHaveLength(40)
    expect(outputSummary({ high: [1, 3, 2] })).toEqual({ high: { n: 3, median: 2 } })
  })
  test('what $.store holds is read as samples; an older shape is dropped', () => {
    expect(normalizeStats({ high: [1, 'x', 3], medium: { avg: 100, n: 1 }, low: 'no' })).toEqual({ high: [1, 3] })
    expect(normalizeStats(undefined)).toEqual({})
  })
  test('requests per turn: the setting, else the median of recent turns once three are seen, else 5', () => {
    expect(horizonFor(8, [2, 2, 2])).toEqual({ horizon: 8, source: 'setting' })
    expect(horizonFor(0, [2, 30])).toEqual({ horizon: 5, source: 'default' })
    expect(horizonFor(0, [3, 52, 5, 9])).toEqual({ horizon: 7, source: 'learned' })
    expect(horizonFor(0, [500, 500, 500]).horizon).toBe(100)
  })
})

const options = { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'on' }
// Jev's feasibility per 'tier::effort'; every other pair asked is judged unable.
const answer = (feasible: Record<string, number> = {}) => (questions: Record<string, unknown>) => {
  const body: any = 'catalog_has_match' in questions ? rankWide(0.9, 'speckit-specify', feasible, questions) : rerank(questions, { 'speckit-specify': 0.9 })
  return { status: 200, body }
}
const begin = async ($: Engine, id: string, text = 'Apply that fix.') => {
  await $.prompt.submit({ text, asUser: true })
  await $.turn.start({ text, turnId: id })
}
const step = async ($: Engine, id: string, index = 0) => {
  const stream = $.turn.step({ turnId: id, index, model: SONNET, effort: 'medium', messageCount: 4 } as never)
  let item = await stream.next()
  while (!item.done) item = await stream.next()
  return item.value
}
const bottom = (on: On, w: World) => {
  const sent: { model: string; effort?: unknown }[] = []
  on('turn.step', async function* ($, e) {
    sent.push({ model: e.model, effort: e.effort })
    w.contextTokens = 100000
    return { turnId: e.turnId, index: e.index, answer: 'OK', toolUses: [], stopReason: 'end_turn', usage: usage(e.model) } as never
  })
  return sent
}
const last = (w: World) => logLines(w).filter(l => l.type === 'step').at(-1)

describe('awareness engine integration', () => {
  test('recent task context and ability facts reach Jev; logs keep neither text nor key', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps })
    const w = world(on, answer({ 'sonnet::medium': 0.9 })); bottom(on, w)
    w.messages = [{ role: 'user', text: `Fix private-ledger-goal ${FAKE_KEY}` }, { role: 'assistant', text: 'The transaction race needs a lock.' }]
    await begin($, 'a')
    expect(w.fetches.length).toBe(2)
    const wide = JSON.parse(w.fetches[0]!.body), reranked = JSON.parse(w.fetches[1]!.body)
    expect(wide.state.recent_context).toContain('private-ledger-goal')
    expect(reranked.state.recent_context).toBe(wide.state.recent_context)
    expect(wide.state.recent_context.includes(FAKE_KEY)).toBe(false)
    expect(wide.questions['feasible::haiku::low'].type).toBe('noul')
    expect(wide.state.routing_context.context).toBeDefined()
    expect(wide.state.routing_context.model_costs).toBeUndefined()
    const logs = [...w.written.values()].join('\n')
    expect(logs.includes('private-ledger-goal')).toBe(false)
    expect(logs.includes(FAKE_KEY)).toBe(false)
    expect(w.seen?.context?.join('\n')).toContain('speckit-specify')
  })
  test('after a response, the next Jev request carries the context that model answered over and the session window', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps })
    const w = world(on, answer({ 'sonnet::medium': 0.9 })); bottom(on, w)
    w.window = 1000000; w.sessionModel = SONNET
    await begin($, 'a'); await step($, 'a')
    await begin($, 'b')
    const body = JSON.parse(w.fetches[2]!.body)
    const context = body.state.routing_context.context
    expect(context.conversation_tokens).toBe(100000)
    expect(context.per_tier.sonnet.largest_context_answered).toBe(100000)
    expect(context.per_tier.sonnet.context_window_reported).toBe(1000000)
    expect(context.per_tier.haiku.context_window_reported).toBe(null)
    expect(body.questions['feasible::haiku::low'].instructions).toContain('routing_context.context')
  })
  test('a long prompt and a long conversation together stay inside the state budget Jev can take', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps, advanced: { max_prompt_chars: 20000, jev_context_chars: 20000, jev_context_messages: 40 } })
    const w = world(on, answer({ 'sonnet::medium': 0.9 })); bottom(on, w)
    w.messages = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i} ${'detail '.repeat(800)}` }))
    await begin($, 'a', 'Q'.repeat(30000))
    const state = JSON.parse(w.fetches[0]!.body).state
    expect(state.request.length).toBeLessThanOrEqual(21000)
    expect(state.request.length + state.recent_context.length).toBeLessThanOrEqual(24000 - 3000)
    expect(state.recent_context.length).toBeGreaterThan(0)
  })
  test('with a short prompt the excerpts can use a big share', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps })
    const w = world(on, answer({ 'sonnet::medium': 0.9 })); bottom(on, w)
    w.messages = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i} ${'detail '.repeat(800)}` }))
    await begin($, 'a')
    const state = JSON.parse(w.fetches[0]!.body).state
    expect(state.recent_context.length).toBeGreaterThan(11500)
    expect(state.recent_context.length).toBeLessThanOrEqual(12000)
    expect(state.recent_context.split('\n').length).toBe(16)
  })
  test('history sharing can be disabled without reading session messages', { options: { ...options, jev_context_enabled: false } }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps })
    const w = world(on, answer({ 'sonnet::medium': 0.9 }))
    w.messages = [{ role: 'user', text: 'must not be shared' }]
    await begin($, 'a')
    expect(w.messageReads).toBe(0)
    expect(JSON.parse(w.fetches[0]!.body).state.recent_context).toBe('')
  })
  test('the cheapest feasible pair runs: on a subscription, staying on a big warm Opus beats rebuilding it on Haiku', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps: caps55, advanced: { tier_monotonic: false } })
    const w = world(on, answer({ 'haiku::low': 0.7, 'sonnet::high': 0.9, 'opus::high': 0.9 })), sent = bottom(on, w)
    w.contextTokens = 865000
    await begin($, 'a'); await step($, 'a'); await step($, 'a', 1)
    // The session model (opus) stands in for the current one; an effort change
    // keeps its cache, so all three opus efforts cost the same context.
    expect(sent.map(s => `${s.model}/${s.effort}`)).toEqual([`${O55}/high`, `${O55}/high`])
    const round = logLines(w).find(l => l.type === 'round')!
    expect(round.decision).toEqual({ family: 'opus', effort: 'high', how: 'cheapest-feasible', usd: 0.865, threshold: 0.6 })
    expect(round.cost_basis).toEqual({ context_tokens: 865000, cache: 'unknown', ttl: 'subscription-1h', horizon: 5, horizon_source: 'default', tolerance: 0.03, outputs: {} })
    expect(round.candidates.slice(0, 2).map((c: any) => [c.pair, c.usd])).toEqual([['opus/low', 0.865], ['opus/medium', 0.865]])
    expect(round.candidates.find((c: any) => c.pair === 'haiku/low').usd).toBe(1.038)
    expect(w.fetches.length).toBe(2)
  })
  test('output per effort is learned from responses, kept across sessions, and costed in the next round', { options }, async ($, on) => {
    mock.clock(on); const saved = memoryStore(on, { caps })
    const w = world(on, answer({ 'sonnet::medium': 0.9 })); bottom(on, w)
    await begin($, 'a'); await step($, 'a')
    expect(saved.outputs).toEqual({ medium: [100] })
    await begin($, 'b')
    let round = logLines(w).filter(l => l.type === 'round').at(-1)!
    expect(round.cost_basis.outputs).toEqual({ medium: { n: 1, median: 100 } })
    // One sample is too few to assume anything: no output is costed yet.
    expect(round.candidates.find((c: any) => c.pair === 'opus/high').output_basis).toBe('none')
    // Three samples: the pooled median stands for every effort.
    await step($, 'b', 0); await step($, 'b', 1)
    await begin($, 'c')
    round = logLines(w).filter(l => l.type === 'round').at(-1)!
    expect(round.candidates.find((c: any) => c.pair === 'opus/high')).toMatchObject({ output_tokens: 100, output_basis: 'pooled' })
  })
  test('the cost horizon follows the requests per turn of recent turns, kept across sessions', { options }, async ($, on) => {
    mock.clock(on); const saved = memoryStore(on, { caps })
    const w = world(on, answer({ 'sonnet::medium': 0.9 })); bottom(on, w)
    on('turn.complete', () => ({ text: '' } as never))
    for (const id of ['a', 'b', 'c']) {
      await begin($, id); await step($, id, 0); await step($, id, 1)
      await $.turn.complete({ turnId: id, answer: 'OK', durationMs: 1, isAborted: false, usage: usage(SONNET) } as never)
    }
    expect(saved.turnlen).toEqual([2, 2, 2])
    await begin($, 'd')
    expect(logLines(w).filter(l => l.type === 'round').at(-1)?.cost_basis).toMatchObject({ horizon: 2, horizon_source: 'learned' })
  })
  test('Feasible pairs costing within the tolerance of the cheapest compete on feasibility: effort follows Jev, not the cheapest', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps: caps55 })
    const w = world(on, answer({ 'opus::low': 0.65, 'opus::high': 0.9 })), sent = bottom(on, w)
    w.contextTokens = 865000
    await begin($, 'a'); await step($, 'a')
    // low and high cost the same (the cache is kept); high is likelier to do the work.
    expect(sent[0]).toEqual({ model: O55, effort: 'high' })
    expect(logLines(w).find(l => l.type === 'round')?.decision).toMatchObject({ family: 'opus', effort: 'high', how: 'most-feasible-within-tolerance' })
  })
  test('with tolerance 0 the cheapest feasible pair runs', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps: caps55, advanced: { cost_tolerance: 0 } })
    const w = world(on, answer({ 'opus::low': 0.65, 'opus::high': 0.9 })), sent = bottom(on, w)
    w.contextTokens = 865000
    await begin($, 'a'); await step($, 'a')
    expect(sent[0]).toEqual({ model: O55, effort: 'low' })
    expect(logLines(w).find(l => l.type === 'round')?.decision.how).toBe('cheapest-feasible')
  })
  test('tool failure evidence is aggregate and not a claim of an incorrect answer; subagent failures are ignored', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps })
    const w = world(on, answer({ 'sonnet::medium': 0.9 })); bottom(on, w)
    on('tool.call', () => ({ result: 'secret tool output', isError: true } as never))
    on('turn.complete', () => ({ text: '' } as never))
    await begin($, 'a'); await step($, 'a')
    await $.tool.call({ tool: 'Skill', skill: 'speckit-specify' } as never)
    await $.tool.call({ tool: 'Skill', skill: 'speckit-specify', agentId: 'sub' } as never)
    await $.turn.complete({ turnId: 'a', answer: 'OK', durationMs: 1, isAborted: false, usage: usage(SONNET) } as never)
    await begin($, 'b')
    const facts = JSON.parse(w.fetches[2]!.body).state.routing_context.previous_attempt
    expect(facts.toolFailures).toBe(1)
    expect(facts.correctness).toBe('unknown')
    expect(w.fetches[2]!.body.includes('secret tool output')).toBe(false)
    expect([...w.written.values()].join('\n').includes('secret tool output')).toBe(false)
  })
  test('a changed session uses its own live excerpts and resets previous attempts', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps })
    const w = world(on, answer({ 'sonnet::medium': 0.9 })); bottom(on, w)
    w.messages = [{ role: 'user', text: 'old-session-secret-goal' }]
    await begin($, 'a'); await step($, 'a')
    w.sessionId = 'new'; w.messages = [{ role: 'user', text: 'new-session-goal' }]
    await begin($, 'b')
    const body = JSON.parse(w.fetches[2]!.body)
    expect(body.state.recent_context).toContain('new-session-goal')
    expect(body.state.recent_context.includes('old-session-secret-goal')).toBe(false)
    expect(body.state.routing_context.previous_attempt).toBe(null)
  })
  test('dry-run records the cost-sorted pick without changing requests', { options: { ...options, model_routing: 'dry-run' } }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps, advanced: { tier_monotonic: false } })
    const w = world(on, answer({ 'haiku::high': 0.3, 'sonnet::low': 0.5, 'opus::high': 0.9 })), sent = bottom(on, w)
    await begin($, 'a'); await step($, 'a')
    expect(sent).toEqual([{ model: SONNET, effort: 'medium' }])
    expect(last(w)?.final_recommended.model).toBe(OPUS)
    expect(last(w)?.jev_feasible.opus).toEqual({ low: 0.1, medium: 0.1, high: 0.9, xhigh: 0.1, max: 0.1 })
  })
  test('settings kept off the page persist in $.store and defaults restores them', { options }, async ($, on) => {
    mock.clock(on); const saved = memoryStore(on, { caps })
    const w = world(on, answer({ 'sonnet::medium': 0.9 }))
    await $.command.run({ command: 'jev-model', args: 'set jev_context_chars 500' })
    await $.command.run({ command: 'jev-model', args: 'set model_haiku My small work' })
    expect(saved.advanced).toEqual({ jev_context_chars: 500, model_haiku: 'My small work' })
    await begin($, 'a')
    expect(JSON.parse(w.fetches[0]!.body).questions['feasible::haiku::low'].instructions).toContain('My small work')
    expect(w.configRows.find(r => r.key.endsWith('.model_haiku'))).toBeUndefined()
    await $.command.run({ command: 'jev-model', args: 'defaults' })
    expect(saved.advanced).toBeUndefined()
  })
})

describe('Jev response schema', () => {
  test('feasibility rides rank_wide; skill rerank keeps bounded task context and asks no model questions', async () => {
    const routeConfig = { model: 'jev-latest', gateThreshold: 0.3, fitsThreshold: 0.3, shortlist: 3, modelFamilies: ['haiku', 'sonnet', 'opus'], recentContext: 'user: Fix the payment race.' }
    const bodies: any[] = []
    const response = answer({ 'haiku::low': 0.2, 'sonnet::medium': 0.9, 'opus::high': 0.95 })
    const result = await route('Apply that fix.', [{ name: 'speckit-specify', description: 'Write a spec' }], routeConfig, async body => {
      const parsed = JSON.parse(body); bodies.push(parsed)
      const res = response(parsed.questions)
      return { status: res.status, text: JSON.stringify(res.body) }
    }, async () => 0)
    expect(bodies.length).toBe(2)
    // Sonnet is never below Haiku (0.2 at low); Jev's own ratings are kept beside.
    expect(result.feasible?.sonnet).toEqual({ low: 0.2, medium: 0.9, high: 0.1, xhigh: 0.1, max: 0.1 })
    expect(result.feasibleRaw?.sonnet).toEqual({ low: 0.1, medium: 0.9, high: 0.1, xhigh: 0.1, max: 0.1 })
    expect(bodies[1].state.recent_context).toBe(bodies[0].state.recent_context)
    expect(Object.keys(bodies[1].questions).some(k => k.startsWith('feasible::'))).toBe(false)
  })
  test('an invalid feasibility answer is dropped and does not stop Skill Selection', async () => {
    const cfg = { model: 'jev-latest', gateThreshold: 0.3, fitsThreshold: 0.3, shortlist: 3, modelFamilies: ['haiku', 'sonnet'] }
    let calls = 0
    const result = await route('Fix it.', [{ name: 'speckit-specify', description: 'Write a spec' }], cfg, async body => {
      calls++
      const questions = JSON.parse(body).questions
      const r: any = calls === 1 ? rankWide(0.9, 'speckit-specify') : rerank(questions, { 'speckit-specify': 0.9 })
      if (calls === 1) r.answers['feasible::sonnet::low'] = { type: 'noul', noul: 2 }
      return { status: 200, text: JSON.stringify(r) }
    }, async () => 0)
    expect(result.feasible).toBeUndefined()
    expect(result.outcome).toBe('selected')
    expect(calls).toBe(2)
    expect(Object.keys(rankWideBody('Fix it.', [], cfg).questions)).toEqual(['haiku', 'sonnet'].flatMap(f => ['low', 'medium', 'high', 'xhigh', 'max'].map(e => `feasible::${f}::${e}`)))
  })
})
