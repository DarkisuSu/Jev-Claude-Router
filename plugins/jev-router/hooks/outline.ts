// The gist of the code the conversation has touched: for each file lately
// read or edited, what it is for (its header comment) and the shape of it (the
// signatures of its types and methods), never the bodies. Built from the
// conversation's own tool records, so the project is never read. Pure.
import { redactSecrets, type MessageLike } from './awareness'
import { RECENT_CALLS, pathText, unnumbered, usesOf } from './work'

export type Outline = {
  path: string
  // Lines of the text this was drawn from: the part read, or the text written.
  lines_seen: number
  // The header comment, when the file opens with one.
  purpose?: string
  // Signatures of types and methods in the order they appear.
  symbols: string[]
}

export const OUTLINE_FILES = 5
export const OUTLINE_SYMBOLS = 14
export const OUTLINE_CHARS = 2500
const SYMBOL_CHARS = 110
const PURPOSE_CHARS = 160

const MODIFIERS = '(?:(?:public|private|protected|internal|static|abstract|sealed|partial|override|virtual|async|readonly|unsafe|extern)\\s+)'

// Declarations in C#, TypeScript, JavaScript and Python: a type, then a method
// or function. A line that is not one is not a symbol.
const SYMBOLS: RegExp[] = [
  new RegExp(`^\\s*(?:\\[[^\\]]+\\]\\s*)*${MODIFIERS}*(?:class|interface|struct|enum|record)\\s+[A-Za-z_]\\w*[^{;=]*`),
  new RegExp(`^\\s*${MODIFIERS}+[\\w<>\\[\\],.?\\s]+?\\s+[A-Za-z_]\\w*\\s*\\([^)]*\\)`),
  // A constructor: modifiers, then the name and its parameters.
  new RegExp(`^\\s*${MODIFIERS}+[A-Za-z_]\\w*\\s*\\([^)]*\\)`),
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+[A-Za-z_$][\w$]*[^{=;]*/,
  /^\s*(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/,
  /^\s*(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*[^:]*/,
]

const COMMENT = /^\s*(?:\/\/\/?|#|\*|\/\*+|"""|''')\s?/

const flat = (text: string) => text.replace(/\s+/g, ' ').trim()

// The first comment lines of the file, with the markers and any XML tags off.
const purposeOf = (lines: readonly string[]): string | undefined => {
  const said: string[] = []
  for (const line of lines.slice(0, 15)) {
    if (!line.trim()) {
      if (said.length > 0) break
      continue
    }
    if (!COMMENT.test(line)) break
    const body = flat(line.replace(COMMENT, '').replace(/<[^>]+>/g, ' ').replace(/\*\/\s*$/, '').replace(/(?:"""|''')\s*$/, ''))
    if (body) said.push(body)
    if (said.join(' ').length >= PURPOSE_CHARS) break
  }
  const text = said.join(' ')
  return text ? text.slice(0, PURPOSE_CHARS) : undefined
}

export const outlineOf = (path: string, text: string, secrets: readonly string[] = []): Outline => {
  const lines = text.split('\n')
  const symbols: string[] = []
  for (const line of lines) {
    if (symbols.length >= OUTLINE_SYMBOLS) break
    if (COMMENT.test(line)) continue
    if (!SYMBOLS.some(re => re.test(line))) continue
    const signature = flat(line).replace(/\s*(?:=>|\{).*$/, '').replace(/[;:]$/, '').slice(0, SYMBOL_CHARS)
    if (signature && !symbols.includes(signature)) symbols.push(signature)
  }
  const purpose = purposeOf(lines)
  return {
    path,
    lines_seen: lines.length,
    ...(purpose ? { purpose: redactSecrets(purpose, secrets) } : {}),
    symbols: symbols.map(s => redactSecrets(s, secrets)),
  }
}

const size = (o: Outline) => o.path.length + (o.purpose?.length ?? 0) + o.symbols.reduce((n, s) => n + s.length, 0)

// Outlines of the files lately read or edited, newest first. A file read is
// outlined from what was read of it; one only edited, from the text written.
// Files that look like secrets are left out; files with nothing to show too.
export const codeOutline = (messages: readonly MessageLike[] | undefined, secrets: readonly string[] = []): Outline[] => {
  const uses = usesOf(messages ?? []).slice(-RECENT_CALLS).reverse()
  // Per file, a read or a whole write shows more of it than an edit's fragment
  // does, so it is preferred; a fragment that shows nothing hides nothing.
  const found = new Map<string, { at: number; fragment: boolean; outline: Outline }>()
  uses.forEach((use, at) => {
    if (use.isError === true) return
    const tool = typeof use.tool === 'string' ? use.tool : ''
    const input = (typeof use.input === 'object' && use.input !== null ? use.input : {}) as Record<string, unknown>
    const path = pathText(input.file_path ?? input.notebook_path)
    if (!path || path === '[sensitive path]') return
    let text: string | undefined
    if (tool === 'Read' && typeof use.text === 'string') text = unnumbered(use.text)
    else if (tool === 'Edit' && typeof input.new_string === 'string') text = input.new_string
    else if (tool === 'Write' && typeof input.content === 'string') text = input.content
    if (text === undefined) return
    const outline = outlineOf(path, text, secrets)
    if (outline.symbols.length === 0 && !outline.purpose) return
    const fragment = tool === 'Edit'
    const have = found.get(path)
    if (!have) found.set(path, { at, fragment, outline })
    else if (have.fragment && !fragment) found.set(path, { at: have.at, fragment, outline })
  })
  const outlines = [...found.values()].sort((a, b) => a.at - b.at).map(f => f.outline)
  const picked: Outline[] = []
  let left = OUTLINE_CHARS
  for (const outline of outlines) {
    if (picked.length >= OUTLINE_FILES) break
    const need = size(outline)
    if (need > left) continue
    picked.push(outline)
    left -= need
  }
  return picked
}
