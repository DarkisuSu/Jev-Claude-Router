// The two-request routing core, kept free of `$` so tests drive it directly.

import {
  effortQuestion,
  EXCERPT_CHARS,
  GATE_QUESTIONS,
  INVERTED_GATES,
  MAX_CHOICE_OPTIONS,
  RANK_WIDE_INSTRUCTIONS,
  RERANK_INSTRUCTIONS,
  fitsQuestion,
  modelQuestion,
  type Questions,
} from './questions'

export type Skill = {
  // The name it is invoked by: `speckit-plan`, `typesafe:typesafe-ai`.
  name: string
  // One-line index description, already cut to size.
  description: string
  // The full description and the start of SKILL.md, when the file was found.
  descriptionFull?: string
  body?: string
}

export type RouteConfig = {
  model: string
  gateThreshold: number
  fitsThreshold: number
  shortlist: number
  // Model families to ask Jev about; none, and model routing is not asked.
  modelFamilies: readonly string[]
  // The three effort level descriptions, low to high; absent, the defaults.
  effortLevels?: readonly [string, string, string]
}

// One HTTP exchange with Jev; `send` resolves or throws, never hangs past the
// caller's deadline (the caller races it).
export type Send = (body: string) => Promise<{ status: number; text: string }>

export type CallRecord = {
  step: 'rank_wide' | 'rerank'
  status: number
  ms: number
  model?: string
  inputTokens?: number
  outputTokens?: number
}

export type RouteResult = {
  outcome: 'selected' | 'no-match' | 'error'
  selected: { name: string; fits: number; probability: number }[]
  gate?: { score: number; parts: Record<string, number> }
  shortlist?: { name: string; probability: number }[]
  rerankConfidence?: number
  fits?: Record<string, number>
  reason?: string
  modelAnswer?: { choice: string; confidence: number; probabilities: Record<string, number> }
  effortAnswer?: { score: number; confidence: number; probabilities: Record<string, number> }
  calls: CallRecord[]
}

type NoulAnswer = { type: 'noul'; noul: number }
type ChoiceAnswer = {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}
type ScoreAnswer = { type: 'score'; score: number; confidence: number; probabilities?: Record<string, number> }
type JevResponse = {
  model?: string
  answers: Record<string, NoulAnswer | ChoiceAnswer | ScoreAnswer>
  usage?: { input_tokens?: number; output_tokens?: number }
}

export class JevError extends Error {
  constructor(
    readonly kind: 'http' | 'parse' | 'timeout' | 'network',
    readonly status?: number,
  ) {
    super(status === undefined ? `jev ${kind}` : `jev ${kind} ${status}`)
  }
}

const state = (request: string) => ({ request, recent_context: '' })

export const rankWideBody = (request: string, skills: readonly Skill[], config: RouteConfig) => {
  const questions: Questions = {}
  if (skills.length > 0) {
    const criteria: Record<string, string> = {}
    for (const skill of skills.slice(0, MAX_CHOICE_OPTIONS)) criteria[skill.name] = skill.description
    questions.which = { type: 'choice', instructions: RANK_WIDE_INSTRUCTIONS, criteria }
    Object.assign(questions, GATE_QUESTIONS)
  }
  if (config.modelFamilies.length >= 2) {
    questions.model_tier = modelQuestion(config.modelFamilies)
    questions.effort_level = effortQuestion(config.effortLevels)
  }
  return { state: state(request), model: config.model, questions }
}

const rerankText = (skill: Skill) => {
  const full = skill.descriptionFull ?? skill.description
  return skill.body ? `${full} — ${skill.body.slice(0, EXCERPT_CHARS)}` : full
}

export const rerankBody = (request: string, shortlist: readonly Skill[], model: string) => {
  const criteria: Record<string, string> = {}
  const questions: Questions = {}
  for (const skill of shortlist) {
    criteria[skill.name] = rerankText(skill)
    questions[`fits::${skill.name}`] = fitsQuestion(skill.name, rerankText(skill))
  }
  questions.which = { type: 'choice', instructions: RERANK_INSTRUCTIONS, criteria }
  return { state: state(request), model, questions }
}

const ask = async (
  send: Send,
  now: () => Promise<number>,
  step: CallRecord['step'],
  body: unknown,
  calls: CallRecord[],
): Promise<JevResponse> => {
  const started = await now()
  const res = await send(JSON.stringify(body))
  const record: CallRecord = { step, status: res.status, ms: (await now()) - started }
  calls.push(record)
  if (res.status < 200 || res.status >= 300) throw new JevError('http', res.status)
  let parsed: JevResponse
  try {
    parsed = JSON.parse(res.text) as JevResponse
  } catch {
    throw new JevError('parse', res.status)
  }
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.answers !== 'object') {
    throw new JevError('parse', res.status)
  }
  record.model = parsed.model
  record.inputTokens = parsed.usage?.input_tokens
  record.outputTokens = parsed.usage?.output_tokens
  return parsed
}

