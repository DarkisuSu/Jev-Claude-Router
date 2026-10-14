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

export type ModelAnswer = { choice: string; confidence: number; probabilities: Record<string, number> }
export type EffortAnswer = { score: number; confidence: number; probabilities?: Record<string, number> }

export type Decision = {
  round: string
  family?: Family
  modelConfidence?: number
  effort?: Effort
  effortConfidence?: number
  // Why no family or effort was taken from Jev.
  modelReason?: string
  effortReason?: string
}

// The question's confidence is the gate; past it, the highest probability
// decides: the most likely tier, the most likely effort level.
export const decide = (
  round: string,
  model: ModelAnswer | undefined,
  effort: EffortAnswer | undefined,
  available: Available,
  threshold: { model: number; effort: number },
): Decision => {
  const d: Decision = { round }
  if (!model) d.modelReason = 'no-jev-answer'
  else {
    d.modelConfidence = model.confidence
    const ranked = Object.entries(model.probabilities)
      .filter(([name]) => {
        const f = familyOf(name)
        return f !== undefined && available.models[f] !== undefined
      })
      .sort((a, b) => b[1] - a[1])
    const top = familyOf(ranked[0]?.[0])
    if (!top) d.modelReason = 'not-available'
    else if (model.confidence < threshold.model) d.modelReason = 'low-confidence'
    else d.family = top
  }
  if (!effort) d.effortReason = 'no-jev-answer'
  else {
    d.effortConfidence = effort.confidence
    if (effort.confidence < threshold.effort) d.effortReason = 'low-confidence'
    else {
      const levels = Object.entries(effort.probabilities ?? {})
        .map(([k, p]) => [Number(k), p] as const)
        .filter(([k]) => Number.isInteger(k) && k >= 0 && k < EFFORTS.length)
        .sort((a, b) => b[1] - a[1])
      // The most likely level; the rounded score only where no level was given.
      const index = levels[0]?.[0] ?? Math.round(effort.score)
      d.effort = EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, index))]
    }
  }
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

const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)

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
    source,
    at,
  }
  if (before && before.id === next.id && before.ok === next.ok && before.effort === next.effort) return undefined
  return { ...caps, families: { ...caps.families, [family]: next } }
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

  // No confident Jev choice: the fallback model stands in, 'session' being
  // the model the person chose.
  const unconfident = decision.modelReason === 'low-confidence' || decision.modelReason === 'no-jev-answer'
  const useFallback = !decision.family && unconfident && fallback !== 'session'
  const wanted = decision.family ?? (useFallback ? (fallback as Family) : undefined)

  if (!wanted) reasons.push(`model:${decision.modelReason ?? 'none'}`)
  else if (useFallback) reasons.push(`model:fallback-${wanted} (${decision.modelReason})`)
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
