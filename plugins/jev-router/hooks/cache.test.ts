import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { cacheEvidence, cacheAdvice, estimateSwitch, observeUsage, priceFor, resetCache, withContext, type CacheState, type UsageLike } from './cache'
import { sharedConfig, parseSetting } from './settings'
import { DEFAULT_EFFORT_LEVELS } from './questions'
import { FAKE_KEY, logLines, memoryStore, PROMPT, rankWide, rerank, world, type World } from './testkit'
import type { Plan } from './model'

const SONNET = 'claude-sonnet-4-6'
const OPUS = 'claude-opus-4-6'
const HAIKU = 'claude-haiku-4-5-20251001'
const cfg = sharedConfig({}).cache
const usage = (model = OPUS): UsageLike => ({ model, input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 99000, cache_creation_input_tokens: 0 })
const hot = (model = OPUS): CacheState => withContext(observeUsage({}, usage(model), { model, effort: 'high' }, 0), 100000)
const desired = (model: string, effort = 'high'): Plan => ({ model, effort, changed: true, reasons: [] })

describe('cache evidence and estimator', () => {
  test('cache advice has no routing output even when a switch cannot pay back', () => {
    const p = cacheAdvice({ model: OPUS, effort: 'high' }, desired(SONNET), hot(), 100, cfg)
    expect(p.mode).toBe('advisory')
    expect(p.evidence.status).toBe('hot')
    expect(p.estimate?.breakevenTurns! > cfg.breakevenTurns).toBe(true)
    expect(p.estimate?.projectedSavings! < 0).toBe(true)
    expect('model' in p).toBe(false)
    expect('effort' in p).toBe(false)
    expect('protected' in p).toBe(false)
  })
  test('a longer future horizon changes projected savings but not the recommendation', () => {
    const p = cacheAdvice({ model: OPUS, effort: 'high' }, desired(HAIKU), hot(), 100, { ...cfg, breakevenTurns: 100 })
    expect(p.estimate?.projectedSavings! > 0).toBe(true)
    expect(p.estimate?.targetReusableTokens).toBe(0)
  })
  test('TTL begins at request start and expires exactly at the boundary', () => {
    expect(cacheEvidence(hot(), 299999, cfg).status).toBe('hot')
    const p = cacheAdvice({ model: OPUS, effort: 'high' }, desired(SONNET), hot(), 300000, cfg)
    expect(p.evidence.status).toBe('expired')
    expect(p.evidence.estimatedReusableTokens).toBe(0)
  })
  test('auto defaults to 5m, or an hour on a subscription; explicit hour is an assumption, TTL writes may prove hour', () => {
    expect(cacheEvidence(hot(), 100, cfg).ttlSource).toBe('conservative-5m')
    const subscribed = cacheEvidence(hot(), 300000, { ...cfg, subscription: true })
    expect(subscribed.ttlSource).toBe('subscription-1h')
    expect(subscribed.ttlMs).toBe(3600000)
    expect(subscribed.status).toBe('hot')
    expect(cacheEvidence(hot(), 300000, { ...cfg, ttl: '1h' }).ttlSource).toBe('configured-assumption')
    const u = { ...usage(), cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } }
    const s = observeUsage({}, u, { model: OPUS }, 0)
    expect(cacheEvidence(s, 300000, cfg).ttlSource).toBe('observed-write')
    expect(cacheEvidence(s, 3600000, cfg).status).toBe('expired')
  })
  test('same model and effort need no rebuild calculation', () => {
    const p = cacheAdvice({ model: OPUS, effort: 'high' }, desired(OPUS), hot(), 100, cfg)
    expect(p.estimate).toBeUndefined()
    expect(p.effortEstimate).toBeUndefined()
    expect(p.reason).toBe('same-model')
    expect(p.effortReason).toBe('same-effort')
  })
  test('an effort change is not assumed to rebuild the cache (two were seen to keep it), nor to lock effort', () => {
    const p = cacheAdvice({ model: OPUS, effort: 'high' }, desired(OPUS, 'medium'), hot(), 100, cfg)
    expect(p.effortReason).toBe('effort-change-no-rebuild-seen')
    expect(p.estimate).toBeUndefined()
    expect('effortEstimate' in p).toBe(false)
    expect('effort' in p).toBe(false)
  })
  test('missing or invalid counters remain unknown without a routing fallback', () => {
    const s = observeUsage({}, { model: OPUS, input_tokens: 100000, output_tokens: 1 }, { model: OPUS, effort: 'high' }, 0)
    const p = cacheAdvice({ model: OPUS, effort: 'high' }, desired(HAIKU, 'low'), s, 100, cfg)
    expect(p.reason).toBe('model-change-cost-unknown')
    expect(p.estimate).toBeUndefined()
    expect(p.evidence.estimatedReusableTokens).toBeUndefined()
    expect('model' in p).toBe(false)
    expect(observeUsage({}, { ...usage(), cache_read_input_tokens: NaN }, { model: OPUS }, 0).last?.total).toBeUndefined()
  })
  test('a cache rebuild replaces a previous hit; switch-back never assumes history cached', () => {
    const rebuilt = observeUsage(hot(), { ...usage(), cache_read_input_tokens: 0, cache_creation_input_tokens: 100000 }, { model: OPUS, effort: 'high' }, 100)
    expect(cacheEvidence(rebuilt, 200, cfg).status).toBe('warm')
    const switched = observeUsage(rebuilt, { ...usage(HAIKU), cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 }, { model: HAIKU, effort: 'low' }, 200)
    const e = cacheEvidence(switched, 201, cfg)
    expect(e.estimatedReusableTokens).toBe(2000)
    expect(estimateSwitch(HAIKU, OPUS, e, cfg)?.targetReusableTokens).toBe(0)
  })
  test('actual response ID wins and missing actual ID invalidates observation', () => {
    const s = observeUsage({}, usage(HAIKU), { model: OPUS, effort: 'high' }, 0)
    expect(s.last?.model).toBe(HAIKU)
    expect(s.last?.requestedEffort).toBeUndefined()
    expect(observeUsage(s, { input_tokens: 1 }, { model: SONNET }, 1).last).toBeUndefined()
  })
  test('reset and context shrink remove all evidence; separate sessions do not share facts', () => {
    const a = { ...hot(), sessionId: 'a' }
    expect(resetCache(a, 'clear').last).toBeUndefined()
    expect(withContext(a, 500).last).toBeUndefined()
    expect(cacheEvidence({ sessionId: 'b' }, 1, cfg).observed).toBeUndefined()
  })
  test('unknown release prices remain unknown and known prices use standard API rates', () => {
    expect(priceFor('claude-opus-future', 100000)).toBeUndefined()
    expect(priceFor('claude-opus-4-6[1m]', 100000)).toBeUndefined()
    expect(priceFor(OPUS, 100000)).toEqual({ input: 5, output: 25, read: 0.5, write5m: 6.25, write1h: 10 })
    expect(priceFor('claude-haiku-5-5', 100000)?.input).toBe(0.1)
    expect(priceFor('claude-haiku-5-5', 100001)?.input).toBe(0.5)
    expect(priceFor('claude-opus-5-5', 100000)?.read).toBe(0.2)
    expect(priceFor('claude-sonnet-4-5', 250000)).toBeUndefined()
    const unknown = 'claude-unknown-family'
    expect(cacheAdvice({ model: unknown, effort: 'high' }, desired(HAIKU), hot(unknown), 1, cfg).reason).toBe('model-change-cost-unknown')
  })
  test('cost scenario uses published read/write rates and counts future turns after the switch', () => {
    const e = estimateSwitch(OPUS, SONNET, cacheEvidence(hot(), 1, cfg), cfg)!
    expect([e.stayFirst, e.switchFirst, e.switchingPremium, e.savingsPerFutureTurn].map(x => x.toFixed(6))).toEqual(['0.058250', '0.376500', '0.318250', '0.023500'])
    expect(e.breakevenTurns).toBe(14)
  })
  test('below the target minimum cache length, future cache discounts are not assumed', () => {
    const s = withContext(observeUsage({}, { ...usage(SONNET), input_tokens: 100, cache_read_input_tokens: 1900 }, { model: SONNET, effort: 'high' }, 0), 2000)
    const p = cacheAdvice({ model: SONNET, effort: 'high' }, desired(HAIKU), s, 1, { ...cfg, minTokens: 0 })
    expect(p.estimate?.breakevenTurns).toBe(null)
    expect(p.estimate?.assumptions).toContain('target-below-minimum-cache-length-no-future-hits')
  })
  test('new conversation resets are cold assumptions; compaction without counters is unknown', () => {
    expect(cacheEvidence(resetCache(hot(), 'session-clear'), 1, cfg).status).toBe('cold')
    expect(cacheEvidence(resetCache(hot(), 'compaction'), 1, cfg).status).toBe('unknown')
  })
})

