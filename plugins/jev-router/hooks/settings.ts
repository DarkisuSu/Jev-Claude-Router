// Pure settings resolution. Each setting has one home: the settings page
// (the plugin's userConfig) for the ones people change, or $.store, set with
// /jev-model set, for the rest. A value is read from its home alone.
import { DEFAULT_EFFORT_LEVELS, DEFAULT_MODEL_CRITERIA } from './questions'
import type { CacheConfig } from './cache'
import type { CostConfig } from './cost'
import type { AwarenessConfig } from './awareness'

export type Spec = {
  where: 'page' | 'store'
  kind: 'text' | 'number' | 'choice' | 'boolean'
  default: string | number | boolean
  min?: number
  max?: number
  integer?: boolean
  options?: readonly string[]
  what: string
}

export const SHARED: Record<string, Spec> = {
  // On the settings page.
  feasibility_threshold: { where: 'page', kind: 'number', default: 0.6, min: 0, max: 1, what: 'A tier at an effort counts as able to do the work when Jev judges it at least this likely to complete it; the cheapest such pair runs' },
  jev_context_enabled: { where: 'page', kind: 'boolean', default: true, what: 'Send Jev short excerpts of recent conversation so follow-ups are judged in context' },

  // In $.store, set with /jev-model set.
  model_haiku: { where: 'store', kind: 'text', default: DEFAULT_MODEL_CRITERIA.haiku!, what: 'What Jev is told Haiku work is' },
  model_sonnet: { where: 'store', kind: 'text', default: DEFAULT_MODEL_CRITERIA.sonnet!, what: 'What Jev is told Sonnet work is' },
  model_opus: { where: 'store', kind: 'text', default: DEFAULT_MODEL_CRITERIA.opus!, what: 'What Jev is told Opus work is' },
  effort_low: { where: 'store', kind: 'text', default: DEFAULT_EFFORT_LEVELS[0], what: 'What Jev is told low effort means' },
  effort_medium: { where: 'store', kind: 'text', default: DEFAULT_EFFORT_LEVELS[1], what: 'What Jev is told medium effort means' },
  effort_high: { where: 'store', kind: 'text', default: DEFAULT_EFFORT_LEVELS[2], what: 'What Jev is told high effort means' },
  cache_min_tokens: { where: 'store', kind: 'number', default: 20000, min: 0, max: 10000000, integer: true, what: 'Context size from which a well-read cache is labelled hot in the logs' },
  cache_min_hit_ratio: { where: 'store', kind: 'number', default: 0.8, min: 0, max: 1, what: 'Share of input read from cache from which the cache is labelled hot' },
  cache_ttl: { where: 'store', kind: 'choice', default: 'auto', options: ['auto', '5m', '1h'], what: 'Cache lifetime assumed in costs (auto: what responses show, else 1h on a subscription, else 5m); changes no request' },
  cost_horizon: { where: 'store', kind: 'number', default: 5, min: 1, max: 100, integer: true, what: 'Requests each tier and effort is costed over: the first (a cache rebuild on a switch) plus the later ones' },
  effort_output_low: { where: 'store', kind: 'number', default: 1, min: 0.01, max: 100, what: 'Relative output per request at low effort, until output at that effort is seen' },
  effort_output_medium: { where: 'store', kind: 'number', default: 2, min: 0.01, max: 100, what: 'Relative output per request at medium effort, until output at that effort is seen' },
  effort_output_high: { where: 'store', kind: 'number', default: 4, min: 0.01, max: 100, what: 'Relative output per request at high effort, until output at that effort is seen' },
  auto_probe: { where: 'store', kind: 'boolean', default: true, what: 'Probe models automatically: on first use (no learned ids on this Claude Code) and after a routed request fails' },
  jev_context_chars: { where: 'store', kind: 'number', default: 2000, min: 0, max: 8000, integer: true, what: 'Most characters of recent conversation sent to Jev; 0 sends none' },
  jev_context_messages: { where: 'store', kind: 'number', default: 6, min: 1, max: 12, integer: true, what: 'Most recent user/assistant messages those excerpts come from' },
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().length <= 500 ? v.trim() : undefined)

const valid = (spec: Spec, v: unknown): string | number | boolean | undefined => {
  if (spec.kind === 'text') return text(v)
  if (spec.kind === 'choice') return typeof v === 'string' && spec.options?.includes(v) ? v : undefined
  if (spec.kind === 'boolean') return typeof v === 'boolean' ? v : undefined
  return typeof v === 'number' && Number.isFinite(v) && v >= spec.min! && v <= spec.max! && (!spec.integer || Number.isInteger(v)) ? v : undefined
}

// The value from the setting's own home, or its default.
export const settingValue = (page: Record<string, unknown>, name: string, store: Record<string, unknown> = {}): string | number | boolean => {
  const spec = SHARED[name]!
  return valid(spec, spec.where === 'page' ? page[name] : store[name]) ?? spec.default
}

export const parseSetting = (name: string, raw: string): string | number | boolean | undefined => {
  const spec = SHARED[name]
  if (!spec) return undefined
  if (spec.kind === 'text') return text(raw)
  if (spec.kind === 'choice') return spec.options?.includes(raw.trim()) ? raw.trim() : undefined
  if (spec.kind === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : undefined
  return raw.trim() ? valid(spec, Number(raw)) : undefined
}

export const sharedConfig = (page: Record<string, unknown>, store: Record<string, unknown> = {}) => {
  const v = (name: string) => settingValue(page, name, store)
  return {
    feasibleThreshold: v('feasibility_threshold') as number,
    autoProbe: v('auto_probe') as boolean,
    modelDescriptions: Object.fromEntries(['haiku', 'sonnet', 'opus'].map(f => [f, String(v(`model_${f}`))])),
    effortLevels: ['low', 'medium', 'high'].map(f => String(v(`effort_${f}`))) as [string, string, string],
    cache: {
      minTokens: v('cache_min_tokens'),
      minHitRatio: v('cache_min_hit_ratio'),
      ttl: v('cache_ttl'),
      breakevenTurns: v('cost_horizon'),
    } as CacheConfig,
    cost: {
      horizon: v('cost_horizon'),
      ratios: { low: v('effort_output_low'), medium: v('effort_output_medium'), high: v('effort_output_high') },
    } as CostConfig,
    awareness: {
      enabled: v('jev_context_enabled'),
      maxChars: v('jev_context_chars'),
      messages: v('jev_context_messages'),
    } as AwarenessConfig,
  }
}
