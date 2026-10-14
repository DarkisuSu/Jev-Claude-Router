// Cache evidence and advisory cost estimates; never selects a routing plan.
import type { Step } from './model'

export type CacheConfig = {
  minTokens: number
  minHitRatio: number
  ttl: 'auto' | '5m' | '1h'
  // Requests a choice is costed over: the first plus the later ones.
  breakevenTurns: number
  // Claude Code on a subscription caches for an hour (5 minutes once usage
  // runs into overage); `auto` assumes the hour there.
  subscription?: boolean
}
export type UsageLike = {
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}
export type Observation = {
  model: string
  requestedEffort?: string | number
  requestAt: number
  input?: number
  output?: number
  read?: number
  write?: number
  total?: number
  hitRatio?: number
  // Only when the response supplies TTL-specific creation counters.
  ttlEvidence?: '5m' | '1h'
}
export type CacheState = {
  sessionId?: string
  last?: Observation
  contextTokens?: number
  invalidated?: string
}
const tokens = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined

export const observeUsage = (state: CacheState, usage: UsageLike | null | undefined, requested: Step, requestAt: number): CacheState => {
  // e.model is never substituted for the actual answering model.
  if (!usage?.model) return { ...state, last: undefined, invalidated: 'unknown-answer-model' }
  const input = tokens(usage.input_tokens), read = tokens(usage.cache_read_input_tokens), write = tokens(usage.cache_creation_input_tokens)
  const total = input !== undefined && read !== undefined && write !== undefined ? input + read + write : undefined
  const five = tokens(usage.cache_creation?.ephemeral_5m_input_tokens), hour = tokens(usage.cache_creation?.ephemeral_1h_input_tokens)
  const ttlEvidence = hour !== undefined && hour > 0 && five === 0 ? '1h' : five !== undefined && five > 0 ? '5m' : undefined
  return {
    ...state, invalidated: undefined,
    last: { model: usage.model, requestedEffort: usage.model === requested.model ? requested.effort : undefined, requestAt, input, read, write, total, output: tokens(usage.output_tokens), hitRatio: total !== undefined && total > 0 ? read! / total : undefined, ttlEvidence },
  }
}

export const resetCache = (state: CacheState, why: string, sessionId = state.sessionId): CacheState => ({ sessionId, invalidated: why })
export const withContext = (state: CacheState, value: unknown): CacheState => {
  const contextTokens = tokens(value)
  // usage.context is last-response context, not the next request's token count.
  if (contextTokens !== undefined && state.contextTokens !== undefined && contextTokens < state.contextTokens) return { ...resetCache(state, 'context-shrank'), contextTokens }
  return { ...state, contextTokens }
}

