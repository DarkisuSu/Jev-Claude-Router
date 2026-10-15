// Saved tools: scripts an assistant wrote for earlier work and registered with
// save_tool, so Jev can pick one when similar work comes again. Pure: the
// library lives in $.store (register.ts); only descriptions are kept, never a
// file's content, and a saved tool is only ever suggested, never run.
import { scrubText } from './awareness'
import { MAX_CHOICE_OPTIONS } from './questions'

export type Scope = 'project' | 'global'
// Who put the tool in the list. An assistant's tools are a cache of its own
// work: they can be cleared in bulk, script files included. A tool the person
// registered is theirs: bulk clears and evictions leave it, and its file is
// never deleted by the plugin.
export type Origin = 'assistant' | 'user'
export type SavedTool = {
  name: string
  // What kind of work it does, for Jev and for the assistant to read.
  description: string
  // How to run it.
  usage: string
  // Where the file is: a durable absolute path, checked to exist when suggested.
  path: string
  scope: Scope
  origin: Origin
  created: number
  used: number
  lastUsed?: number
}

export const isUserTool = (t: { origin?: Origin }) => t.origin === 'user'

export const SAVE_TOOL = 'mcp__jev-router__save_tool'
export const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
export const MAX_DESCRIPTION = 300
export const MAX_USAGE = 300
export const MAX_PATH = 400

export const SAVE_DESCRIPTION =
  'Save a reusable tool (script or command file) you wrote while working, so a similar task later can start from it instead of rewriting it. Save only work that is likely to repeat, with a durable absolute path (not a temporary folder) and a description of the kind of task it solves. Never save credentials or one-off scripts. This registers a pointer; it does not copy or run the file.'

export const SAVE_INSTRUCTIONS = [
  'When a `<tool_relevance>` hint names a saved tool, read the file and use it if it fits; do not rewrite work a saved tool already does.',
  'When you notice repeated work, or that you wrote a script a similar task will want again, save it with mcp__jev-router__save_tool: a durable absolute path (never a temporary folder), a one-line description of the kind of task it solves, and how to run it. Use scope project for work tied to this project, global for work useful anywhere. Do not save one-off scripts, scripts holding credentials or personal data, or what a saved tool already covers; saving the same name again updates it.',
  'A saved tool is a pointer: Jev suggests it, you decide whether to run it, and normal permission checks still apply. If saving is declined or fails, continue the task; do not retry the same save.',
].join('\n')

const descriptionSchema = (max: number) => ({ type: 'string', minLength: 1, maxLength: max })
export const SAVE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', pattern: NAME.source, description: 'Short identifier for the tool (letters, digits, - and _; not "none"). Saving an existing name updates it.' },
    description: { ...descriptionSchema(MAX_DESCRIPTION), description: 'The kind of task it solves, so a later request can be matched to it.' },
    usage: { ...descriptionSchema(MAX_USAGE), description: 'How to run it, e.g. "python tools/convert.py <input> <output>".' },
    path: { ...descriptionSchema(MAX_PATH), description: 'Absolute path of the file; it must exist and last (not a temporary folder).' },
    scope: { type: 'string', enum: ['project', 'global'], description: 'project: only for the current project. global: useful in any project. Default project.' },
  },
  required: ['name', 'description', 'usage', 'path'],
  additionalProperties: false,
}

export type SaveResult = {
  status: 'saved' | 'updated' | 'declined' | 'invalid_request' | 'unavailable'
  reason?: string
  name?: string
  scope?: Scope
  // Jev's judgment that the tool will serve other work, when it was asked.
  reusable?: number
  evicted?: string
}

// Jev's answer to the save question: the probability, or undefined if the
// response is not a well-formed Noul.
export const parseReusable = (text: string): number | undefined => {
  try {
    const a = (JSON.parse(text) as { answers?: { reusable?: { type?: unknown; noul?: unknown } } }).answers?.reusable
    return a?.type === 'noul' && typeof a.noul === 'number' && Number.isFinite(a.noul) && a.noul >= 0 && a.noul <= 1 ? a.noul : undefined
  } catch {
    return undefined
  }
}

// A tool's result reaches the engine as text, never as an object.
export const saveText = (result: SaveResult): string => JSON.stringify(result)

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const absolute = (p: string) => /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(p)

