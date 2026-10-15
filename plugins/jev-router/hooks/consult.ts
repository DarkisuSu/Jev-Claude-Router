// The consult tool: in consult mode Claude asks Jev which skill or saved tool
// fits before starting, instead of receiving Jev's pick beside the prompt.
// Pure: no `$`, so tests drive it directly.

export const CONSULT_TOOL = 'mcp__jev-router__consult'
export const MAX_TASK = 400

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
    `At the start of every user message, before anything else, call ${CONSULT_TOOL} with a one-sentence task. Call it again whenever the work changes and a different skill or saved tool might serve, including one that a skill's own instructions tell you to load. Jev answers with the skills and saved tools that fit, with probabilities, or says none does. Choose from what Jev returns: use the ones that fit the work, ignore the rest, and load a picked skill with the Skill tool or read a picked tool's file before running it. A skill or saved tool that Jev has not returned is refused. Normal permission checks apply.`,
    'Use only a skill or a saved tool that Jev returned; do not pick one on your own. If Jev picks nothing, carry on with your own judgment. If Jev is unavailable, its answer lists the skills and saved tools for you to choose from yourself. When you start a subagent, tell it to call the consult tool before it uses any skill or saved tool.',
  ].join('\n')

export type ConsultResult = {
  status: 'picked' | 'nothing_fits' | 'unavailable' | 'invalid_request'
  reason?: string
  // With Jev unreachable: what Claude may choose from itself.
  fallback?: { note: string; skills: { name: string; description: string }[]; tools: { name: string; scope: string; description: string; usage: string; path: string }[] }
  skills?: { name: string; fits: number; probability: number }[]
  tools?: { name: string; scope: string; probability: number; usage: string; path: string; origin: 'user' | 'assistant' }[]
}

export const consultText = (result: ConsultResult): string => JSON.stringify(result)

export const prepareConsult = (input: unknown): { task: string } | ConsultResult => {
  const task = typeof (input as { task?: unknown } | undefined)?.task === 'string' ? (input as { task: string }).task.replace(/\s+/g, ' ').trim() : ''
  if (!task) return { status: 'invalid_request', reason: 'task is required: one sentence saying what the work is.' }
  return { task: task.slice(0, MAX_TASK) }
}