// Official standard API prices per million tokens, verified 2026-10-14.
// This table only prices observed IDs; it NEVER supplies routing targets.
// Unknown releases and special variants have no price rather than inheriting
// an obsolete family's price. See README for tokenizer/plan limitations.
export const PRICING_AS_OF = '2026-10-14'
export type Price = { input: number; output: number; read: number; write5m: number; write1h: number }
const price = (input: number, output: number, read = input * 0.1): Price => ({ input, output, read, write5m: input * 1.25, write1h: input * 2 })
const modelKey = (id: string) => id.replace(/-\d{8}$/, '')
const cacheMinimumFor = (id: string) => {
  const name = modelKey(id)
  if (['claude-opus-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'].includes(name)) return 4096
  if (['claude-opus-4-7', 'claude-3-5-haiku'].includes(name)) return 2048
  if (['claude-sonnet-4', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4', 'claude-opus-4-1', 'claude-opus-4-8'].includes(name)) return 1024
  return 512 // Remaining priced releases in this snapshot use 512.
}
export const priceFor = (id: string, context: number): Price | undefined => {
  if (/\[|fast|1m|plan/i.test(id)) return undefined
  const name = modelKey(id)
  // Older long-context variants/modifiers are not exposed by this API.
  if (context > 200000 && ['claude-sonnet-4', 'claude-sonnet-4-5', 'claude-opus-4', 'claude-opus-4-1', 'claude-opus-4-5', 'claude-haiku-4-5', 'claude-3-5-haiku'].includes(name)) return undefined
  const prices: Record<string, Price> = {
    'claude-3-5-haiku': price(0.8, 4),
    'claude-haiku-4-5': price(1, 5),
    'claude-haiku-5-5': context > 100000 ? price(0.5, 2.5) : price(0.1, 0.5),
    'claude-sonnet-4': price(3, 15),
    'claude-sonnet-4-5': price(3, 15),
    'claude-sonnet-4-6': price(3, 15),
    'claude-sonnet-5': price(2, 10),
    'claude-sonnet-5-5': price(2, 10, 0.1),
    'claude-opus-4': price(15, 75),
    'claude-opus-4-1': price(15, 75),
    'claude-opus-4-5': price(5, 25),
    'claude-opus-4-6': price(5, 25),
    'claude-opus-4-7': price(5, 25),
    'claude-opus-4-8': price(5, 25),
    'claude-opus-5': price(5, 25),
    'claude-opus-5-5': price(4, 20, 0.2),
  }
  return prices[name]
}

export type Evidence = {
  status: 'cold' | 'hot' | 'warm' | 'expired' | 'unknown'
  contextTokens?: number
  contextSource: 'last-session-context' | 'observed-input' | 'unknown'
  observed?: Observation
  estimatedReusableTokens?: number
  ttlMs: number
  ttlSource: 'observed-write' | 'configured-assumption' | 'subscription-1h' | 'conservative-5m'
  limitations: string[]
}
export const cacheEvidence = (state: CacheState, now: number, config: CacheConfig): Evidence => {
  const last = state.last
  const ttl = config.ttl === 'auto' ? last?.ttlEvidence ?? (config.subscription ? '1h' : '5m') : config.ttl
  const ttlMs = ttl === '1h' ? 3600000 : 300000
  const contextTokens = state.contextTokens ?? last?.total
  const base: Evidence = {
    status: 'unknown', contextTokens, contextSource: state.contextTokens !== undefined ? 'last-session-context' : last?.total !== undefined ? 'observed-input' : 'unknown',
    observed: last, ttlMs,
    ttlSource: config.ttl !== 'auto' ? 'configured-assumption' : last?.ttlEvidence ? 'observed-write' : config.subscription ? 'subscription-1h' : 'conservative-5m',
    limitations: ['prefix-identity-unavailable', 'next-context-estimated', 'requested-effort-not-confirmed', 'per-message-effort-unavailable'],
  }
  // A conversation already under way when first seen (a plugin reload, say)
  // may well have a warm cache: that is unknown, not cold.
  if (!last) return { ...base, status: state.invalidated ? state.invalidated.startsWith('session-') || state.invalidated === 'different-session' ? 'cold' : 'unknown' : (state.contextTokens ?? 0) > 0 ? 'unknown' : 'cold' }
  if (now < last.requestAt) return base
  if (now - last.requestAt >= ttlMs) return { ...base, status: 'expired', estimatedReusableTokens: 0 }
  if (last.read === undefined || last.write === undefined || last.total === undefined) return base
  // Bound by the prefix actually read/written on the most recent request.
  // No historical model cache is assumed reusable after switching away.
  const reusable = Math.min(contextTokens ?? last.total, last.read + last.write)
  const hot = (contextTokens ?? 0) >= config.minTokens && (last.hitRatio ?? 0) >= config.minHitRatio && reusable > 0
  return { ...base, status: reusable === 0 ? 'cold' : hot ? 'hot' : 'warm', estimatedReusableTokens: reusable }
}

// What carrying the conversation's context costs on one model for the next
// request, from the context size alone, so it is known from the first routed
// turn. A switch (or an expired cache) writes the whole context into that
// model's cache; a warm cache on the same model is read back. Output tokens
// are not included: they do not depend on the context.
export type ContextCost = {
  context_tokens: number
  rebuild_usd: number
  cached_read_usd: number
  next_request: 'cached-read' | 'rebuild' | 'unknown'
  next_request_usd: number | null
}
const usd = (n: number) => Math.round(n * 1000000) / 1000000
export const contextCost = (target: string, current: string | undefined, evidence: Evidence): ContextCost | undefined => {
  const n = evidence.contextTokens
  if (n === undefined || n <= 0) return undefined
  const p = priceFor(target, n)
  if (!p) return undefined
  const cacheable = n >= cacheMinimumFor(target)
  const write = cacheable ? (evidence.ttlMs === 3600000 ? p.write1h : p.write5m) : p.input
  const read = cacheable ? p.read : p.input
  const rebuild = (n * write) / 1000000
  const next = target !== current ? 'rebuild'
    : evidence.status === 'hot' || evidence.status === 'warm' ? 'cached-read'
    : evidence.status === 'cold' || evidence.status === 'expired' ? 'rebuild'
    : 'unknown'
  // A warm cache covers what the last request read or wrote; the rest is new.
  const reusable = Math.min(n, evidence.estimatedReusableTokens ?? n)
  const warm = (reusable * read + (n - reusable) * write) / 1000000
  return {
    context_tokens: n,
    rebuild_usd: usd(rebuild),
    cached_read_usd: usd((n * read) / 1000000),
    next_request: next,
    next_request_usd: next === 'rebuild' ? usd(rebuild) : next === 'cached-read' ? usd(warm) : null,
  }
}

export type CostEstimate = {
  kind: 'api-resource-proxy'; pricingAsOf: string
  contextTokens: number; reusableTokens: number; targetReusableTokens: number
  stayFirst: number; switchFirst: number; switchingPremium: number
  stayFuture: number; switchFuture: number; savingsPerFutureTurn: number
  breakevenTurns: number | null; projectedSavings: number; horizon: number
  assumptions: string[]
}
// Bounded scenario: last observed output/new input repeated, one main model
// request per future turn, identical token counts across models, hot within TTL.
// Effort has no token forecast: output/reasoning savings are never invented.
export const estimateSwitch = (current: string, target: string, evidence: Evidence, config: CacheConfig): CostEstimate | undefined => {
  const n = evidence.contextTokens, reusable = evidence.estimatedReusableTokens, last = evidence.observed
  if (n === undefined || reusable === undefined || last?.input === undefined || last.output === undefined) return undefined
  const a = priceFor(current, n), b = priceFor(target, n)
  if (!a || !b) return undefined
  const cost = (p: Price, reads: number, writes: number, input: number, output: number) => (reads * p.read + writes * (evidence.ttlMs === 3600000 ? p.write1h : p.write5m) + input * p.input + output * p.output) / 1000000
  const tail = Math.max(0, n - reusable)
  // Worst-case full-prefix rebuild after model or top-level effort changes.
  const stayFirst = cost(a, reusable, tail, 0, last.output)
  const targetCacheable = n >= cacheMinimumFor(target)
  const switchFirst = targetCacheable ? cost(b, 0, n, 0, last.output) : cost(b, 0, 0, n, last.output)
  const growth = last.input + last.write!
  const stayFuture = cost(a, n, growth, 0, last.output)
  const switchFuture = targetCacheable ? cost(b, n, growth, 0, last.output) : cost(b, 0, 0, n + growth, last.output)
  const switchingPremium = switchFirst - stayFirst
  const savingsPerFutureTurn = stayFuture - switchFuture
  const breakevenTurns = switchingPremium <= 0 ? 0 : savingsPerFutureTurn > 0 ? Math.ceil(switchingPremium / savingsPerFutureTurn) : null
  return { kind: 'api-resource-proxy', pricingAsOf: PRICING_AS_OF, contextTokens: n, reusableTokens: reusable, targetReusableTokens: 0, stayFirst, switchFirst, switchingPremium, stayFuture, switchFuture, savingsPerFutureTurn, breakevenTurns, projectedSavings: config.breakevenTurns * savingsPerFutureTurn - switchingPremium, horizon: config.breakevenTurns, assumptions: ['same-token-count-proxy-across-tokenizers', targetCacheable ? 'full-prefix-cache-write-on-switch' : 'target-below-minimum-cache-length-no-future-hits', 'no-historical-target-cache-assumed', 'last-output-and-growth-repeated', 'one-request-per-future-turn-within-ttl', 'no-effort-output-savings-assumed', 'not-subscription-quota-or-billing'] }
}

export type CacheAdvice = { mode: 'advisory'; reason: string; effortReason: string; evidence: Evidence; estimate?: CostEstimate }
export const cacheAdvice = (current: Step, proposed: Step, state: CacheState, now: number, config: CacheConfig): CacheAdvice => {
  const evidence = cacheEvidence(state, now, config)
  const modelChange = current.model !== proposed.model
  const effortChange = current.effort !== proposed.effort
  const estimate = modelChange ? estimateSwitch(current.model, proposed.model, evidence, config) : undefined
  return {
    mode: 'advisory', evidence, estimate,
    reason: !modelChange ? 'same-model' : estimate ? 'model-change-estimated' : 'model-change-cost-unknown',
    // Two effort changes were seen to keep the cache: none is assumed to rebuild it.
    effortReason: !effortChange ? 'same-effort' : modelChange ? 'model-switch-rebuild' : 'effort-change-no-rebuild-seen',
  }
}
