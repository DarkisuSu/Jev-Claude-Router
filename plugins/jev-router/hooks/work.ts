// Facts about the work in progress for the questions about model and effort:
// which tools ran lately, how many failed, which files were edited and read,
// and what the repository holds uncommitted. Numbers and file paths only; no
// code, no output, no command text. Pure: no `$`, so tests drive it directly.
import { redactSecrets, type MessageLike } from './awareness'
import type { Outline } from './outline'

export type GitFacts = { branch: string | null; changed: number; untracked: number; added: number; removed: number }

export type WorkSummary = {
  note: string
  recent_tool_calls: Record<string, number>
  failed_tool_calls: number
  edited_files: { path: string; edits: number }[]
  read_files: string[]
  repository: GitFacts | null
}

// What a snippet shows: an edit's text before and after, the end of a failure's
// output, or the start of a file Claude read.
export type Snippet = { kind: 'edit' | 'failure' | 'read'; path?: string; before?: string; after?: string; text?: string }

// What goes to Jev: the summary, the snippets, or both (each has its own switch).
export type WorkFacts = { note: string; code_snippets?: Snippet[]; code_outline?: Outline[] } & Partial<WorkSummary>

// The tool calls looked at, newest last, and the files named of each kind.
export const RECENT_CALLS = 40
export const MAX_FILES = 8

export const NOTE = 'Recent tool activity in this session; it may belong to an earlier task, and a request unrelated to it is judged on its own.'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

// A path that names a secret is not sent, only that one was there.
const SENSITIVE = /(^|\/)(\.env[^/]*|[^/]*\.(pem|key|keystore|jks|p12|pfx|p8)|id_rsa[^/]*|[^/]*(secret|credential|password|token)[^/]*)$/i

export const pathText = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value === '') return undefined
  const path = value.replace(/\\/g, '/')
  return SENSITIVE.test(path) ? '[sensitive path]' : path.length > 120 ? path.slice(path.length - 120) : path
}

export type Use = { tool?: unknown; input?: unknown; isError?: unknown; text?: unknown }

export const usesOf = (messages: readonly MessageLike[]): Use[] =>
  messages
    // A subagent's own calls are its own work, not this conversation's.
    .filter(m => m.role === 'assistant' && m.agentId === undefined && Array.isArray(m.toolUses))
    .flatMap(m => m.toolUses as Use[])

export const workFacts = (messages: readonly MessageLike[] | undefined, repository: GitFacts | undefined): WorkSummary | undefined => {
  const uses = usesOf(messages ?? []).slice(-RECENT_CALLS)
  if (uses.length === 0 && !repository) return undefined

  const tools: Record<string, number> = {}
  const edits = new Map<string, number>()
  const reads: string[] = []
  let failed = 0
  for (const use of uses) {
    const tool = typeof use.tool === 'string' ? use.tool : 'unknown'
    tools[tool] = (tools[tool] ?? 0) + 1
    if (use.isError === true) failed++
    const input = (typeof use.input === 'object' && use.input !== null ? use.input : {}) as Record<string, unknown>
    if (EDIT_TOOLS.has(tool) && use.isError !== true) {
      const path = pathText(input.file_path ?? input.notebook_path)
      if (path) edits.set(path, (edits.get(path) ?? 0) + 1)
    } else if (tool === 'Read') {
      const path = pathText(input.file_path)
      if (path) {
        const at = reads.indexOf(path)
        if (at >= 0) reads.splice(at, 1)
        reads.push(path)
      }
    }
  }
  return {
    note: NOTE,
    recent_tool_calls: tools,
    failed_tool_calls: failed,
    edited_files: [...edits.entries()].map(([path, count]) => ({ path, edits: count })).sort((a, b) => b.edits - a.edits).slice(0, MAX_FILES),
    read_files: reads.slice(-MAX_FILES).reverse(),
    repository: repository ?? null,
  }
}