// Text kept as given or refused: a credential-like value or a code block is
// the assistant's to remove, never silently rewritten into the library.
const plain = (value: unknown, max: number, label: string, secrets: readonly string[]): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required.`)
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length > max) throw new Error(`${label} is longer than ${max} characters.`)
  if (scrubText(text, secrets) !== text) throw new Error(`${label} holds a credential-like value or a code block; describe the tool in words and save again.`)
  return text
}

export const prepareTool = (input: unknown, secrets: readonly string[] = []): { tool: Candidate } | SaveResult => {
  if (!record(input)) return { status: 'invalid_request', reason: 'Expected an object.' }
  try {
    const name = typeof input.name === 'string' ? input.name : ''
    if (!NAME.test(name)) throw new Error('name must be a short identifier (letters, digits, - and _).')
    const scope = input.scope === undefined ? 'project' : input.scope
    if (scope !== 'project' && scope !== 'global') throw new Error('scope must be project or global.')
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    if (!path || path.length > MAX_PATH || /[\u0000-\u001f<>|*?"]/.test(path) || !absolute(path) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)) throw new Error('path must be an absolute path to a file, without .. segments.')
    if (scrubText(path, secrets) !== path) throw new Error('path holds a credential-like value.')
    return { tool: { name, description: plain(input.description, MAX_DESCRIPTION, 'description', secrets), usage: plain(input.usage, MAX_USAGE, 'usage', secrets), path, scope } }
  } catch (error) {
    return { status: 'invalid_request', reason: error instanceof Error ? error.message : 'Invalid input.' }
  }
}

// ---- the library: one list per scope

export type Candidate = Omit<SavedTool, 'created' | 'used' | 'lastUsed' | 'origin'>

// Saves a tool, replacing the same name (its history kept). An assistant's
// save never replaces a tool the person registered, and past `max` only an
// assistant's least recently used tool goes (never the one just saved); a
// full list of the person's own tools refuses an assistant's save. The
// person's own registration is never refused for size.
export const upsertTool = (list: readonly SavedTool[], tool: Candidate, max: number, now: number, origin: Origin = 'assistant'): { list: SavedTool[]; updated: boolean; evicted?: string; refused?: 'user-tool' | 'full' } => {
  const before = list.find(t => t.name === tool.name)
  if (before && isUserTool(before) && origin === 'assistant') return { list: [...list], updated: false, refused: 'user-tool' }
  const entry: SavedTool = { ...tool, origin, created: before?.created ?? now, used: before?.used ?? 0, ...(before?.lastUsed !== undefined ? { lastUsed: before.lastUsed } : {}) }
  let next = [...list.filter(t => t.name !== tool.name), entry]
  let evicted: string | undefined
  if (next.length > max && origin === 'assistant') {
    const victim = next.filter(t => t.name !== tool.name && !isUserTool(t)).sort((a, b) => (a.lastUsed ?? a.created) - (b.lastUsed ?? b.created))[0]
    if (!victim) return { list: [...list], updated: false, refused: 'full' }
    evicted = victim.name
    next = next.filter(t => t !== victim)
  }
  return { list: next, updated: before !== undefined, evicted }
}

export const touchTool = (list: readonly SavedTool[], name: string, now: number): SavedTool[] =>
  list.map(t => (t.name === name ? { ...t, used: t.used + 1, lastUsed: now } : t))

// Both layers as one list for Jev: a project tool hides a global one of the
// same name. Capped so every option fits one Choice (one is `none`).
export const mergeTools = (project: readonly SavedTool[], global: readonly SavedTool[]): SavedTool[] => {
  const names = new Set(project.map(t => t.name))
  return [...project, ...global.filter(t => !names.has(t.name))].slice(0, MAX_CHOICE_OPTIONS - 1)
}

// What came back from storage, kept only where it is a well-formed tool.
export const readLibrary = (raw: unknown, scope: Scope): SavedTool[] => {
  if (!Array.isArray(raw)) return []
  const out: SavedTool[] = []
  for (const t of raw) {
    if (!record(t) || typeof t.name !== 'string' || !NAME.test(t.name) || typeof t.description !== 'string' || typeof t.usage !== 'string' || typeof t.path !== 'string') continue
    out.push({ name: t.name, description: t.description.slice(0, MAX_DESCRIPTION), usage: t.usage.slice(0, MAX_USAGE), path: t.path.slice(0, MAX_PATH), scope, origin: t.origin === 'user' ? 'user' : 'assistant', created: typeof t.created === 'number' ? t.created : 0, used: typeof t.used === 'number' ? t.used : 0, ...(typeof t.lastUsed === 'number' ? { lastUsed: t.lastUsed } : {}) })
  }
  return out
}

// ---- picking

// The saved tool Jev judged the best fit, when it judged (at `threshold` or more)
// that one of them does what the request asks at all.
export const bestTool = (match: number | undefined, probabilities: Readonly<Record<string, number>> | undefined, known: readonly SavedTool[], threshold: number): { tool: SavedTool; probability: number } | undefined => {
  if (match === undefined || match < threshold || !probabilities) return undefined
  const byName = new Map(known.map(t => [t.name, t]))
  const [name, p] = Object.entries(probabilities)
    .filter(([n, v]) => byName.has(n) && Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])[0] ?? []
  return name === undefined || p === undefined ? undefined : { tool: byName.get(name)!, probability: Math.round(p * 1000) / 1000 }
}

// One line of saved text, safe inside the hint: no markup, bounded.
const line = (text: string, max: number) => text.replace(/[<>`]/g, "'").replace(/\s+/g, ' ').trim().slice(0, max)

export const toolHint = (picked: readonly { tool: SavedTool }[]): string =>
  [
    '<tool_relevance source="jev-router (TypeSafe Jev)">',
    'A saved tool may fit this request. One marked "saved by an assistant" was written during earlier work and not reviewed by anyone: read the file before running it. Run a tool only if it fits, and ignore this hint otherwise. Normal permission checks apply.',
    ...picked.flatMap(({ tool }) => [`- ${line(tool.name, 64)} (${tool.scope}, ${isUserTool(tool) ? 'registered by the user' : 'saved by an assistant'}): ${line(tool.description, MAX_DESCRIPTION)}`, `  run: ${line(tool.usage, MAX_USAGE)}`, `  file: ${line(tool.path, MAX_PATH)}`]),
    '</tool_relevance>',
  ].join('\n')

// Whether a shell command runs a saved tool: its path appears in the command.
export const usesTool = (command: string, tool: SavedTool): boolean => {
  const flat = (s: string) => s.replace(/\\/g, '/').toLowerCase()
  return flat(command).includes(flat(tool.path))
}