const learned = { caps: { version: '9.9.9', families: { opus: { id: OPUS, ok: true, effort: true, at: '' }, sonnet: { id: SONNET, ok: true, effort: true, at: '' }, haiku: { id: HAIKU, ok: true, effort: true, at: '' } }, retryOk: true } }
const options = { typesafe_api_key: FAKE_KEY, model_routing: 'on', write_log: true }
// Jev judges only the chosen tier at the chosen effort (0 low, 1 medium,
// 2 high) able to do the work; `fail` makes Jev answer with an error.
type Choice = { model: string; score: number; fail?: boolean }
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const jev = (choice: Choice) => (q: Record<string, unknown>) => {
  if (choice.fail) return { status: 500, body: { error: 'down' } }
  const body: any = 'acts_on_user_system' in q ? rankWide(0.9, 'speckit-specify', { [`${choice.model}::${LEVELS[choice.score]}`]: 0.95 }, q) : rerank(q, { 'speckit-specify': 0.9 })
  return { status: 200, body }
}
const begin = async ($: Engine, id: string) => {
  await $.prompt.submit({ text: PROMPT, asUser: true })
  await $.turn.start({ text: PROMPT, turnId: id })
}
const step = async ($: Engine, id: string, index = 0, extra: Record<string, unknown> = {}) => {
  const stream = $.turn.step({ turnId: id, index, model: SONNET, effort: 'medium', messageCount: 10, ...extra } as never)
  let r = await stream.next()
  while (!r.done) r = await stream.next()
  return r.value
}
const bottom = (on: On, w: World, response?: (model: string) => UsageLike | null) => {
  const sent: { model: string; effort?: unknown }[] = []
  on('turn.step', async function* ($, e) {
    sent.push({ model: e.model, effort: e.effort })
    w.contextTokens = 100000
    return { turnId: e.turnId, index: e.index, answer: 'OK', toolUses: [], stopReason: 'end_turn', usage: response ? response(e.model) : usage(e.model) } as never
  })
  return sent
}
const last = (w: World) => logLines(w).filter(x => x.type === 'step').at(-1)

