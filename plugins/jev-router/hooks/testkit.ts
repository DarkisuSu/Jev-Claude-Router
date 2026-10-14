// Shared by the test files: the world beneath the plugin (fs, env, config,
// Jev over http.fetch) answered from memory. No network, no real key.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

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
    fallback_model: { type: 'string', default: 'session' },
    reset_to_defaults: { type: 'boolean', default: false },
  },
})

type Jev = (questions: Record<string, unknown>) => { status: number; body: unknown } | 'hang'

export const rankWide = (
  gate: number,
  top: string,
  model?: { choice: string; confidence: number },
  effort?: { score: number; confidence: number; probabilities?: Record<string, number> },
) => ({
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
    ...(model
      ? { model_tier: { type: 'choice', choice: model.choice, probabilities: { [model.choice]: model.confidence }, confidence: model.confidence } }
      : {}),
    ...(effort ? { effort_level: { type: 'score', score: effort.score, legend: {}, probabilities: effort.probabilities ?? {}, confidence: effort.confidence } } : {}),
  },
  usage: { input_tokens: 400, output_tokens: 10 },
})

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

export type World = {
  sets: { key: string; value: unknown }[]
  fetches: { url: string; auth?: string; body: string }[]
  written: Map<string, string>
  seen?: { text: string; context?: readonly string[] }
}

export const world = (on: On, jev: Jev, extra?: { version?: string }): World => {
  const w: World = { fetches: [], written: new Map(), sets: [] }
  mock.env(on, { USERPROFILE: HOME })
  on('command.list', () => ({ value: COMMANDS }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('config.list', () => ({ value: [MODEL_ROW, ...PLUGIN_ROWS] as never }))
  on('config.set', ($, e) => {
    w.sets.push({ key: e.key, value: e.value })
    return { value: e.value } as never
  })
  on('session.version', () => ({ value: { version: extra?.version ?? '9.9.9' } as never }))
  on('session.cwd', () => ({ value: 'C:/fakeproject' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 1 }] } as never }))
  on('fs.list', ($, e) => ({ deny: `no folder ${e.path}` }))
  on('fs.exists', ($, e) => ({ value: w.written.has(e.path) }))
  on('fs.read', ($, e) => {
    if (e.path.replace(/\\/g, '/').endsWith('/.claude-plugin/plugin.json')) return { value: MANIFEST }
    const text = w.written.get(e.path)
    return text === undefined ? { deny: `no file ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    w.written.set(e.path, e.text)
    return { value: undefined }
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
