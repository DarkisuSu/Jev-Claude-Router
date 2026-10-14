// Every Jev question and routing constant lives here, as the TypeSafe skill
// advises, so thresholds and wording are tuned in one place.
// Adapted from https://docs.typesafe.ai/cookbooks/skill_suggestion.

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

// How many ranked skills request 2 rereads by default (the cookbook's SHORTLIST).
export const SHORTLIST = 3
// How much of a SKILL.md body each shortlisted skill shows (EXCERPT_CHARS).
export const EXCERPT_CHARS = 700
// A Choice takes at most 255 options.
export const MAX_CHOICE_OPTIONS = 255
// Index descriptions are cut here so request 1 stays small.
export const INDEX_DESCRIPTION_CHARS = 300

export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] }

export type Questions = Record<string, Question>

// The three gate questions: does this request need a skill at all.
export const GATE_QUESTIONS: Questions = {
  acts_on_user_system: {
    type: 'noul',
    instructions:
      'Is the assistant being asked, in `request`, to act on the user\'s own files, code, accounts, devices or services, rather than only to explain something?',
  },
  would_follow_documented_procedure: {
    type: 'noul',
    instructions:
      'Would an expert handling `request` consult a documented procedure, workflow, checklist or specific commands before acting?',
  },
  prose_suffices: {
    type: 'noul',
    instructions:
      'Could a knowledgeable generalist fully answer `request` in prose, with no tools and no specialised procedure?',
  },
}

// prose_suffices counts against the gate.
export const INVERTED_GATES = new Set(['prose_suffices'])

export const RANK_WIDE_INSTRUCTIONS =
  'Which skill, if any, is the right one to load for the latest request in `request`? Each option is a skill and its description.'

export const RERANK_INSTRUCTIONS =
  'Exactly one of these skills is the right one to load for `request`. Read what each skill does and pick the one that does the specific thing the request asks for.'

// Model routing rides request 1 (same state), so it costs no extra call.
// The criteria describe the work, never "hard means opus": Jev judges fit.
const MODEL_CRITERIA: Record<string, string> = {
  haiku:
    'Quick, well-bounded work: a short factual answer, a lookup, a small mechanical edit, renaming, formatting, or running a known command. Little ambiguity and little cost if the first attempt is imperfect.',
  sonnet:
    'Everyday engineering: implementing or fixing a feature across a few files, writing tests, reviewing a change, explaining a codebase, or following a documented workflow. Needs care and context but not deep open-ended reasoning.',
  opus:
    'Work where judgment dominates: ambiguous or high-stakes design and architecture decisions, subtle debugging across many interacting parts, security-sensitive changes, long multi-step plans, or tasks where a wrong call is costly to undo.',
}

export const modelQuestion = (families: readonly string[]): Question => {
  const criteria: Record<string, string> = {}
  for (const f of families) criteria[f] = MODEL_CRITERIA[f] ?? f
  return {
    type: 'choice',
    instructions:
      'Which assistant tier best fits the work the latest request in `request` asks for? Judge the work itself, not how long or formal the request is.',
    criteria,
  }
}

// The three effort levels, low to high. Each is a concrete situation that
// stands on its own; the person can rewrite them in the plugin's settings.
export const DEFAULT_EFFORT_LEVELS: readonly [string, string, string] = [
  "Direct work: answer a clear question, look up a fact, or make one mechanical change (rename, reformat, swap a value). No approaches need comparing.",
  "Some context needed: read a few files or earlier results, then implement, fix or explain something whose approach is fairly clear.",
  "Open-ended work: compare several approaches, trace a problem's cause across parts, or make a decision whose mistakes are costly or hard to undo.",
]

export const effortQuestion = (levels: readonly [string, string, string] = DEFAULT_EFFORT_LEVELS): Question => ({
  type: 'score',
  instructions: 'How much deliberate reasoning does the work in `request` need before acting?',
  criteria: [...levels],
})

// One per shortlisted skill, scored independently, so all can be low.
export const fitsQuestion = (name: string, description: string): Question => ({
  type: 'noul',
  instructions: `Does the skill \`${name}\` do the specific thing that \`request\` asks for? The skill: ${description}`,
  criteria: {
    true: 'The skill does the specific thing the request asks for.',
    false: 'The skill does not do what the request asks for, or only touches it in passing.',
  },
})