describe('cache routing engine integration', () => {
  test('a costly upgrade runs when it is the only pair Jev judges feasible; Jev sees no costs', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, learned)
    const choice: Choice = { model: 'sonnet', score: 2 }
    const w = world(on, jev(choice)), sent = bottom(on, w)
    await begin($, 'warm'); await step($, 'warm')
    choice.model = 'opus'; choice.score = 2
    await begin($, 'up'); await step($, 'up')
    expect(sent.at(-1)).toEqual({ model: OPUS, effort: 'high' })
    expect(last(w)?.cache_advice.estimate.switchingPremium > 0).toBe(true)
    const facts = JSON.parse(w.fetches.at(-2)!.body).state.routing_context
    expect(facts.context.conversation_tokens).toBe(100000)
    expect(facts.model_costs).toBeUndefined()
    choice.model = 'sonnet'; choice.score = 0
    await begin($, 'down'); await step($, 'down')
    expect(sent.at(-1)).toEqual({ model: SONNET, effort: 'low' })
  })
  test('no Jev answer keeps the session model, whatever the cache holds', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, learned)
    const choice: Choice = { model: 'opus', score: 2 }
    const w = world(on, jev(choice)), sent = bottom(on, w)
    await begin($, 'a'); await step($, 'a')
    choice.fail = true
    await begin($, 'b'); await step($, 'b')
    expect(sent[1]).toEqual({ model: SONNET, effort: 'medium' })
    expect(last(w)?.reasons).toContain('model:no-jev-answer')
  })
  test('actual previous routed model supplies cost evidence while Jev switching and skill routing continue', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, learned)
    const choice: Choice = { model: 'opus', score: 2 }
    const w = world(on, jev(choice)), sent = bottom(on, w)
    await begin($, 't1'); await step($, 't1')
    choice.model = 'sonnet'; choice.score = 0
    await begin($, 't2'); await step($, 't2'); await step($, 't2', 1)
    expect(sent.map(x => `${x.model}/${x.effort}`)).toEqual([`${OPUS}/high`, `${SONNET}/low`, `${SONNET}/low`])
    expect(last(w)?.cache_advice.mode).toBe('advisory')
    expect(last(w)?.jev_recommended.model).toBe('sonnet')
    expect(last(w)?.final_recommended.model).toBe(SONNET)
    expect(w.fetches.length).toBe(4)
    expect(w.seen?.context?.join('\n')).toContain('speckit-specify')
    const display = await $.command.run({ command: 'jev-model', args: '' })
    expect(display.text).toContain('observed read/write 99000/0 tokens')
    expect(display.text).toContain('estimated switch premium')
    expect([...w.written.values()].join('\n').includes(PROMPT)).toBe(false)
    expect([...w.written.values()].join('\n').includes(FAKE_KEY)).toBe(false)
  })
  test('hot-cache model and effort upgrades follow Jev without needing a quality override', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, learned)
    const choice: Choice = { model: 'sonnet', score: 1 }
    const w = world(on, jev(choice)), sent = bottom(on, w)
    await begin($, 'a'); await step($, 'a')
    choice.score = 2
    await begin($, 'b'); await step($, 'b')
    expect(sent[1]?.effort).toBe('high')
    expect(last(w)?.cache_advice.effortReason).toBe('effort-change-no-rebuild-seen')
    choice.model = 'opus'
    await begin($, 'c'); await step($, 'c')
    expect(sent[2]?.model).toBe(OPUS)
    expect(last(w)?.cache_advice.reason).toBe('model-change-estimated')
  })
  // The test session shows subscription rate limits, so the cache lasts an hour.
  test('expiry updates cost evidence while all steps of an already bound turn remain fixed', { options }, async ($, on) => {
    const clock = mock.clock(on); mock.store(on, learned)
    const choice: Choice = { model: 'opus', score: 2 }
    const w = world(on, jev(choice)), sent = bottom(on, w)
    await begin($, 'a'); await step($, 'a')
    choice.model = 'sonnet'; choice.score = 0
    await begin($, 'b'); await step($, 'b')
    await clock.advance(3600001)
    choice.model = 'haiku'
    await step($, 'b', 1)
    expect(sent[2]?.model).toBe(SONNET)
    // The step above refreshed cache: expire it once more for a new decision.
    await clock.advance(3600001)
    await begin($, 'c'); await step($, 'c')
    expect(sent[3]?.model).toBe(HAIKU)
    expect(last(w)?.cache_advice.evidence.status).toBe('expired')
  })
  test('dry-run records Jev and advisory costs while sending the session model', { options: { ...options, model_routing: 'dry-run' } }, async ($, on) => {
    mock.clock(on); mock.store(on, { ...learned, advanced: { cost_horizon: 1 } })
    const choice: Choice = { model: 'sonnet', score: 1 }
    const w = world(on, jev(choice)), sent = bottom(on, w)
    await begin($, 'a'); await step($, 'a')
    choice.model = 'haiku'; choice.score = 0
    await begin($, 'b'); await step($, 'b')
    expect(sent.map(x => x.model)).toEqual([SONNET, SONNET])
    expect(sent.map(x => x.effort)).toEqual(['medium', 'medium'])
    expect(last(w)?.jev_recommended.model).toBe('haiku')
    expect(last(w)?.cache_advice.mode).toBe('advisory')
    expect(last(w)?.cache_advice.estimate.projectedSavings < 0).toBe(true)
    expect(last(w)?.final_recommended.model).toBe(HAIKU)
  })
  test('subagent responses cannot overwrite main cache facts', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, learned)
    const choice: Choice = { model: 'opus', score: 2 }
    const w = world(on, jev(choice)), sent = bottom(on, w)
    await begin($, 'a'); await step($, 'a')
    await step($, 'sub', 0, { agentId: 'sub', model: HAIKU, effort: 'low' })
    choice.model = 'sonnet'; choice.score = 0
    await begin($, 'b'); await step($, 'b')
    expect(sent.map(x => x.model)).toEqual([OPUS, HAIKU, SONNET])
    expect(last(w)?.cache_advice.evidence.observed.model).toBe(OPUS)
  })
  test('missing token/cache information stays unknown and does not override Jev', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, learned)
    const choice: Choice = { model: 'opus', score: 2 }
    const w = world(on, jev(choice)), sent = bottom(on, w, model => ({ model, input_tokens: 100000, output_tokens: 100 }))
    await begin($, 'a'); await step($, 'a')
    choice.model = 'haiku'; choice.score = 0
    await begin($, 'b'); await step($, 'b')
    expect(sent[1]).toEqual({ model: HAIKU, effort: 'low' })
    expect(last(w)?.cache_advice.reason).toBe('model-change-cost-unknown')
  })
  test('substituted response model is tracked as actual and its effort is unconfirmed', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, learned)
    const choice: Choice = { model: 'opus', score: 2 }
    const w = world(on, jev(choice)); bottom(on, w, () => usage(SONNET))
    await begin($, 'a'); await step($, 'a')
    choice.model = 'sonnet'; choice.score = 1
    await begin($, 'b'); await step($, 'b')
    expect(last(w)?.cache_advice.evidence.observed.model).toBe(SONNET)
    expect(last(w)?.cache_advice.evidence.observed.requestedEffort).toBeUndefined()
    expect(last(w)?.answered_by).toBe(SONNET)
  })
  test('advanced effort from a prior request is not introduced on a different step', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, learned)
    const choice: Choice = { model: 'sonnet', score: 1 }
    const w = world(on, jev(choice)), sent = bottom(on, w)
    // Record a genuine engine-provided advanced effort on an unrouted turn.
    await step($, 'unrouted', 0, { effort: 'xhigh' })
    await begin($, 'a'); await step($, 'a')
    expect(sent[0]?.effort).toBe('xhigh')
    expect(sent[1]?.effort).toBe('medium')
  })
  test('partial streamed failure is not resent, and the remaining turn uses the fallback', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, learned)
    const w = world(on, jev({ model: 'opus', score: 2 }))
    const sent: string[] = []
    on('turn.step', async function* ($, e) {
      sent.push(e.model)
      if (e.model === OPUS) {
        yield { kind: 'text', index: 0, text: 'partial' } as never
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never
      }
      return { turnId: e.turnId, index: e.index, answer: 'OK', toolUses: [], stopReason: 'end_turn', usage: usage(e.model) } as never
    })
    await begin($, 'a'); await step($, 'a'); await step($, 'a', 1)
    expect(sent).toEqual([OPUS, SONNET])
    expect(last(w)?.reasons).toContain('fallback-pinned')
    expect(last(w)?.cache_advice).toBeUndefined()
  })
  test('an explicit /model choice does not freeze routing: Jev still judges every turn, and the choice is the session fallback', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, learned)
    const choice: Choice = { model: 'haiku', score: 0 }
    const w = world(on, jev(choice)), sent = bottom(on, w)
    on('classic.PostModelSwitch', () => ({} as never))
    await $.classic.PostModelSwitch({ to_model: OPUS, source: 'command' } as never)
    await begin($, 'a'); await step($, 'a', 0, { model: OPUS })
    expect(sent[0]?.model).toBe(HAIKU)
    expect(last(w)?.reasons.some((r: string) => r.includes('manual'))).toBe(false)
    choice.fail = true
    await begin($, 'b'); await step($, 'b', 0, { model: OPUS })
    expect(sent[1]?.model).toBe(OPUS)
    // Jev's error ends the round after one request.
    expect(w.fetches.length).toBe(3)
  })
  test('clear, resume, compaction and replaced session ID invalidate evidence', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, learned)
    const choice: Choice = { model: 'opus', score: 2 }
    const w = world(on, jev(choice)); bottom(on, w)
    on('session.end', () => ({ sessionId: 'old' } as never))
    on('session.compact', ($, e) => ({ messages: e.messages } as never))
    await begin($, 'a'); await step($, 'a')
    await $.session.end({ reason: 'clear' } as never)
    choice.model = 'haiku'; choice.score = 0
    await begin($, 'b'); await step($, 'b')
    expect(last(w)?.cache_advice.evidence.observed).toBeUndefined()
    await $.session.end({ reason: 'resume' } as never)
    await begin($, 'c'); await step($, 'c')
    expect(last(w)?.cache_advice.evidence.observed).toBeUndefined()
    await $.session.compact({ messages: [{ role: 'user', text: 'Compacted summary', toolUses: [] }] } as never)
    await begin($, 'd'); await step($, 'd')
    expect(last(w)?.cache_advice.evidence.observed).toBeUndefined()
    w.sessionId = 'new-session'
    await begin($, 'e'); await step($, 'e')
    expect(last(w)?.cache_advice.evidence.observed).toBeUndefined()
  })
})

