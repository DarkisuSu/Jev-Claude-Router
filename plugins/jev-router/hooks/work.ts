// A "work" is what one consult was made for: the one-sentence task the assistant
// gave. Jev, not the assistant, says whether a later action still belongs to it,
// so the assistant cannot decide on its own that no new consult is needed.
// Pure: no `$`, so tests drive it directly.

import { SAME_WORK_QUESTION } from './questions'

// Longest Jev waits on one check, and how much recent conversation rides it.
export const SAME_WORK_TIMEOUT_MS = 6000
export const SAME_WORK_CONTEXT_CHARS = 3000

export type Work = {
  task: string
  // Actions Jev judged part of this work, by action key; each kind is asked once.
  judged: Set<string>
  // The kinds of action Jev judged to be other work and sent back to consult.
  // Remembered, so the same kind is refused again without asking Jev (the host
  // runs parallel calls one after another); each passes once, after the consult
  // it was sent back for, so a disagreement between two answers cannot loop.
  refused: Set<string>
}

export const startWork = (task: string): Work => ({ task, judged: new Set(), refused: new Set() })

export const settleRefusal = (work: Work): void => {
  for (const key of work.refused) work.judged.add(key)
  work.refused.clear()
}

// The tools whose calls change something or start more work. Reading is free.
export const WORK_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit', 'Agent', 'Task', 'Workflow', 'Bash', 'PowerShell'])

export type Action = { key: string; text: string }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const slashes = (p: string) => p.replace(/\\/g, '/')
const folder = (p: string) => slashes(p).replace(/\/[^/]*$/, '')
const cut = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n)

// The assistant's own housekeeping (its notes and plans) belongs to no work.
const housekeeping = (path: string) => /\/\.claude\/(projects\/[^/]+\/memory|plans)\//.test(slashes(path))

const READ_ONLY = new Set([
  'ls', 'dir', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'pwd', 'cd', 'pushd', 'popd',
  'echo', 'printf', 'which', 'where', 'type', 'file', 'stat', 'du', 'df', 'tree', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp',
  'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'hostname', 'printenv', 'true', 'test', '[', 'sleep',
  'get-childitem', 'gci', 'get-content', 'gc', 'get-item', 'get-location', 'get-command', 'select-string', 'test-path',
  'resolve-path', 'measure-object', 'write-output', 'write-host', 'format-list', 'format-table', 'select-object', 'where-object', 'sort-object',
])
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe'])

const commandName = (token: string) => (token.toLowerCase().split(/[\\/]/).pop() ?? '').replace(/\.exe$/, '')

// A command that only reads: every piece of a pipeline or chain is a reader, it
// writes no file, and it runs nothing through a substitution.
export const readOnlyCommand = (command: string): boolean => {
  if (/\$\(|`/.test(command) || /(^|[^2&])>/.test(command)) return false
  const pieces = command.split(/&&|\|\||;|\||\n/).map(p => p.trim()).filter(Boolean)
  return pieces.length > 0 && pieces.every(piece => {
    const [first = '', second = ''] = piece.split(/\s+/)
    const name = commandName(first)
    if (name === 'git') return GIT_READ.has(second.toLowerCase())
    if (name === 'find') return !/\s-(delete|exec|execdir|ok)\b/.test(piece)
    return READ_ONLY.has(name)
  })
}

// What an action is, for the one question Jev is asked about it; undefined for
// one that needs no question (reading, housekeeping, a read-only command).
export const describeAction = (tool: string, input: Record<string, unknown>): Action | undefined => {
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    const path = str(input.file_path) || str(input.notebook_path)
    if (!path || housekeeping(path)) return undefined
    return { key: `${tool}:${folder(path)}`, text: `${tool === 'Write' ? 'Write' : 'Edit'} the file ${slashes(path)}` }
  }
  if (tool === 'Agent' || tool === 'Task') {
    const description = cut(str(input.description), 120)
    return { key: `${tool}:${description}`, text: `Start a subagent (${str(input.subagent_type) || 'general'}): ${description}. Its instructions begin: ${cut(str(input.prompt), 200)}` }
  }
  if (tool === 'Workflow') {
    const name = cut(str(input.name), 80) || 'an inline script'
    return { key: `Workflow:${name}`, text: `Run the workflow ${name}` }
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = cut(str(input.command), 300)
    if (!command || readOnlyCommand(command)) return undefined
    return { key: `${tool}:${command.split(/\s+/).slice(0, 2).join(' ').toLowerCase()}`, text: `Run the ${tool === 'PowerShell' ? 'PowerShell' : 'shell'} command: ${command}` }
  }
  return undefined
}

export const sameWorkBody = (model: string, task: string, action: string, recent: string) => ({
  model,
  state: { request: task, action, recent_context: recent },
  questions: { same_work: SAME_WORK_QUESTION },
})

export const parseSameWork = (text: string): number | undefined => {
  try {
    const a = (JSON.parse(text) as { answers?: { same_work?: { type?: unknown; noul?: unknown } } }).answers?.same_work
    return a?.type === 'noul' && typeof a.noul === 'number' && Number.isFinite(a.noul) && a.noul >= 0 && a.noul <= 1 ? a.noul : undefined
  } catch {
    return undefined
  }
}
