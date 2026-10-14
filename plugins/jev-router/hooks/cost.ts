// What each tier at each effort is estimated to cost over the next requests,
// pure: register.ts supplies the facts. The context is rebuilt on a switch of
// model and read back from a warm cache when staying; the output (thinking
// included) is what requests were seen producing. API-equivalent USD at list
// prices, never subscription quota or a bill.
import { contextCost, priceFor, type Evidence } from './cache'
import { EFFORTS, isEffort, type Effort, type Step } from './model'

// Recent output tokens of main requests at each effort (numbers only).
export type OutputStats = Partial<Record<Effort, number[]>>

export type CostConfig = {
  // Requests a choice is costed over: the first plus the later ones.
  horizon: number
  // Costs within this share of the cheapest feasible pair compete on
  // feasibility instead (see decide in model.ts).
  tolerance: number
}

// Samples kept per effort, and how many an effort needs before its own
// median is used. Below that, every effort shares the pooled median (so
// effort does not move the cost), and below POOLED_MIN output is left out
// of every pair alike.
export const MAX_SAMPLES = 40
export const MIN_SAMPLES = 10
export const POOLED_MIN = 3

// Requests per turn, when none are known: used until enough turns are seen.
export const DEFAULT_HORIZON = 5
export const HORIZON_MIN_TURNS = 3

export type PairCost = {
  // Total over the horizon; undefined when no price or context is known.
  usd?: number
  context_usd?: number
  // Undefined when too little output has been seen.
  output_usd?: number
  output_tokens?: number
  output_basis: 'own' | 'pooled' | 'none'
  // Whether the pair keeps the current model (and so its cache).
  stays: boolean
  // The model's output list price per million, ordering unknown totals.
  rank?: number
}

const usd = (n: number) => Math.round(n * 1000000) / 1000000

export const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

// Reads what $.store holds: only arrays of numbers count (an older shape of
// these stats is dropped, not guessed at).
export const normalizeStats = (raw: unknown): OutputStats => {
  const stats: OutputStats = {}
  if (!raw || typeof raw !== 'object') return stats
  for (const effort of EFFORTS) {
    const list = (raw as Record<string, unknown>)[effort]
    if (Array.isArray(list)) stats[effort] = list.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0).slice(-MAX_SAMPLES)
  }
  return stats
}

// Keeps the latest samples, so a long session tracks the work at hand.
export const learnOutput = (stats: OutputStats, effort: unknown, tokens: unknown): OutputStats | undefined => {
  if (!isEffort(effort) || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return undefined
  return { ...stats, [effort]: [...(stats[effort] ?? []), Math.round(tokens)].slice(-MAX_SAMPLES) }
}

const pooled = (stats: OutputStats) => EFFORTS.flatMap(e => stats[e] ?? [])

// The output a request at this effort is expected to produce: its own median
// once it has MIN_SAMPLES, else the median over every effort seen.
export const outputEstimate = (stats: OutputStats, effort: Effort): { tokens?: number; basis: 'own' | 'pooled' | 'none' } => {
  const own = stats[effort] ?? []
  if (own.length >= MIN_SAMPLES) return { tokens: median(own), basis: 'own' }
  const all = pooled(stats)
  if (all.length >= POOLED_MIN) return { tokens: median(all), basis: 'pooled' }
  return { basis: 'none' }
}

// Numbers only, for the log: samples seen and their median per effort.
export const outputSummary = (stats: OutputStats) =>
  Object.fromEntries(EFFORTS.filter(e => (stats[e]?.length ?? 0) > 0).map(e => [e, { n: stats[e]!.length, median: median(stats[e]!) }]))

// Requests per turn to cost over: the setting when set, else the median of
// the recent turns once enough were seen, else the default.
export const horizonFor = (setting: number, turnLengths: readonly number[]): { horizon: number; source: 'setting' | 'learned' | 'default' } => {
  if (setting > 0) return { horizon: setting, source: 'setting' }
  if (turnLengths.length >= HORIZON_MIN_TURNS) return { horizon: Math.min(100, Math.max(1, median(turnLengths)!)), source: 'learned' }
  return { horizon: DEFAULT_HORIZON, source: 'default' }
}

export const pairCost = (
  id: string | undefined,
  effort: Effort,
  current: Step | undefined,
  evidence: Evidence,
  stats: OutputStats,
  config: Pick<CostConfig, 'horizon'>,
): PairCost => {
  if (!id) return { stays: false, output_basis: 'none' }
  // Only a switch of model rebuilds the cache: two effort changes in a row
  // were seen to keep it (cache_read kept growing, nothing rewritten).
  const stays = id === current?.model
  const price = priceFor(id, evidence.contextTokens ?? 0)
  const horizon = Math.max(1, Math.floor(config.horizon))
  const context = contextCost(id, stays ? id : undefined, evidence)
  // Staying with the cache state unknown is taken as a warm read.
  const first = context ? (stays ? context.next_request_usd ?? context.cached_read_usd : context.rebuild_usd) : undefined
  const contextUsd = context && first !== undefined ? usd(first + (horizon - 1) * context.cached_read_usd) : undefined
  const output = outputEstimate(stats, effort)
  const outputUsd = price && output.tokens !== undefined ? usd((horizon * output.tokens * price.output) / 1000000) : undefined
  return {
    usd: contextUsd !== undefined ? usd(contextUsd + (outputUsd ?? 0)) : undefined,
    context_usd: contextUsd,
    output_usd: outputUsd,
    output_tokens: output.tokens,
    output_basis: output.basis,
    stays,
    rank: price?.output,
  }
}