// `git status --porcelain=v1 -b` and `git diff --numstat HEAD`, read.
export const parseGit = (status: string, numstat: string): GitFacts => {
  const lines = status.split('\n').filter(Boolean)
  const head = lines.find(l => l.startsWith('## '))
  const branch = head ? head.slice(3).split('...')[0]!.split(' ')[0]!.trim() || null : null
  const rest = lines.filter(l => !l.startsWith('## '))
  const untracked = rest.filter(l => l.startsWith('??')).length
  let added = 0
  let removed = 0
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, r] = line.split('\t')
    // A binary file shows '-'.
    if (/^\d+$/.test(a ?? '')) added += Number(a)
    if (/^\d+$/.test(r ?? '')) removed += Number(r)
  }
  return { branch, changed: rest.length - untracked, untracked, added, removed }
}

// The most the snippets of one request hold, in characters, and what each shows.
export const SNIPPET_CHARS = 4000
export const SNIPPET_LINES = 12
export const FAILURE_LINES = 8
export const READ_SNIPPETS = 2
const LINE_CHARS = 160

const lineList = (text: string, secrets: readonly string[]) =>
  redactSecrets(text, secrets)
    .split('\n')
    .map(l => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l))

const head = (text: string, secrets: readonly string[]) => lineList(text, secrets).slice(0, SNIPPET_LINES).join('\n')
const tail = (text: string, secrets: readonly string[]) => lineList(text.trimEnd(), secrets).slice(-FAILURE_LINES).join('\n')

// A Read result as the model saw it numbers its lines; the numbers are not code.
export const unnumbered = (text: string) => text.split('\n').map(l => l.replace(/^\s*\d+[\t→:|] ?/, '')).join('\n')

const size = (s: Snippet) => (s.path?.length ?? 0) + (s.before?.length ?? 0) + (s.after?.length ?? 0) + (s.text?.length ?? 0)

const FAILING_TOOLS = new Set(['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit'])

// Code from the conversation's own tool records, newest first: what was just
// edited, how the last failures ended, and the start of the files lately read.
// Only what these records already hold; the project is never read. A file whose
// path looks like a secret is left out, and keys and tokens are redacted.
export const codeSnippets = (messages: readonly MessageLike[] | undefined, secrets: readonly string[] = []): Snippet[] => {
  const uses = usesOf(messages ?? []).slice(-RECENT_CALLS).reverse()
  const edits: Snippet[] = []
  const failures: Snippet[] = []
  const reads: Snippet[] = []
  const readPaths = new Set<string>()
  for (const use of uses) {
    const tool = typeof use.tool === 'string' ? use.tool : ''
    const input = (typeof use.input === 'object' && use.input !== null ? use.input : {}) as Record<string, unknown>
    if (use.isError === true) {
      if (FAILING_TOOLS.has(tool) && typeof use.text === 'string' && use.text.trim()) failures.push({ kind: 'failure', text: tail(use.text, secrets) })
      continue
    }
    if (EDIT_TOOLS.has(tool)) {
      const path = pathText(input.file_path ?? input.notebook_path)
      const after = typeof input.new_string === 'string' ? input.new_string : typeof input.content === 'string' ? input.content : undefined
      if (path && path !== '[sensitive path]' && after !== undefined) {
        edits.push({ kind: 'edit', path, ...(typeof input.old_string === 'string' ? { before: head(input.old_string, secrets) } : {}), after: head(after, secrets) })
      }
    } else if (tool === 'Read' && reads.length < READ_SNIPPETS && typeof use.text === 'string') {
      const path = pathText(input.file_path)
      if (path && path !== '[sensitive path]' && !readPaths.has(path)) {
        readPaths.add(path)
        reads.push({ kind: 'read', path, text: head(unnumbered(use.text), secrets) })
      }
    }
  }
  const picked: Snippet[] = []
  let left = SNIPPET_CHARS
  for (const snippet of [...edits, ...failures, ...reads]) {
    const need = size(snippet)
    if (need > left) continue
    picked.push(snippet)
    left -= need
  }
  return picked
}

export const composeWork = (summary: WorkSummary | undefined, snippets: readonly Snippet[], outlines: readonly Outline[] = []): WorkFacts | undefined =>
  summary || snippets.length > 0 || outlines.length > 0
    ? { ...(summary ?? { note: NOTE }), ...(snippets.length > 0 ? { code_snippets: [...snippets] } : {}), ...(outlines.length > 0 ? { code_outline: [...outlines] } : {}) }
    : undefined