const noul = (r: JevResponse, id: string): number => {
  const a = r.answers[id]
  if (a?.type !== 'noul' || typeof a.noul !== 'number') throw new JevError('parse')
  return a.noul
}

const choice = (r: JevResponse, id: string): ChoiceAnswer => {
  const a = r.answers[id]
  if (a?.type !== 'choice' || typeof a.probabilities !== 'object') throw new JevError('parse')
  return a
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

// Model answers are optional: a malformed one is dropped, never an error.
const modelAnswers = (r: JevResponse): Pick<RouteResult, 'modelAnswer' | 'effortAnswer'> => {
  const out: Pick<RouteResult, 'modelAnswer' | 'effortAnswer'> = {}
  const m = r.answers.model_tier
  if (m?.type === 'choice' && typeof m.confidence === 'number') {
    out.modelAnswer = { choice: m.choice, confidence: round3(m.confidence), probabilities: m.probabilities }
  }
  const e = r.answers.effort_level
  if (e?.type === 'score' && typeof e.score === 'number' && typeof e.confidence === 'number') {
    out.effortAnswer = { score: round3(e.score), confidence: round3(e.confidence), probabilities: e.probabilities ?? {} }
  }
  return out
}

export const route = async (
  request: string,
  skills: readonly Skill[],
  config: RouteConfig,
  send: Send,
  now: () => Promise<number>,
): Promise<RouteResult> => {
  const calls: CallRecord[] = []
  const asksModel = config.modelFamilies.length >= 2
  if (skills.length === 0 && !asksModel) return { outcome: 'no-match', selected: [], reason: 'empty-index', calls }

  let models: Pick<RouteResult, 'modelAnswer' | 'effortAnswer'> = {}
  try {
    // Request 1: rank every skill, gate whether any is needed, and judge the
    // model tier and effort over the same state.
    const wide = await ask(send, now, 'rank_wide', rankWideBody(request, skills, config), calls)
    models = modelAnswers(wide)
    if (skills.length === 0) return { outcome: 'no-match', selected: [], reason: 'empty-index', calls, ...models }

    const parts: Record<string, number> = {}
    let sum = 0
    for (const id of Object.keys(GATE_QUESTIONS)) {
      const v = noul(wide, id)
      parts[id] = round3(v)
      sum += INVERTED_GATES.has(id) ? 1 - v : v
    }
    const gate = { score: round3(sum / Object.keys(GATE_QUESTIONS).length), parts }

    const ranked = Object.entries(choice(wide, 'which').probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, Math.floor(config.shortlist)))
    const shortlist = ranked.map(([name, p]) => ({ name, probability: round3(p) }))

    if (gate.score < config.gateThreshold) {
      return { outcome: 'no-match', selected: [], gate, shortlist, reason: 'gate', calls, ...models }
    }

    // Request 2: reread the shortlist with each skill's own text.
    const byName = new Map(skills.map(s => [s.name, s]))
    const candidates = shortlist.map(s => byName.get(s.name)).filter((s): s is Skill => s !== undefined)
    if (candidates.length === 0) {
      return { outcome: 'no-match', selected: [], gate, shortlist, reason: 'unknown-shortlist', calls, ...models }
    }
    const re = await ask(send, now, 'rerank', rerankBody(request, candidates, config.model), calls)
    const fits: Record<string, number> = {}
    for (const c of candidates) fits[c.name] = round3(noul(re, `fits::${c.name}`))
    const which = choice(re, 'which')
    const rerankConfidence = round3(which.confidence)

    // The fits threshold is the confidence cut-off: every skill that clears it
    // comes back usable, best first, with no count cap.
    const selected = Object.entries(fits)
      .filter(([, f]) => f >= config.fitsThreshold)
      .sort((a, b) => b[1] - a[1])
      .map(([name, f]) => ({ name, fits: f, probability: round3(which.probabilities[name] ?? 0) }))

    if (selected.length === 0) {
      return { outcome: 'no-match', selected, gate, shortlist, fits, rerankConfidence, reason: 'fits', calls, ...models }
    }
    return { outcome: 'selected', selected, gate, shortlist, fits, rerankConfidence, calls, ...models }
  } catch (err) {
    const reason = err instanceof JevError ? err.message : 'jev failure'
    return { outcome: 'error', selected: [], reason, calls, ...models }
  }
}
