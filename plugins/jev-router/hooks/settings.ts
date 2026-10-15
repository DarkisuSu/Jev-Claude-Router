// Pure settings resolution. Each setting has one home: the settings page
// (the plugin's userConfig) for the ones people change, or $.store, set with
// /jev-model set, for the rest. A value is read from its home alone.
import { DEFAULT_EFFORT_LEVELS, DEFAULT_MODEL_CRITERIA } from './questions'
import { EFFORTS, type Effort } from './model'
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
  chat_notice: { where: 'page', kind: 'boolean', default: true, what: 'Add a line to the conversation, which you see and the model does not read, saying what Jev chose for each message (model and effort, skill, saved tool)' },
  skill_trim_hint: { where: 'page', kind: 'boolean', default: true, what: 'At each session start, say so when a project skill still sends its full description to Claude, and which command (/jev-skills hide all) sends names only; nothing is written' },
  tool_routing: { where: 'page', kind: 'boolean', default: true, what: 'Jev suggests a saved tool (a script an assistant wrote for earlier work) when a request looks like work it already did' },
  tool_save: { where: 'page', kind: 'boolean', default: true, what: 'Let Claude save tools it writes for repeatable work, with save_tool' },
  tool_threshold: { where: 'page', kind: 'number', default: 0.5, min: 0, max: 1, what: 'The best-fitting saved tool is suggested when Jev puts at least this probability on one of them doing what the request asks (a yes/no question over the saved tools)' },
  tool_save_threshold: { where: 'page', kind: 'number', default: 0.5, min: 0, max: 1, what: 'A tool is saved when Jev judges at least this likely that it serves other work; 0 saves without asking Jev' },
  decision_routing: { where: 'page', kind: 'boolean', default: true, what: 'Let Claude automatically submit assistant-owned typed decisions to Jev throughout a task' },

  // In $.store, set with /jev-model set.
  model_haiku: { where: 'store', kind: 'text', default: DEFAULT_MODEL_CRITERIA.haiku!, what: 'What Jev is told Haiku work is' },
  model_sonnet: { where: 'store', kind: 'text', default: DEFAULT_MODEL_CRITERIA.sonnet!, what: 'What Jev is told Sonnet work is' },
  model_opus: { where: 'store', kind: 'text', default: DEFAULT_MODEL_CRITERIA.opus!, what: 'What Jev is told Opus work is' },
  ...Object.fromEntries(EFFORTS.map(e => [`effort_${e}`, { where: 'store', kind: 'text', default: DEFAULT_EFFORT_LEVELS[e], what: `What Jev is told ${e} effort means` } satisfies Spec])),
  cache_min_tokens: { where: 'store', kind: 'number', default: 20000, min: 0, max: 10000000, integer: true, what: 'Context size from which a well-read cache is labelled hot in the logs' },
  cache_min_hit_ratio: { where: 'store', kind: 'number', default: 0.8, min: 0, max: 1, what: 'Share of input read from cache from which the cache is labelled hot' },
  cache_ttl: { where: 'store', kind: 'choice', default: 'auto', options: ['auto', '5m', '1h'], what: 'Cache lifetime assumed in costs (auto: what responses show, else 1h on a subscription, else 5m); changes no request' },
  cost_horizon: { where: 'store', kind: 'number', default: 0, min: 0, max: 100, integer: true, what: 'Requests each pair is costed over: the first (a cache rebuild on a model switch) plus the later ones. 0: the median requests per turn of recent turns (5 until three turns are seen)' },
  cost_tolerance: { where: 'store', kind: 'number', default: 0.03, min: 0, max: 0.5, what: 'Feasible pairs costing within this share of the cheapest compete on feasibility: the likeliest runs. 0: the cheapest always runs' },
  tool_max: { where: 'store', kind: 'number', default: 50, min: 1, max: 200, integer: true, what: 'Most saved tools per scope (project, global); past it the least recently used is dropped' },
  probe_wait_ms: { where: 'store', kind: 'number', default: 20000, min: 0, max: 120000, integer: true, what: 'Longest the first message waits for a model probe to finish before it goes on; 0 does not wait' },
  tier_monotonic: { where: 'store', kind: 'boolean', default: true, what: 'A bigger tier is never rated below a smaller one at the same effort: what Sonnet can do Opus can too, and what Haiku can do Sonnet can (Jev rates each tier alone; cost is judged apart). Off: Jev\'s ratings are used as given' },
  auto_probe: { where: 'store', kind: 'boolean', default: true, what: 'Probe models automatically: on first use (no learned ids on this Claude Code) and after a routed request fails' },
  decision_confidence_threshold: { where: 'store', kind: 'number', default: 0.6, min: 0.5, max: 1, what: 'Decision answers below this are uncertain: Choice/Score confidence, or Noul probability of the likelier yes/no outcome' },
  jev_context_chars: { where: 'store', kind: 'number', default: 12000, min: 0, max: 20000, integer: true, what: 'Most characters of recent conversation sent to Jev (also held to what the request leaves of a 24000-character state budget); 0 sends none' },
  jev_context_messages: { where: 'store', kind: 'number', default: 16, min: 1, max: 40, integer: true, what: 'Most recent user/assistant messages those excerpts come from' },
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
    tools: {
      routing: v('tool_routing') as boolean,
      save: v('tool_save') as boolean,
      threshold: v('tool_threshold') as number,
      saveThreshold: v('tool_save_threshold') as number,
      max: v('tool_max') as number,
    },
    chatNotice: v('chat_notice') as boolean,
    skillTrimHint: v('skill_trim_hint') as boolean,
    probeWaitMs: v('probe_wait_ms') as number,
    decisionRouting: v('decision_routing') as boolean,
    decisionConfidence: v('decision_confidence_threshold') as number,
    feasibleThreshold: v('feasibility_threshold') as number,
    autoProbe: v('auto_probe') as boolean,
    tierMonotonic: v('tier_monotonic') as boolean,
    modelDescriptions: Object.fromEntries(['haiku', 'sonnet', 'opus'].map(f => [f, String(v(`model_${f}`))])),
    effortLevels: Object.fromEntries(EFFORTS.map(e => [e, String(v(`effort_${e}`))])) as Record<Effort, string>,
    cache: {
      minTokens: v('cache_min_tokens'),
      minHitRatio: v('cache_min_hit_ratio'),
      ttl: v('cache_ttl'),
      breakevenTurns: Number(v('cost_horizon')) || 5,
    } as CacheConfig,
    cost: {
      horizon: v('cost_horizon'),
      tolerance: v('cost_tolerance'),
    } as CostConfig,
    awareness: {
      enabled: v('jev_context_enabled'),
      maxChars: v('jev_context_chars'),
      messages: v('jev_context_messages'),
    } as AwarenessConfig,
  }
}
