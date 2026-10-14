// Shared by the test files: the world beneath the plugin (fs, env, config,
// Jev over http.fetch) answered from memory. No network, no real key.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { SHARED } from './settings'
import type { MessageLike } from './awareness'

export const FAKE_KEY = 'placeholder-not-a-real-key'
const HOME = 'C:/fakehome'

export const COMMANDS = [
  { name: 'speckit-specify', description: 'Create or update the feature specification from a description.', source: 'user' },
  { name: 'speckit-plan', description: 'Execute the implementation planning workflow.', source: 'user' },
  { name: 'typesafe:typesafe-ai', description: 'Build AI-powered software with TypeSafe.', source: 'plugin' },
  { name: 'clear', description: 'Clear the conversation.', source: 'builtin' },
]

export const MODEL_ROW = {
  key: 'model',
  label: 'Model',
  kind: 'choice',
  value: 'sonnet',
  options: ['default', 'sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'haiku', 'opusplan'],
  provider: { kind: 'engine' },
  isLocked: false,
}

// Rows the plugin's settings show, away from their defaults.
const row = (field: string, value: unknown, kind: string) => ({ key: `jev-router@inline.${field}`, label: field, kind, value, provider: { kind: 'plugin' }, isLocked: false })
export const PLUGIN_ROWS = [
  row('model_threshold', 0.9, 'number'),
  row('fits_threshold', 0.3, 'number'),
  row('skill_routing', true, 'boolean'),
  row('fallback_model', 'opus', 'choice'),
  row('typesafe_api_key', 'secret-not-listed', 'text'),
  row('reset_to_defaults', true, 'boolean'),
]
// The manifest's declared defaults, as `defaults` reads them.
const MANIFEST = JSON.stringify({
  userConfig: {
    typesafe_api_key: { type: 'string' },
    model_threshold: { type: 'number', default: 0.5 },
    fits_threshold: { type: 'number', default: 0.3 },
    skill_routing: { type: 'boolean', default: true },
    fallback_model: { type: 'string', default: 'session' },
    reset_to_defaults: { type: 'boolean', default: false },
    ...Object.fromEntries(Object.entries(SHARED).filter(([, spec]) => spec.where === 'page').map(([key, spec]) => [key, { default: spec.default }])),
  },
})

type Jev = (questions: Record<string, unknown>) => { status: number; body: unknown } | 'hang'

// Jev's request-1 answer. `feasible` maps 'family::effort' to Jev's
// feasibility; with `questions`, every pair asked and not listed is
// answered `rest` (0.1: judged unable), as Jev answers every question.
export const rankWide = (
  gate: number,
  top: string,
  feasible: Record<string, number> = {},
  questions?: Record<string, unknown>,
  rest = 0.1,
) => {
  const pairs: Record<string, number> = {}
  for (const id of Object.keys(questions ?? {})) if (id.startsWith('feasible::')) pairs[id.slice('feasible::'.length)] = rest
  Object.assign(pairs, feasible)
  return {
    model: 'jev-test-1',
    answers: {
      which: {
        type: 'choice',
        choice: top,
        probabilities: { [top]: 0.7, 'speckit-plan': 0.2, 'typesafe:typesafe-ai': 0.1 },
        confidence: 0.6,
      },
      acts_on_user_system: { type: 'noul', noul: gate },
      would_follow_documented_procedure: { type: 'noul', noul: gate },
      prose_suffices: { type: 'noul', noul: 1 - gate },
      ...Object.fromEntries(Object.entries(pairs).map(([pair, noul]) => [`feasible::${pair}`, { type: 'noul', noul }])),
    },
    usage: { input_tokens: 400, output_tokens: 10 },
  }
}

export const rerank = (questions: Record<string, unknown>, fitsByName: Record<string, number>) => {
  const answers: Record<string, unknown> = {}
  const names = Object.keys(questions).filter(k => k.startsWith('fits::')).map(k => k.slice(6))
  for (const n of names) answers[`fits::${n}`] = { type: 'noul', noul: fitsByName[n] ?? 0.05 }
  const best = names.slice().sort((a, b) => (fitsByName[b] ?? 0) - (fitsByName[a] ?? 0))[0] ?? ''
  const probabilities: Record<string, number> = {}
  for (const n of names) probabilities[n] = n === best ? 0.8 : 0.2 / Math.max(1, names.length - 1)
  answers.which = { type: 'choice', choice: best, probabilities, confidence: 0.7 }
  return { model: 'jev-test-1', answers, usage: { input_tokens: 900, output_tokens: 8 } }
}

// $.store answered from a plain object the test can read back.
export const memoryStore = (on: On, initial: Record<string, unknown> = {}) => {
  const saved: Record<string, unknown> = { ...initial }
  on('store.get', ($, e) => ({ value: saved[e.key] as never }))
  on('store.set', ($, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete saved[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(saved) }))
  return saved
}

export type World = {
  sets: { key: string; value: unknown }[]
  fetches: { url: string; auth?: string; body: string }[]
  written: Map<string, string>
  deletedFiles: string[]
  processRuns: { argv: string[]; env?: Record<string, string> }[]
  seen?: { text: string; context?: readonly string[] }
  sessionId: string
  contextTokens?: number
  // The session model's context window and name, as Claude Code reports them.
  window?: number
  sessionModel?: string
  configRows: ReturnType<typeof row>[]
  status: string[]
  messages: MessageLike[]
  messageReads: number
}

// On Windows the engine hands fs hooks native backslash paths; files are kept
// under one spelling (forward slashes), as the tests name them.
const slash = (path: string) => path.replace(/\\/g, '/')

export const world = (on: On, jev: Jev, extra?: { version?: string; gui?: Record<string, unknown> }): World => {
  const configRows = [...PLUGIN_ROWS.map(r => ({ ...r })), ...Object.entries(SHARED).filter(([, spec]) => spec.where === 'page').map(([key, spec]) => row(key, extra?.gui?.[key] ?? spec.default, spec.kind))]
  const w: World = { fetches: [], written: new Map(), deletedFiles: [], processRuns: [], sets: [], sessionId: 'test-session', configRows, status: [], messages: [], messageReads: 0 }
  mock.env(on, { USERPROFILE: HOME })
  on('command.list', () => ({ value: COMMANDS }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => { w.status.push(e.text); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('config.list', () => ({ value: [MODEL_ROW, ...w.configRows] as never }))
  on('config.set', ($, e) => {
    w.sets.push({ key: e.key, value: e.value })
    const target = w.configRows.find(r => r.key === e.key)
    if (target) target.value = e.value
    return { value: e.value } as never
  })
  on('session.version', () => ({ value: { version: extra?.version ?? '9.9.9' } as never }))
  on('session.cwd', () => ({ value: 'C:/fakeproject' }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.messages', () => { w.messageReads++; return { value: w.messages as never } })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: w.contextTokens, window: w.window }, rateLimits: [{ kind: 'five_hour', percentUsed: 1 }] } as never }))
  on('session.model', () => ({ value: w.sessionModel ?? 'opus' }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path.replace(/\\/g, '/').replace(/\/+$/, '')}/`
    const children = new Map<string, { name: string; kind: 'file' | 'dir' }>()
    for (const path of w.written.keys()) {
      const normalized = path.replace(/\\/g, '/')
      if (!normalized.startsWith(prefix)) continue
      const rest = normalized.slice(prefix.length)
      if (!rest) continue
      const [name, ...nested] = rest.split('/')
      children.set(name!, { name: name!, kind: nested.length > 0 ? 'dir' : 'file' })
    }
    return { value: [...children.values()] as never }
  })
  on('fs.exists', ($, e) => {
    const path = e.path.replace(/\\/g, '/').replace(/\/+$/, '')
    const value = [...w.written.keys()].some(file => {
      const normalized = file.replace(/\\/g, '/').replace(/\/+$/, '')
      return normalized === path || normalized.startsWith(`${path}/`)
    })
    return { value }
  })
  on('fs.stat', ($, e) => {
    const path = e.path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase()
    const files = [...w.written.entries()].map(([file, content]) => ({ path: file.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase(), content }))
    const file = files.find(f => f.path === path)
    const directory = files.some(f => f.path.startsWith(`${path}/`))
    if (!file && !directory) return { deny: `no path ${e.path}` }
    return { value: { kind: file ? 'file' : 'dir', size: file?.content.length ?? 0, mtimeMs: 0, isLink: false, realPath: path } as never }
  })
  on('fs.read', ($, e) => {
    if (e.path.replace(/\\/g, '/').endsWith('/.claude-plugin/plugin.json')) return { value: MANIFEST }
    const text = w.written.get(slash(e.path))
    return text === undefined ? { deny: `no file ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    w.written.set(slash(e.path), e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    const env = e.init?.env ? { ...e.init.env } : undefined
    w.processRuns.push({ argv, env })
    const command = argv[0]?.split(/[\\/]/).at(-1)?.toLowerCase()
    const path = command === 'powershell.exe'
      ? env?.JEV_ROUTER_DELETE_PATH
      : command === 'rm' && argv[1] === '-f' && argv[2] === '--' ? argv[3] : undefined
    if (path) {
      w.deletedFiles.push(path)
      w.written.delete(slash(path))
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  on('http.fetch', async ($, e) => {
    const body = e.init?.body ?? ''
    w.fetches.push({ url: e.url, auth: e.init?.headers?.Authorization, body })
    const answer = jev((JSON.parse(body) as { questions: Record<string, unknown> }).questions)
    if (answer === 'hang') return new Promise<never>(() => {})
    return { value: { status: answer.status, ok: answer.status < 300, headers: {}, text: JSON.stringify(answer.body) } }
  })
  on('prompt.submit', ($, e) => {
    w.seen = { text: e.text, context: e.context }
    return { text: e.text, context: e.context }
  })
  return w
}

export const logLines = (w: World) =>
  [...w.written.entries()]
    .filter(([path]) => path.endsWith('.jsonl'))
    .flatMap(([, text]) => text.trim().split('\n'))
    .map(l => JSON.parse(l) as Record<string, any>)

export const PROMPT = 'Write the feature spec for the new VIP lobby banner.'
