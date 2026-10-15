// The consult tool: in consult mode Claude asks Jev which skill or saved tool
// fits before starting, instead of receiving Jev's pick beside the prompt.
// Pure: no `$`, so tests drive it directly.

export const CONSULT_TOOL = 'mcp__jev-router__consult'
export const MAX_TASK = 400
export const SKILL_TEXT_CHARS = 20000
export const SKILL_TEXT_TOTAL = 40000

export const CONSULT_DESCRIPTION =
  'Ask Jev (TypeSafe) which skill or saved tool fits the work you are about to start. Pass one sentence saying what the task is. Jev knows the skills and saved tools and reads the recent conversation itself. It returns the picks with probabilities. Nothing is loaded or run by this call.'

export const CONSULT_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', minLength: 1, maxLength: MAX_TASK, description: 'One sentence: what the work you are about to start is.' },
  },
  required: ['task'],
  additionalProperties: false,
}

// The standing instructions. Claude is not given the skills or saved tools:
// it only knows every message goes to Jev first, and Jev names what fits.
export const consultInstructions = (routesModel: boolean): string =>
  [
    `Jev router: ${routesModel ? 'the model and effort of each turn, and ' : ''}the choice of a skill or a saved tool ${routesModel ? 'are' : 'is'} delegated to Jev (TypeSafe), not decided by you.`,
    `At the start of every user message, before anything else, call ${CONSULT_TOOL} with a one-sentence task. Call it again whenever the work changes and a different skill or saved tool might serve, including one that a skill's own instructions tell you to load. Jev answers with the skills and saved tools that fit, with probabilities, or says none does. Choose from what Jev returns: use the ones that fit the work, ignore the rest. A picked skill may come with its instructions in the answer: follow them as that skill and do not load it again with the Skill tool; one without instructions you load with the Skill tool. Read a picked tool's file before running it. A skill or saved tool that Jev has not returned is refused. Normal permission checks apply.`,
    'Use only a skill or a saved tool that Jev returned; do not pick one on your own. If Jev picks nothing, carry on with your own judgment. If Jev is unavailable, its answer lists the skills and saved tools for you to choose from yourself. When you start a subagent, tell it to call the consult tool before it uses any skill or saved tool.',
  ].join('\n')

export type ConsultResult = {
  status: 'picked' | 'nothing_fits' | 'unavailable' | 'invalid_request'
  reason?: string
  // With Jev unreachable: what Claude may choose from itself.
  fallback?: { note: string; skills: { name: string; description: string }[]; tools: { name: string; scope: string; description: string; usage: string; path: string }[] }
  // `instructions`: the skill's SKILL.md text, when the router delivers it, so the
  // skill need not be listed to Claude.
  skills?: { name: string; fits: number; probability: number; instructions?: string }[]
  tools?: { name: string; scope: string; probability: number; usage: string; path: string; origin: 'user' | 'assistant' }[]
}

// The picked skills' SKILL.md text, each cut to a bound and all to a total, in
// the order given; a skill whose file was not found has none and is loaded by name.
export const skillTexts = (picked: readonly { name: string; body?: string }[]): Record<string, string> => {
  const out: Record<string, string> = {}
  let left = SKILL_TEXT_TOTAL
  for (const { name, body } of picked) {
    if (!body || left <= 0) continue
    const text = body.length > SKILL_TEXT_CHARS ? `${body.slice(0, SKILL_TEXT_CHARS)}\n[cut: the rest of the skill is not shown]` : body
    out[name] = text.slice(0, left)
    left -= out[name]!.length
  }
  return out
}

export const consultText = (result: ConsultResult): string => JSON.stringify(result)

export const prepareConsult = (input: unknown): { task: string } | ConsultResult => {
  const task = typeof (input as { task?: unknown } | undefined)?.task === 'string' ? (input as { task: string }).task.replace(/\s+/g, ' ').trim() : ''
  if (!task) return { status: 'invalid_request', reason: 'task is required: one sentence saying what the work is.' }
  return { task: task.slice(0, MAX_TASK) }
}