describe('settings homes', () => {
  test('descriptions and cache tuning are read from $.store only; page settings from the page only', () => {
    const store = { model_haiku: 'My Small Work', effort_high: 'My High', cache_min_hit_ratio: 0.9 }
    const before = sharedConfig({ feasibility_threshold: 0.7 }, store)
    expect(sharedConfig({ feasibility_threshold: 0.7 }, JSON.parse(JSON.stringify(store)))).toEqual(before)
    expect(before.modelDescriptions.haiku).toBe('My Small Work')
    expect(before.effortLevels.high).toBe('My High')
    expect(before.cache.minHitRatio).toBe(0.9)
    expect(before.feasibleThreshold).toBe(0.7)
    // A value in the wrong home is ignored.
    expect(sharedConfig({ effort_high: 'Page High' }).effortLevels.high).toBe(DEFAULT_EFFORT_LEVELS.high)
    expect(sharedConfig({}, { feasibility_threshold: 0.7 }).feasibleThreshold).toBe(0.6)
    expect(sharedConfig({ cost_horizon: 9 }).cost.horizon).toBe(0)
    expect(sharedConfig({}, { cost_horizon: 9, cost_tolerance: 0.1 }).cost).toEqual({ horizon: 9, tolerance: 0.1 })
    expect(sharedConfig({}, { effort_high: '' }).effortLevels.high).toBe(DEFAULT_EFFORT_LEVELS.high)
  })
  test('cache values validate fractions, choices and integers', () => {
    expect(parseSetting('cache_min_hit_ratio', '0.93')).toBe(0.93)
    expect(parseSetting('cost_horizon', '3.1')).toBeUndefined()
    expect(parseSetting('cache_ttl', 'forever')).toBeUndefined()
    expect(parseSetting('cost_tolerance', '0.9')).toBeUndefined()
    expect(parseSetting('cost_horizon', '0')).toBe(0)
    expect(sharedConfig({}, { cache_min_tokens: -1, cache_min_hit_ratio: NaN }).cache).toEqual(cfg)
  })
  test('commands write each setting to its own home; a restart reads them back', { options }, async ($, on) => {
    mock.clock(on); const saved = memoryStore(on, learned)
    const w = world(on, jev({ model: 'sonnet', score: 1 })); bottom(on, w)
    await $.command.run({ command: 'jev-model', args: 'set model_haiku My Small Work' })
    await $.command.run({ command: 'jev-model', args: 'set effort_high Weigh several approaches' })
    await $.command.run({ command: 'jev-model', args: 'set cache_min_hit_ratio 0.9' })
    await $.command.run({ command: 'jev-model', args: 'set feasibility_threshold 0.7' })
    expect(saved.advanced).toEqual({ model_haiku: 'My Small Work', effort_high: 'Weigh several approaches', cache_min_hit_ratio: 0.9 })
    expect(w.sets.map(s => s.key)).toEqual(['jev-router@inline.feasibility_threshold'])
    await begin($, 'b')
    const wide = JSON.parse(w.fetches[0]!.body).questions
    expect(wide['feasible::haiku::low'].instructions).toContain('My Small Work')
    expect(wide['feasible::opus::high'].instructions).toContain('Weigh several approaches')
    expect((await $.command.run({ command: 'jev-model', args: 'cache' })).text).toContain('cache_min_hit_ratio = 0.9')
    await $.command.run({ command: 'jev-model', args: 'unset model_haiku' })
    expect(saved.advanced).toEqual({ effort_high: 'Weigh several approaches', cache_min_hit_ratio: 0.9 })
  })
  test('defaults resets both homes while preserving the secret', { options }, async ($, on) => {
    mock.clock(on); const saved = memoryStore(on, learned)
    const w = world(on, jev({ model: 'sonnet', score: 1 }))
    await $.command.run({ command: 'jev-model', args: 'set feasibility_threshold 0.8' })
    await $.command.run({ command: 'jev-model', args: 'set model_opus My Architecture' })
    await $.command.run({ command: 'jev-model', args: 'defaults' })
    expect(w.configRows.find(r => r.key.endsWith('.feasibility_threshold'))?.value).toBe(0.6)
    expect(saved.advanced).toBeUndefined()
    expect(w.sets.some(s => s.key.endsWith('.typesafe_api_key'))).toBe(false)
  })
})
