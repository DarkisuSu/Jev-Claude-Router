// Model routing policy, pure: which model and effort one main-loop request
// is sent with. register.ts supplies the facts (`$` is used there alone).

export const FAMILIES = ['haiku', 'sonnet', 'opus'] as const
export type Family = (typeof FAMILIES)[number]

// Only these effort levels are ever sent; xhigh and max are left alone.
export const EFFORTS = ['low', 'medium', 'high'] as const
export type Effort = (typeof EFFORTS)[number]

export type RoutingMode = 'off' | 'dry-run' | 'on'

// The model a step goes to when Jev gives no confident choice.
export type Fallback = 'session' | Family

// Variants that change billing or behaviour are never routed to.
const SPECIAL = /\[|1m|fast|plan|default/i

export const familyOf = (model: string | undefined): Family | undefined => {
  if (!model) return undefined
  const m = model.toLowerCase()
  return FAMILIES.find(f => m.includes(f))
}

type RowLike = { key: string; label: string; kind: string; value: unknown; options?: readonly string[] }

export type Available = {
  // The model string sent for each family, as this Claude Code lists it.
  models: Partial<Record<Family, string>>
  source: string
  // What the list held, for /jev-model models.
  raw: readonly string[]
}

// The models come from this build's own /config Model row, never a list of
// ours: an update that adds or renames one is picked up as it is.
export const availableFrom = (rows: readonly RowLike[]): Available => {
  const row =
    rows.find(r => r.key.toLowerCase() === 'model') ??
    rows.find(r => r.kind === 'choice' && /^model$/i.test(r.label.trim()))
  if (!row) return { models: {}, source: 'no-model-row', raw: [] }
  const raw = [...(row.options ?? [])]
  const models: Partial<Record<Family, string>> = {}
  for (const family of FAMILIES) {
    const plain = raw.filter(o => familyOf(o) === family && !SPECIAL.test(o))
    // The bare alias when listed, else the first plain entry of the family.
    const pick = plain.find(o => o.toLowerCase() === family) ?? plain[0]
    if (pick) models[family] = pick
  }
  return { models, source: `config:${row.key}`, raw }
}

// Jev's judgment, per tier and effort, that the pair can complete the work.
export type Feasible = Partial<Record<Family, Partial<Record<Effort, number>>>>

// One tier at one effort: Jev's feasibility and the router's cost for it.
// `usd` is the estimated API-equivalent cost over the horizon (unknown when
// no price or context is known); `rank` orders unknown costs by list price.
export type Candidate = { family: Family; effort: Effort; feasible: number; usd?: number; rank?: number }

export type Decision = {
  round: string
  family?: Family
  effort?: Effort
  // Why no tier was taken from Jev: 'no-jev-answer' or 'none-routable'.
  modelReason?: string
  effortReason?: string
  feasible?: Feasible
  feasibleThreshold?: number
  // 'cheapest-feasible', or 'none-feasible-most-capable' when no pair clears
  // the threshold.
  how?: string
  usd?: number
  // Every pair costed, cheapest first.
  candidates?: Candidate[]
}

// Cheaper first: a known cost before an unknown one, then the list price,
// then the lower tier and the lower effort.
const cheaper = (a: Candidate, b: Candidate) => {
  if (a.usd !== undefined && b.usd !== undefined && a.usd !== b.usd) return a.usd - b.usd
  if ((a.usd === undefined) !== (b.usd === undefined)) return a.usd === undefined ? 1 : -1
  if (a.rank !== undefined && b.rank !== undefined && a.rank !== b.rank) return a.rank - b.rank
  if ((a.rank === undefined) !== (b.rank === undefined)) return a.rank === undefined ? 1 : -1
  return FAMILIES.indexOf(a.family) - FAMILIES.indexOf(b.family) || EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort)
}

// Jev judges whether each tier at each effort can do the work; the router
// costs each pair and takes the cheapest Jev judges feasible. With none
// feasible, the pair Jev judges most able (the cheaper of equals).
export const decide = (
  round: string,
  feasible: Feasible | undefined,
  routable: readonly Family[],
  cost: (family: Family, effort: Effort) => { usd?: number; rank?: number },
  threshold: number,
): Decision => {
  const d: Decision = { round, feasible, feasibleThreshold: threshold }
  const candidates: Candidate[] = []
  for (const family of routable) {
    for (const effort of EFFORTS) {
      const p = feasible?.[family]?.[effort]
      if (p !== undefined) candidates.push({ family, effort, feasible: p, ...cost(family, effort) })
    }
  }
  if (candidates.length === 0) {
    d.modelReason = d.effortReason = feasible && Object.keys(feasible).length > 0 ? 'none-routable' : 'no-jev-answer'
    return d
  }
  const sorted = [...candidates].sort(cheaper)
  const able = sorted.filter(c => c.feasible >= threshold)
  const pick = able[0] ?? [...sorted].sort((a, b) => b.feasible - a.feasible)[0]!
  d.how = able.length > 0 ? 'cheapest-feasible' : 'none-feasible-most-capable'
  d.family = pick.family
  d.effort = pick.effort
  d.usd = pick.usd
  d.candidates = sorted
  return d
}

