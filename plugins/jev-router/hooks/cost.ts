// What each tier at each effort is estimated to cost over the next requests,
// pure: register.ts supplies the facts. The context is rebuilt on a switch or
// an effort change and read back from a warm cache when staying; the output
// (thinking included) is what requests at that effort were seen producing.
// API-equivalent USD at list prices, never subscription quota or a bill.
import { contextCost, priceFor, type Evidence } from './cache'
import { EFFORTS, isEffort, type Effort, type Step } from './model'

// Average output tokens of a main request at each effort, learned from
// responses (numbers only; no text).
export type OutputStats = Partial<Record<Effort, { avg: number; n: number }>>

export type CostConfig = {
  // Requests a choice is costed over: the first plus the later ones.
  horizon: number
  // Relative output per request at each effort, used for a level whose
  // output has not been seen yet (scaled from the nearest level seen).
  ratios: Record<Effort, number>
}

export type PairCost = {
  // Total over the horizon; undefined when no price or context is known.
  usd?: number
  context_usd?: number
  // Undefined when no output has been seen at any effort.
  output_usd?: number
  output_tokens?: number
  // Whether the pair keeps the current model and effort (its cache).
  stays: boolean
  // The model's output list price per million, ordering unknown totals.
  rank?: number
}

const usd = (n: number) => Math.round(n * 1000000) / 1000000

// A moving average, so a long session tracks the work at hand.
export const learnOutput = (stats: OutputStats, effort: unknown, tokens: unknown): OutputStats | undefined => {
  if (!isEffort(effort) || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return undefined
  const before = stats[effort]
  const avg = before ? before.avg + 0.3 * (tokens - before.avg) : tokens
  return { ...stats, [effort]: { avg: Math.round(avg), n: Math.min((before?.n ?? 0) + 1, 1000) } }
}

// The output a request at this effort is expected to produce: what was seen
// at that level, else the nearest level seen scaled by the ratios.
export const outputEstimate = (stats: OutputStats, effort: Effort, ratios: Record<Effort, number>): number | undefined => {
  const seen = stats[effort]
  if (seen && seen.n > 0) return seen.avg
  const at = EFFORTS.indexOf(effort)
  const nearest = EFFORTS.filter(e => (stats[e]?.n ?? 0) > 0).sort((a, b) => Math.abs(EFFORTS.indexOf(a) - at) - Math.abs(EFFORTS.indexOf(b) - at))[0]
  if (!nearest || !(ratios[nearest] > 0)) return undefined
  return Math.round((stats[nearest]!.avg * ratios[effort]) / ratios[nearest])
}

// For a model that takes no effort, effort changes nothing: the mean of
// what was seen stands for every level.
const anyOutput = (stats: OutputStats) => {
  const seen = EFFORTS.map(e => stats[e]).filter(s => s && s.n > 0)
  return seen.length > 0 ? Math.round(seen.reduce((a, s) => a + s!.avg, 0) / seen.length) : undefined
}

export const pairCost = (
  id: string | undefined,
  takesEffort: boolean | undefined,
  effort: Effort,
  current: Step | undefined,
  evidence: Evidence,
  stats: OutputStats,
  config: CostConfig,
): PairCost => {
  if (!id) return { stays: false }
  // An effort change rebuilds the cache as a switch does; an unknown current
  // effort, or a model that takes none, does not count as one.
  const stays = id === current?.model && (takesEffort === false || current.effort === undefined || current.effort === effort)
  const price = priceFor(id, evidence.contextTokens ?? 0)
  const horizon = Math.max(1, Math.floor(config.horizon))
  const context = contextCost(id, stays ? id : undefined, evidence)
  // Staying with the cache state unknown is taken as a warm read.
  const first = context ? (stays ? context.next_request_usd ?? context.cached_read_usd : context.rebuild_usd) : undefined
  const contextUsd = context && first !== undefined ? usd(first + (horizon - 1) * context.cached_read_usd) : undefined
  const tokens = takesEffort === false ? anyOutput(stats) : outputEstimate(stats, effort, config.ratios)
  const outputUsd = price && tokens !== undefined ? usd((horizon * tokens * price.output) / 1000000) : undefined
  return {
    usd: contextUsd !== undefined ? usd(contextUsd + (outputUsd ?? 0)) : undefined,
    context_usd: contextUsd,
    output_usd: outputUsd,
    output_tokens: tokens,
    stays,
    rank: price?.output,
  }
}
