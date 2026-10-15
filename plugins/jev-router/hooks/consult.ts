// The consult tool: in consult mode Claude asks Jev which skill or saved tool
// fits before starting, instead of receiving Jev's pick beside the prompt.
// Pure: no `$`, so tests drive it directly.
import { isUserTool, type SavedTool } from './tools'

export const CONSULT_TOOL = 'mcp__jev-router__consult'
export const MAX_TASK = 400
const LISTED_TOOLS = 30

export const CONSULT_DESCRIPTION =
  'Ask Jev (TypeSafe) which skill or saved tool fits the work you are about to start. Pass one sentence saying what the task is. The skills and saved tools to choose from are the ones jev-router lists; Jev reads the recent conversation itself. It returns the picks with probabilities. Nothing is loaded or run by this call.'

export const CONSULT_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', minLength: 1, maxLength: MAX_TASK, description: 'One sentence: what the work you are about to start is.' },
  },
  required: ['task'],
  additionalProperties: false,
}

const line = (text: string, max: number) => text.replace(/[<>`]/g, "'").replace(/\s+/g, ' ').trim().slice(0, max)

// The standing instructions. Saved tools are listed by name and one line so
// Claude knows what exists; which one fits is Jev's to say.
export const consultInstructions = (tools: readonly SavedTool[], routesModel: boolean): string => {
  const shown = tools.slice(0, LISTED_TOOLS)
  return [
    `Jev router: ${routesModel ? 'the model and effort of each turn, and ' : ''}the choice of a skill or a saved tool ${routesModel ? 'are' : 'is'} delegated to Jev (TypeSafe), not decided by you alone.`,
    `Before you start work that a skill or a saved tool might serve, call ${CONSULT_TOOL} once with a one-sentence task. Jev answers with its picks and probabilities. Then follow it: load a picked skill with the Skill tool, or read a picked tool's file before running it. Normal permission checks apply.`,
    'Skip the call for plain conversation, a question you can answer directly, or work you have already consulted about in this turn. If Jev is unavailable or picks nothing, carry on with your own judgment; do not call it again for the same task.',
    ...(shown.length > 0
      ? ['Saved tools Jev can pick from:', ...shown.map(t => `- ${line(t.name, 64)} (${t.scope}${isUserTool(t) ? ', registered by the user' : ''}): ${line(t.description, 160)}`), ...(tools.length > shown.length ? [`- … and ${tools.length - shown.length} more`] : [])]
      : []),
  ].join('\n')
}

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
