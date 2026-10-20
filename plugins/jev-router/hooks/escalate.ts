// Escalating in the middle of a turn when the work goes wrong. Jev chooses the
// model and effort once, when the prompt is sent; this watches the tool calls
// of the turn and, on signs of trouble, steps the pair up one rung for the
// steps that follow. Pure: no `$`, so tests drive it directly.
import { EFFORTS, FAMILIES, familyOf, isEffort, type Caps, type Family } from './model'

// What the person sees from tools that change things or run them. A failed
// Read or Grep is ordinary searching, so it is not a sign of trouble.
const WORK_TOOLS = new Set(['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

export type Signals = {
  // Failed work calls in a row; any work call that succeeds ends the run.
  consecutive: number
  // Failures of the same call (tool and command or file), by that key.
  repeats: Record<string, number>
  // Successful edits of the same file, by path.
  edits: Record<string, number>
  // Escalations already made this turn.
  escalations: number
}

export const emptySignals = (): Signals => ({ consecutive: 0, repeats: {}, edits: {}, escalations: 0 })

export type Thresholds = { failures: number; repeats: number; edits: number; max: number }

export type Call = { tool: string; input: Record<string, unknown>; isError: boolean; denied: boolean }

const text = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : '')

// What a call acted on: the command or the file.
const targetOf = (input: Record<string, unknown>) => text(input.command) || text(input.file_path) || text(input.notebook_path) || text(input.path)

export const noteCall = (signals: Signals, call: Call): Signals => {
  // A refused call is the person's choice, not the work failing.
  if (!WORK_TOOLS.has(call.tool) || call.denied) return signals
  const target = targetOf(call.input)
  if (call.isError) {
    const key = `${call.tool}:${target}`
    return { ...signals, consecutive: signals.consecutive + 1, repeats: { ...signals.repeats, [key]: (signals.repeats[key] ?? 0) + 1 } }
  }
  const edits = EDIT_TOOLS.has(call.tool) && target ? { ...signals.edits, [target]: (signals.edits[target] ?? 0) + 1 } : signals.edits
  return { ...signals, consecutive: 0, edits }
}

export type Trigger = 'failures' | 'repeat-failure' | 'edits'

// The sign of trouble the signals now show, if any; none once the turn has
// escalated as often as allowed.
export const triggered = (signals: Signals, limits: Thresholds): Trigger | undefined => {
  if (signals.escalations >= limits.max) return undefined
  if (signals.consecutive >= limits.failures) return 'failures'
  if (Object.values(signals.repeats).some(n => n >= limits.repeats)) return 'repeat-failure'
  if (Object.values(signals.edits).some(n => n >= limits.edits)) return 'edits'
  return undefined
}

// After an escalation the evidence starts over: the next one needs new trouble.
export const afterEscalation = (signals: Signals): Signals => ({ ...emptySignals(), escalations: signals.escalations + 1 })

export type Pair = { model: string; effort?: string | number }
export type Rung = { pair: Pair; kind: 'effort' | 'model' }

// The level a switch to a larger family starts at.
const MODEL_STEP_EFFORT = 'high'

// One rung up from the pair: the next effort level while the model takes
// effort, then the next family (a switch only to a family seen answering with
// its full id, as for Jev's own choice). None at the top.
export const nextRung = (current: Pair, caps: Caps | undefined, failed: ReadonlySet<Family>): Rung | undefined => {
  const family = familyOf(current.model)
  const known = family ? caps?.families[family] : undefined
  if (isEffort(current.effort) && known?.effort !== false) {
    const at = EFFORTS.indexOf(current.effort)
    if (at < EFFORTS.length - 1) return { pair: { model: current.model, effort: EFFORTS[at + 1] }, kind: 'effort' }
  }
  const larger = family ? FAMILIES[FAMILIES.indexOf(family) + 1] : undefined
  if (!larger || failed.has(larger)) return undefined
  const target = caps?.families[larger]
  if (!target?.id || !target.ok || target.effort === undefined) return undefined
  return { pair: { model: target.id, effort: target.effort ? MODEL_STEP_EFFORT : undefined }, kind: 'model' }
}

const rank = (model: string) => {
  const family = familyOf(model)
  return family ? FAMILIES.indexOf(family) : -1
}

// The pair a step goes with once an escalation set a floor: never lower than
// the plan in family or in effort.
export const raise = (plan: Pair, floor: Pair | undefined): Pair => {
  if (!floor) return plan
  const up = rank(floor.model) > rank(plan.model)
  const model = up ? floor.model : plan.model
  let effort = plan.effort
  if (isEffort(floor.effort)) {
    if (!isEffort(plan.effort) || EFFORTS.indexOf(floor.effort) > EFFORTS.indexOf(plan.effort) || up) effort = floor.effort
  }
  return { model, effort }
}
