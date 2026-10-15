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
    `At the start of every user message, before anything else, call ${CONSULT_TOOL} once with a one-sentence task. Jev answers with the skills and saved tools that fit, with probabilities, or says none does. Then follow it: load a picked skill with the Skill tool, or read a picked tool's file before running it. Normal permission checks apply.`,
    'Do not pick a skill or a saved tool on your own before Jev has answered. If Jev is unavailable or picks nothing, carry on with your own judgment; do not call it again for the same message.',
  ].join('\n')

export type ConsultResult = {
  status: 'picked' | 'nothing_fits' | 'unavailable' | 'invalid_request'
  reason?: string
  skills?: { name: string; fits: number; probability: number }[]
  tools?: { name: string; scope: string; probability: number; usage: string; path: string; origin: 'user' | 'assistant' }[]
}

export const consultText = (result: ConsultResult): string => JSON.stringify(result)

export const prepareConsult = (input: unknown): { task: string } | ConsultResult => {
  const task = typeof (input as { task?: unknown } | undefined)?.task === 'string' ? (input as { task: string }).task.replace(/\s+/g, ' ').trim() : ''
  if (!task) return { status: 'invalid_request', reason: 'task is required: one sentence saying what the work is.' }
  return { task: task.slice(0, MAX_TASK) }
}
