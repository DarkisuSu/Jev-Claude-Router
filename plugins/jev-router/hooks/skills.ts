// The skill index, pure: register.ts reads the files and the command list
// (only a hooks module's own file may use `$`) and hands them here.

import { INDEX_DESCRIPTION_CHARS } from './questions'
import type { Skill } from './router'

export const BODY_CHARS = 20000

export type Found = { name?: string; description?: string; body: string; path: string }

export type Command = { name: string; description: string; source: string }

export type SkillIndex = {
  skills: Skill[]
  // SKILL.md path per skill name, for inject mode and /jev-index.
  paths: Record<string, string>
  builtAt: number
  sources: { commands: number; files: number; dropped: number }
}

export const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

export const parent = (p: string) => {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : undefined
}

export const parseSkillMd = (text: string): { name?: string; description?: string; body: string } => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { body: text }
  const front = m[1] ?? ''
  const field = (key: string) => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(front)
    if (!line) return undefined
    let value = (line[1] ?? '').trim()
    // Folded or literal block scalar: gather the indented lines after it.
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const after = front.slice(line.index + line[0].length).split(/\r?\n/)
      const lines: string[] = []
      for (const l of after.slice(1)) {
        if (!/^\s+\S/.test(l)) break
        lines.push(l.trim())
      }
      value = lines.join(' ')
    }
    return value.replace(/^["']|["']$/g, '') || undefined
  }
  return { name: field('name'), description: field('description'), body: (m[2] ?? '').trim() }
}

const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

export const assembleIndex = (
  files: ReadonlyMap<string, Found>,
  commands: readonly Command[],
  self: string,
  builtAt: number,
): SkillIndex => {
  const lookup = (name: string) => files.get(name) ?? files.get(name.slice(name.indexOf(':') + 1))
  const skills: Skill[] = []
  const paths: Record<string, string> = {}

  const add = (name: string, fallback: string, found: Found | undefined) => {
    const descriptionFull = found?.description ?? fallback
    if (!descriptionFull) return
    skills.push({
      name,
      description: cut(descriptionFull, INDEX_DESCRIPTION_CHARS),
      descriptionFull,
      body: found?.body,
    })
    if (found) paths[name] = found.path
  }

  let dropped = 0
  if (commands.length > 0) {
    // What the session can invoke now is the authority; built-in commands
    // (/clear, /compact, bundled skills) and MCP prompts are left out.
    for (const c of commands) {
      if (c.source !== 'user' && c.source !== 'plugin') continue
      if (c.name === self || c.name.startsWith(`${self}:`) || c.name.startsWith('jev-')) continue
      add(c.name, c.description, lookup(c.name))
    }
    dropped = [...files.keys()].filter(k => !commands.some(c => c.name === k || c.name.endsWith(`:${k}`))).length
  } else {
    for (const [name, found] of files) add(name, '', found)
  }

  return { skills, paths, builtAt, sources: { commands: commands.length, files: files.size, dropped } }
}