// What this Claude Code version is known to do with each family, learned
// from the engine itself: a step's resolved `model` and whether it carried
// `effort`, a subagent's resolved model, a /model switch's `to_model`.
export type FamilyCaps = {
  // The full id the engine resolved the family's alias to.
  id?: string
  // A response came back on that id.
  ok?: boolean
  // Whether a step on that id carried effort (the model takes effort).
  effort?: boolean
  // The largest context (input + cache read + cache write tokens) a response
  // on that id came back over: evidence of what it can hold, never a limit.
  maxContext?: number
  source?: string
  at: string
}
export type Caps = { version: string; families: Partial<Record<Family, FamilyCaps>>; retryOk?: boolean }

export type Step = { model: string; effort?: string | number; agentId?: string }

export type Plan = {
  model: string
  effort?: string | number
  changed: boolean
  // Why the step goes as the engine resolved it, wholly or in part.
  reasons: string[]
  // What Jev's decision would send, shown in dry-run.
  wouldModel?: string
  wouldEffort?: string
}

export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)

// Learns from one step the engine resolved: the family's full id and whether
// it takes effort. A bare alias is never recorded as an id.
export const learn = (
  caps: Caps,
  step: Step,
  answered: boolean,
  source: string,
  at: string,
): Caps | undefined => {
  const family = familyOf(step.model)
  if (!family || step.model.toLowerCase() === family) return undefined
  const before = caps.families[family]
  const next: FamilyCaps = {
    id: step.model,
    ok: answered || (before?.id === step.model && before.ok === true),
    effort: answered ? step.effort !== undefined : before?.id === step.model ? before.effort : undefined,
    ...(before?.id === step.model && before.maxContext !== undefined ? { maxContext: before.maxContext } : {}),
    source,
    at,
  }
  if (before && before.id === next.id && before.ok === next.ok && before.effort === next.effort) return undefined
  return { ...caps, families: { ...caps.families, [family]: next } }
}

// Raises the largest context a model id has answered over. Returns undefined
// when nothing grew, so the store is written only on news.
export const noteContext = (caps: Caps, model: string, tokens: number | undefined): Caps | undefined => {
  const family = familyOf(model)
  if (!family || tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return undefined
  const before = caps.families[family]
  if (!before || before.id !== model || (before.maxContext ?? 0) >= tokens) return undefined
  return { ...caps, families: { ...caps.families, [family]: { ...before, maxContext: tokens } } }
}

export const planStep = (
  step: Step,
  decision: Decision | undefined,
  mode: RoutingMode,
  caps: Caps | undefined,
  failed: ReadonlySet<Family>,
  fallback: Fallback = 'session',
): Plan => {
  const keep: Plan = { model: step.model, effort: step.effort, changed: false, reasons: [] }
  if (step.agentId !== undefined) return { ...keep, reasons: ['subagent'] }
  if (mode === 'off') return { ...keep, reasons: ['mode-off'] }
  if (!decision) return { ...keep, reasons: ['no-decision'] }

  const reasons: string[] = []
  const current = familyOf(step.model)
  let model = step.model
  let target: FamilyCaps | undefined

  // No Jev answer: the fallback model stands in, 'session' being the model
  // the person chose.
  const useFallback = !decision.family && fallback !== 'session'
  const wanted = decision.family ?? (useFallback ? (fallback as Family) : undefined)

  if (!wanted) reasons.push(`model:${decision.modelReason ?? 'none'}`)
  else if (useFallback) reasons.push(`model:fallback-${wanted} (${decision.modelReason})`)
  else if (decision.how === 'none-feasible-most-capable') reasons.push(`model:${decision.how}`)
  if (!wanted) {
    // nothing to switch to
  } else if (wanted === current) reasons.push('model:same-family')
  else if (failed.has(wanted)) reasons.push('model:failed-this-session')
  else {
    const known = caps?.families[wanted]
    // Only a full id the engine resolved, seen answering, with known effort
    // support: the engine refuses a bare alias at this point.
    if (!known?.id) reasons.push('model:id-not-learned')
    else if (!known.ok) reasons.push('model:not-seen-answering')
    else if (known.effort === undefined) reasons.push('model:effort-support-unknown')
    else {
      target = known
      model = known.id
    }
  }

  let effort = step.effort
  if (target && !target.effort) {
    // The target takes no effort: none is sent.
    effort = undefined
    reasons.push('effort:target-has-none')
  } else if (!decision.effort) {
    reasons.push(`effort:${decision.effortReason ?? 'none'}`)
    // A level the target may not know is not carried over to it.
    if (target && !isEffort(step.effort)) effort = undefined
  } else if (!target && step.effort === undefined) reasons.push('effort:model-has-none')
  else if (step.effort === decision.effort) reasons.push('effort:same')
  else effort = decision.effort

  const would = { wouldModel: target ? model : undefined, wouldEffort: effort !== step.effort ? String(effort) : undefined }
  if (mode === 'dry-run') return { ...keep, ...would, reasons: ['dry-run', ...reasons] }
  return { model, effort, changed: model !== step.model || effort !== step.effort, reasons, ...would }
}
