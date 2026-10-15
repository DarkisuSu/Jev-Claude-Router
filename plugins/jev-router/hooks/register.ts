import type { EngineInterface, PluginOptions, PromptOrigin, Register } from 'claude-code'

import {
  availableFrom,
  decide,
  EFFORTS,
  isEffort,
  familyOf,
  learn,
  noteContext,
  planStep,
  type Available,
  type Caps,
  type Decision,
  type Fallback,
  type Family,
  type RoutingMode,
  type Plan,
  type Step,
  type Effort,
} from './model'
import { horizonFor, learnOutput, median, normalizeStats, outputSummary, pairCost, type OutputStats } from './cost'
import { ENDPOINT, saveQuestion } from './questions'
import {
  SAVE_DESCRIPTION,
  SAVE_INSTRUCTIONS,
  SAVE_SCHEMA,
  SAVE_TOOL,
  mergeTools,
  parseReusable,
  pickTools,
  prepareTool,
  readLibrary,
  saveText,
  toolHint,
  isUserTool,
  touchTool,
  upsertTool,
  usesTool,
  type SaveResult,
  type SavedTool,
  type Scope,
} from './tools'
import { cacheAdvice, cacheEvidence, observeUsage, resetCache, withContext, type CacheState, type CacheAdvice, type UsageLike } from './cache'
import { SHARED, parseSetting, settingValue, sharedConfig } from './settings'
import { JevError, route, type RouteResult, type Send } from './router'
import { EMPTY_ATTEMPT, STATE_CHAR_BUDGET, STATE_RESERVE, recentContext, routingFacts, scrubText, type AttemptFacts } from './awareness'
import { CONSULT_DESCRIPTION, CONSULT_SCHEMA, CONSULT_TOOL, consultInstructions, consultText, prepareConsult, type ConsultResult } from './consult'
import { DECISION_TOOL, DECISION_DESCRIPTION, DECISION_INSTRUCTIONS, DECISION_SCHEMA, decisionText, prepareDecision, evaluateDecision } from './decisions'
import {
  BODY_CHARS,
  assembleIndex,
  norm,
  parent,
  parseSkillMd,
  type Command,
  type Found,
  type SkillIndex,
} from './skills'

const INDEX_TTL_MS = 5 * 60 * 1000
const PROJECT_DEPTH = 8
const INJECT_CHARS = 20000
const LOG_DIR_NAME = 'jev-router-jev-local'
const KEPT_TURNS = 20
const CAPS_KEY = 'caps'
// Average output per main request at each effort (numbers only), across sessions.
const OUTPUTS_KEY = 'outputs'
// Main requests per turn of the latest turns (numbers only), across sessions.
const TURNLEN_KEY = 'turnlen'
const KEPT_TURN_LENGTHS = 20
const PROBE_TEXT = 'Reply with exactly: OK'
// A routed request that fails goes back to the probe at most this many times
// before the fallback model carries on.
const MAX_REPROBES = 2
// How often a waiting message looks at whether the probes have finished.
const PROBE_POLL_MS = 250
// A model id no account has: the probe's check that a failed request can be
// sent again on the session's own model.
const PROBE_BAD_MODEL = 'jev-router-probe-no-such-model'

type Config = {
  key: string
  enabled: boolean
  skillRouting: boolean
  decisionRouting: boolean
  selectionMode: 'prehint' | 'consult'
  chatNotice: boolean
  probeWaitMs: number
  tools: ReturnType<typeof sharedConfig>['tools']
  decisionConfidence: number
  mode: 'hint' | 'inject'
  shortlist: number
  gateThreshold: number
  fitsThreshold: number
  model: string
  timeoutMs: number
  maxPromptChars: number
  routing: RoutingMode
  fallback: Fallback
  feasibleThreshold: number
  autoProbe: boolean
  effortLevels: Record<Effort, string>
  modelDescriptions: Record<string, string>
  cache: ReturnType<typeof sharedConfig>['cache']
  cost: ReturnType<typeof sharedConfig>['cost']
  awareness: ReturnType<typeof sharedConfig>['awareness']
  resetRequested: boolean
  writeLog: boolean
}

const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

export const readConfig = (o: PluginOptions): Config => ({
  key: typeof o.typesafe_api_key === 'string' ? o.typesafe_api_key.trim() : '',
  enabled: o.enabled !== false,
  skillRouting: o.skill_routing !== false,
  mode: o.mode === 'inject' ? 'inject' : 'hint',
  shortlist: 3,
  gateThreshold: num(o.gate_threshold, 0.3, 0, 1),
  fitsThreshold: num(o.fits_threshold, 0.3, 0, 1),
  resetRequested: o.reset_to_defaults === true,
  writeLog: o.write_log === true,
  ...sharedConfig(o),
  model: 'jev-latest',
  timeoutMs: 9000,
  maxPromptChars: 4000,
  routing: o.model_routing === 'on' ? 'on' : o.model_routing === 'off' ? 'off' : 'dry-run',
  fallback: o.fallback_model === 'haiku' || o.fallback_model === 'sonnet' || o.fallback_model === 'opus' ? o.fallback_model : 'session',
})

// Settings kept off the settings page (they are rarely changed) and set with
// /jev-model set. They live in $.store, apart from the plugin's userConfig.
const HIDDEN_KEY = 'advanced'
type HiddenSpec = { kind: 'number' | 'text'; min?: number; max?: number; chars?: number; what: string }
const HIDDEN: Record<string, HiddenSpec> = {
  jev_model: { kind: 'text', chars: 64, what: 'TypeSafe model id sent with each request' },
  timeout_ms: { kind: 'number', min: 1000, max: 9000, what: 'total time both Jev requests may take before the prompt goes on unrouted' },
  max_prompt_chars: { kind: 'number', min: 200, max: 20000, what: 'only the first N characters of a prompt are sent to Jev' },
  shortlist_size: { kind: 'number', min: 1, max: 12, what: 'how many top-ranked skills the second Jev request rereads' },
}

const BASE = readConfig({})

const hiddenDefault = (name: string): string | number => {
  switch (name) {
    case 'jev_model': return BASE.model
    case 'timeout_ms': return BASE.timeoutMs
    case 'max_prompt_chars': return BASE.maxPromptChars
    case 'shortlist_size': return BASE.shortlist
    default: return BASE.shortlist
  }
}

// A value stored out of range or of the wrong kind is ignored, so a bad
// store never breaks routing.
function applyHidden(c: Config, h: Record<string, unknown>) {
  c.model = typeof h.jev_model === 'string' && h.jev_model.trim() ? h.jev_model.trim().slice(0, 64) : BASE.model
  c.timeoutMs = num(h.timeout_ms, BASE.timeoutMs, 1000, 9000)
  c.maxPromptChars = Math.floor(num(h.max_prompt_chars, BASE.maxPromptChars, 200, 20000))
  c.shortlist = Math.floor(num(h.shortlist_size, BASE.shortlist, 1, 12))
  Object.assign(c, sharedConfig(S.options, h))
}

// Prompts a person sent; deliveries, notifications and triggers are skipped.
const ROUTED_ORIGINS = new Set(['composer', 'sdk', 'bridge', 'unclassified', 'auto-continuation'])

// The engine stamps every prompt it queues; an unstamped one (a test harness)
// is routed like a person's.
const isRoutedOrigin = (origin: PromptOrigin | undefined) =>
  origin === undefined ||
  ROUTED_ORIGINS.has(origin.kind) ||
  (origin.kind === 'plugin' && 'asUser' in origin && origin.asUser === true)

const isOwnPlugin = (origin: PromptOrigin | undefined, name: string) =>
  origin?.kind === 'plugin' && 'name' in origin && origin.name === name && !('asUser' in origin && origin.asUser)

const sha256Prefix = async (text: string) => {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return undefined
  }
}

export const hintBlock = (names: readonly string[]) =>
  [
    '<skill_relevance source="jev-router (TypeSafe Jev)">',
    names.length === 1
      ? `The skill \`${names[0]}\` appears relevant to this request. If it fits, load it with the Skill tool before acting; if it does not fit, ignore this hint.`
      : `These skills appear relevant to this request, most relevant first: ${names.map(n => `\`${n}\``).join(', ')}. Load the ones that fit with the Skill tool before acting; ignore any that do not fit.`,
    '</skill_relevance>',
  ].join('\n')

export const injectBlock = (name: string, body: string) =>
  [
    `<skill_instructions name="${name}" source="jev-router (TypeSafe Jev)" activation="injected-not-native">`,
    `jev-router judged the skill \`${name}\` relevant and injected its SKILL.md text below. This is not a native skill activation. Follow it only if it fits the request.`,
    '',
    body.slice(0, INJECT_CHARS),
    '</skill_instructions>',
  ].join('\n')

// A skill is named `plugin:skill` in the index and may be invoked bare.
const sameSkill = (a: string, b: string) => a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`)

type Round = {
  id: string
  selected: string[]
  delivery: Record<string, 'hint' | 'inject'>
  loaded: Set<string>
}

type Probe = { kind: 'retry' }

const EMPTY: Available = { models: {}, source: 'not-read', raw: [] }

// Module memory is this session's own (each conversation runs its own
// process): decisions never go to $.store, which every session shares.
const S: {
  config: Config
  index?: SkillIndex
  indexing?: Promise<SkillIndex>
  pending?: Round
  // Saved tools suggested for the running turn, until the shell runs one.
  hintedTools: SavedTool[]
  writes: Promise<void>
  roundSeq: number
  available: Available
  caps?: Caps
  version: string
  nextDecision?: Decision
  turnDecisions: Map<string, Decision>
  turnSteps: Map<string, Record<string, unknown>>
  hidden: Record<string, unknown>
  hiddenLoaded: boolean
  probeQueue: Probe[]
  pendingProbe?: Probe
  // Probe subagents started (by agent id), whose replies are kept out of the
  // conversation, and the families probed automatically in this load.
  probeAgents: Set<string>
  autoProbed: Set<Family>
  turnProbes: Map<string, Probe>
  failed: Set<Family>
  lastStep?: Record<string, unknown>
  subscription?: boolean
  options: PluginOptions
  cache: CacheState
  turnPlans: Map<string, { plan: Plan; advice?: CacheAdvice }>
  // Context windows Claude Code reported, for the session model only.
  windows: Partial<Record<Family, number>>
  outputs: OutputStats
  turnLengths: number[]
  // Main requests so far in each running turn.
  stepCounts: Map<string, number>
  executed?: { model: string; effort?: string | number }
  attempts: Map<string, AttemptFacts>
  lastAttempt?: AttemptFacts
  mainTurn?: string
} = {
  config: readConfig({}),
  writes: Promise.resolve(),
  roundSeq: 0,
  available: EMPTY,
  version: '',
  turnDecisions: new Map(),
  turnSteps: new Map(),
  hidden: {},
  hiddenLoaded: false,
  probeQueue: [],
  hintedTools: [],
  probeAgents: new Set(),
  autoProbed: new Set(),
  turnProbes: new Map(),
  failed: new Set(),
  options: {},
  cache: {},
  turnPlans: new Map(),
  windows: {},
  outputs: {},
  turnLengths: [],
  stepCounts: new Map(),
  attempts: new Map(),
}

// Conversation facts never go to $.store. session.end fires on clear/resume;
// the id check also covers hosts that replace a conversation without reloading.
function clearConversation(why: string, sessionId?: string) {
  S.cache = resetCache(S.cache, why, sessionId)
  S.nextDecision = undefined
  S.pending = undefined
  S.pendingProbe = undefined
  S.probeQueue = []
  S.turnDecisions.clear()
  S.turnSteps.clear()
  S.turnPlans.clear()
  S.turnProbes.clear()
  S.failed.clear()
  S.lastStep = undefined
  S.executed = undefined
  S.attempts.clear()
  S.lastAttempt = undefined
  S.mainTurn = undefined
}

async function checkSession($: EngineInterface) {
  const id = await $.session.id()
  if (S.cache.sessionId && S.cache.sessionId !== id) clearConversation('different-session', id)
  else S.cache = { ...S.cache, sessionId: id }
}

async function readContext($: EngineInterface) {
  let window: number | undefined
  try {
    const usage = await $.session.usage()
    S.cache = withContext(S.cache, usage.context.tokens)
    S.subscription = usage.rateLimits.length > 0
    window = usage.context.window
  } catch {
    S.cache = withContext(S.cache, undefined)
  }
  // The reported window is the session model's; a failure here costs only it.
  try {
    const family = familyOf(await $.session.model())
    if (family && typeof window === 'number' && Number.isFinite(window) && window > 0) S.windows = { ...S.windows, [family]: window }
  } catch {
    // No window known.
  }
}

async function recordStep($: EngineInterface, usage: UsageLike | null | undefined, sent: { model: string; effort?: string | number }, requestAt: number, entry: Record<string, unknown>) {
  S.cache = observeUsage(S.cache, usage, sent, requestAt)
  S.executed = usage?.model ? { model: usage.model, effort: usage.model === sent.model ? sent.effort : undefined } : undefined
  entry.observed_usage = usage ? { model: usage.model, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens } : null
  entry.request_started_at = requestAt
  entry.answered_by = usage?.model
  entry.effort_source = 'requested-not-confirmed'
  const turnId = String(entry.turn_id)
  const previous = S.attempts.get(turnId) ?? { ...EMPTY_ATTEMPT }
  const facts: AttemptFacts = { ...previous, modelRequestFailed: previous.modelRequestFailed || String(entry.fallback ?? '').startsWith('routed-request-failed') }
  S.attempts.set(turnId, facts)
  S.lastAttempt = facts
  entry.attempt_facts = facts
  if (usage?.model) await learnStep($, { model: usage.model, effort: usage.model === sent.model ? sent.effort : undefined }, usage.model === sent.model, 'main-step')
  if (usage?.model) await noteContextSeen($, usage.model, usage)
  if (entry.type === 'step') {
    const turn = String(entry.turn_id)
    S.stepCounts.set(turn, (S.stepCounts.get(turn) ?? 0) + 1)
    while (S.stepCounts.size > 50) {
      const oldest = S.stepCounts.keys().next().value
      if (oldest === undefined) break
      S.stepCounts.delete(oldest)
    }
  }
  if (entry.type === 'step' && usage?.model === sent.model) {
    const outputs = learnOutput(S.outputs, sent.effort, usage.output_tokens)
    if (outputs) {
      S.outputs = outputs
      try {
        await $.store.set(OUTPUTS_KEY, outputs)
      } catch {
        // Kept for this session only.
      }
    }
  }
  S.lastStep = entry
  S.turnSteps.set(String(entry.turn_id), entry)
  await log($, entry)
}

async function logFile($: EngineInterface) {
  const dir = await logDirectory($)
  if (!dir) return undefined
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  return `${dir}/${day}.jsonl`
}

async function logDirectory($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return undefined
  return `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/.claude/plugins/data/${LOG_DIR_NAME}/logs`
}

async function listLogFiles($: EngineInterface): Promise<{ directory?: string; files: string[]; available: boolean }> {
  const directory = await logDirectory($)
  if (!directory) return { files: [], available: false }
  try {
    if (!(await $.fs.exists(directory))) return { directory, files: [], available: true }
    const entries = await $.fs.list(directory)
    const files = entries
      .filter(entry => entry.kind === 'file' && /^\d{4}-\d{2}-\d{2}\.jsonl$/i.test(entry.name))
      .map(entry => `${directory}/${entry.name}`)
    return { directory, files, available: true }
  } catch {
    return { directory, files: [], available: false }
  }
}

// The filesystem facade has no unlink operation. Empty only the plugin's
// dated JSONL files; never touch adjacent plugin data or user files.
async function clearLogs($: EngineInterface, scope: 'today' | 'all') {
  let files: string[]
  try {
    await S.writes
    if (scope === 'today') {
      const file = await logFile($)
      if (!file) return { cleared: 0, failed: 1 }
      files = (await $.fs.exists(file)) ? [file] : []
    } else {
      const listed = await listLogFiles($)
      if (!listed.available) return { cleared: 0, failed: 1 }
      files = listed.files
    }
  } catch {
    return { cleared: 0, failed: 1 }
  }
  let cleared = 0
  let failed = 0
  for (const file of files) {
    try {
      await $.fs.write(file, '')
      cleared++
    } catch {
      failed++
    }
  }
  return { cleared, failed }
}

// Never the key, a header or the prompt's text: callers pass counts,
// hashes, names and scores only.
function log($: EngineInterface, entry: Record<string, unknown>) {
  // Off unless the person turned it on: nothing is written, no folder is made.
  if (!S.config.writeLog) return S.writes
  S.writes = S.writes.then(async () => {
    try {
      const file = await logFile($)
      if (!file) return
      const line = JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), ...entry })
      const before = (await $.fs.exists(file)) ? await $.fs.read(file) : ''
      await $.fs.write(file, `${before}${line}\n`)
    } catch {
      // Logging never breaks a prompt.
    }
  })
  return S.writes
}

async function readSkill($: EngineInterface, path: string): Promise<Found | undefined> {
  try {
    const parsed = parseSkillMd(await $.fs.read(path))
    return { ...parsed, body: parsed.body.slice(0, BODY_CHARS), path }
  } catch {
    return undefined
  }
}

// `<root>/<name>/SKILL.md` for each folder under root, read-only.
async function scanFolder($: EngineInterface, root: string, prefix: string, into: Map<string, Found>) {
  let entries
  try {
    entries = await $.fs.list(root)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
    const found = await readSkill($, `${root}/${entry.name}/SKILL.md`)
    if (!found) continue
    const key = prefix + (found.name ?? entry.name)
    if (!into.has(key)) into.set(key, found)
  }
}

async function scanFiles($: EngineInterface) {
  const files = new Map<string, Found>()

  // Project skills: every `.claude/skills` from the session's folder upward.
  try {
    let dir: string | undefined = norm(await $.session.cwd())
    for (let i = 0; dir && i < PROJECT_DEPTH; i++, dir = parent(dir)) {
      await scanFolder($, `${dir}/.claude/skills`, '', files)
    }
  } catch {
    // No cwd: project skills are left out.
  }

  const rawHome = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!rawHome) return files
  const home = norm(rawHome)

  await scanFolder($, `${home}/.claude/skills`, '', files)

  // Skills synced from claude.ai sit one bucket folder deeper.
  try {
    for (const bucket of await $.fs.list(`${home}/.claude/skills/synced`)) {
      if (bucket.kind === 'dir' && !bucket.name.startsWith('.')) {
        await scanFolder($, `${home}/.claude/skills/synced/${bucket.name}`, '', files)
      }
    }
  } catch {
    // No synced skills.
  }

  // Installed plugins' skills, named `<plugin>:<skill>`.
  try {
    const installed = JSON.parse(await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`)) as {
      plugins?: Record<string, { installPath?: string }[]>
    }
    for (const [id, installs] of Object.entries(installed.plugins ?? {})) {
      const plugin = id.split('@')[0] ?? id
      for (const install of installs) {
        if (install.installPath) await scanFolder($, `${norm(install.installPath)}/skills`, `${plugin}:`, files)
      }
    }
  } catch {
    // No installed plugins list.
  }

  return files
}

async function buildIndex($: EngineInterface): Promise<SkillIndex> {
  const files = await scanFiles($)
  let commands: Command[] = []
  try {
    commands = await $.command.list()
  } catch {
    commands = []
  }
  return assembleIndex(files, commands, $.plugin.name, await $.clock.now())
}

async function ensureIndex($: EngineInterface) {
  const now = await $.clock.now()
  if (S.index && now - S.index.builtAt < INDEX_TTL_MS) return S.index
  S.indexing ??= buildIndex($).finally(() => {
    S.indexing = undefined
  })
  S.index = await S.indexing
  return S.index
}

// The models this Claude Code build offers, read from its own /config Model row.
async function refreshModels($: EngineInterface) {
  try {
    S.available = availableFrom(await $.config.list())
  } catch {
    S.available = { models: {}, source: 'config-list-failed', raw: [] }
  }
  return S.available
}

async function loadHidden($: EngineInterface) {
  try {
    S.hidden = ((await $.store.get(HIDDEN_KEY)) ?? {}) as Record<string, unknown>
  } catch {
    // Defaults stand.
  }
  applyHidden(S.config, S.hidden)
  S.hiddenLoaded = true
}

const allNames = () => [...Object.keys(SHARED), ...Object.keys(HIDDEN)].join(', ')

// Validates and saves one setting in its own home; it applies at once.
async function setHidden($: EngineInterface, name: string, raw: string | undefined) {
  if (!S.hiddenLoaded) await loadHidden($)
  const shared = SHARED[name]
  if (shared) {
    const value = settingValue(S.options, name, S.hidden)
    if (raw === undefined) return `jev-router: ${name} = ${String(value)} (default ${String(shared.default)}). Use /jev-model set ${name} <value>.`
    const parsed = parseSetting(name, raw)
    if (parsed === undefined) {
      const hint = shared.options?.join('|') ?? (shared.kind === 'text' ? '1 to 500 characters' : shared.kind === 'boolean' ? 'true|false' : `${shared.min} to ${shared.max}${shared.integer ? ', whole numbers' : ''}`)
      return `jev-router: invalid ${name}; use ${hint}. Nothing changed.`
    }
    if (shared.where === 'page') return setShared($, name, parsed)
    S.hidden = { ...S.hidden, [name]: parsed }
    await $.store.set(HIDDEN_KEY, S.hidden)
    applyHidden(S.config, S.hidden)
    return `jev-router: ${name} = ${String(parsed)} (default ${String(shared.default)}). Applied now.`
  }
  const spec = HIDDEN[name]
  if (!spec) return `jev-router: unknown setting "${name}". Settings: ${allNames()}.`
  if (raw === undefined) return `jev-router: ${name} = ${String(S.hidden[name] ?? hiddenDefault(name))} (default ${String(hiddenDefault(name))}). Use /jev-model set ${name} <value>.`
  let value: string | number
  if (spec.kind === 'number') {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < (spec.min ?? 0) || n > (spec.max ?? Infinity)) {
      return `jev-router: ${name} must be a whole number between ${spec.min} and ${spec.max}; nothing changed.`
    }
    value = n
  } else {
    value = raw.trim()
    if (!value || value.length > (spec.chars ?? 500)) return `jev-router: ${name} must be 1 to ${spec.chars} characters; nothing changed.`
  }
  S.hidden = { ...S.hidden, [name]: value }
  await $.store.set(HIDDEN_KEY, S.hidden)
  applyHidden(S.config, S.hidden)
  return `jev-router: ${name} = ${String(value)} (default ${String(hiddenDefault(name))}). Applied now.`
}

async function unsetHidden($: EngineInterface, name: string) {
  if (!S.hiddenLoaded) await loadHidden($)
  const shared = SHARED[name]
  if (shared?.where === 'page') return setShared($, name, shared.default)
  if (!shared && !HIDDEN[name]) return `jev-router: unknown setting "${name}". Settings: ${allNames()}.`
  const { [name]: _gone, ...rest } = S.hidden
  S.hidden = rest
  if (Object.keys(rest).length > 0) await $.store.set(HIDDEN_KEY, rest)
  else await $.store.delete(HIDDEN_KEY)
  applyHidden(S.config, S.hidden)
  return `jev-router: ${name} is back to its default (${String(shared ? shared.default : hiddenDefault(name))}).`
}

function hiddenText() {
  const row = (name: string, value: unknown, fallback: unknown, what: string, range = '') =>
    `${name} = ${String(value)}${value === fallback ? '  [default]' : `  [changed; default ${String(fallback)}]`}\n    ${what}${range}`
  return [
    'jev-router settings. Change with /jev-model set <name> <value>, restore with /jev-model unset <name>, all with /jev-model defaults.',
    'On the settings page:',
    ...Object.entries(SHARED).filter(([, spec]) => spec.where === 'page').map(([name, spec]) => row(name, settingValue(S.options, name, S.hidden), spec.default, spec.what)),
    'Kept off the page (saved in $.store):',
    ...Object.entries(SHARED).filter(([, spec]) => spec.where === 'store').map(([name, spec]) => row(name, settingValue(S.options, name, S.hidden), spec.default, spec.what)),
    ...Object.entries(HIDDEN).map(([name, spec]) => row(name, S.hidden[name] ?? hiddenDefault(name), hiddenDefault(name), spec.what, spec.min !== undefined ? ` (${spec.min} to ${spec.max})` : '')),
  ].join('\n')
}

// A settings-page value, saved through /config.
async function setShared($: EngineInterface, name: string, value: string | number | boolean) {
  const rows = await $.config.list()
  const row = rows.find(r => r.key.endsWith(`.${name}`) && r.key.includes($.plugin.name))
  if (!row) return `jev-router: no /config row for ${name}; nothing changed. Reload the plugin and use its settings.`
  if (row.isLocked) return `jev-router: ${name} is locked; nothing changed.`
  await $.config.set({ key: row.key, value: value as never })
  S.options = { ...S.options, [name]: value }
  applyHidden(S.config, S.hidden)
  return `jev-router: ${name} = ${String(settingValue(S.options, name, S.hidden))}. Applied now and saved to the settings page.`
}

// Probe results hold for one Claude Code version; an update asks for a new probe.
async function loadCaps($: EngineInterface) {
  try {
    S.version = (await $.session.version()).version
    const stored = (await $.store.get(CAPS_KEY)) as Caps | undefined
    S.caps = stored && stored.version === S.version ? stored : undefined
  } catch {
    S.caps = undefined
  }
  try {
    S.outputs = normalizeStats(await $.store.get(OUTPUTS_KEY))
    const lengths = await $.store.get(TURNLEN_KEY)
    S.turnLengths = Array.isArray(lengths) ? lengths.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0).slice(-KEPT_TURN_LENGTHS) : []
  } catch {
    S.outputs = {}
    S.turnLengths = []
  }
}

// The cache settings with what this session shows: a subscription caches
// for an hour.
const horizonNow = () => horizonFor(Number(S.config.cost.horizon), S.turnLengths)
const costNow = () => ({ horizon: horizonNow().horizon, tolerance: S.config.cost.tolerance })
const cacheNow = () => ({ ...S.config.cache, breakevenTurns: horizonNow().horizon, subscription: S.subscription === true })

async function saveCaps($: EngineInterface, update: (caps: Caps) => Caps) {
  const caps = update(S.caps ?? { version: S.version, families: {} })
  S.caps = caps
  try {
    await $.store.set(CAPS_KEY, caps)
  } catch {
    // Kept for this session only.
  }
}

// Records what a step the engine resolved says about its family: the full id
// and whether it takes effort. Written only when something changed.
async function learnStep($: EngineInterface, step: { model: string; effort?: unknown }, answered: boolean, source: string) {
  if (!S.version) await loadCaps($)
  const base = S.caps ?? { version: S.version, families: {} }
  const next = learn(base, step as { model: string; effort?: string | number }, answered, source, new Date().toISOString())
  if (next) await saveCaps($, () => next)
}

// Starts one tiny background subagent on a family's alias: the engine
// resolves the alias (agent.spawn answers the full id) and the subagent's
// first step shows effort support. Its reply is kept out of the conversation.
async function probeFamily($: EngineInterface, family: Family, alias: string): Promise<{ line: string; started: boolean }> {
  try {
    const r = await $.agent.spawn({ prompt: PROBE_TEXT, description: 'jev-router model probe', model: alias })
    if (r.deny !== undefined) return { line: `${family}: refused (${r.deny})`, started: false }
    if (r.agentId) S.probeAgents.add(r.agentId)
    await learnStep($, { model: r.model }, false, 'probe-spawn')
    return {
      line: familyOf(r.model) && r.model.toLowerCase() !== family
        ? `${family}: ${alias} resolves to ${r.model}; its subagent is running`
        : `${family}: subagent started; its full id is learned from its first step`,
      started: true,
    }
  } catch (err) {
    return { line: `${family}: could not start a subagent (${err instanceof Error ? err.message.slice(0, 120) : 'error'}); switch to it once with /model instead`, started: false }
  }
}

const isKnown = (family: Family) => {
  const known = S.caps?.families[family]
  return Boolean(known?.id && known.ok && known.effort !== undefined)
}

// Probes, without being asked, each listed family whose id or effort support
// is not known (first use, a Claude Code update) or that the caller names (a
// routed request failed on it). Each family at most once per load.
async function autoProbe($: EngineInterface, why: string, only?: Family): Promise<Family[]> {
  if (!S.config.autoProbe || S.config.routing === 'off') return []
  if (S.available.source === 'not-read') await refreshModels($)
  if (!S.version) await loadCaps($)
  const due = (Object.entries(S.available.models) as [Family, string][])
    .filter(([family]) => (only ? family === only : !isKnown(family)) && !S.autoProbed.has(family))
  if (due.length === 0) return []
  const lines: string[] = []
  const started: Family[] = []
  for (const [family, alias] of due) {
    S.autoProbed.add(family)
    const probed = await probeFamily($, family, alias)
    lines.push(probed.line)
    if (probed.started) started.push(family)
  }
  await log($, { type: 'probe', kind: 'auto', why, families: due.map(([f]) => f), result: lines })
  $.ui.toast(`jev-router: learning ${due.map(([f]) => f).join(', ')} (${why}; one tiny background request each)`)
  return started
}

// Holds a message until the probes it started have taught their families, or
// the wait runs out: a probe that never answers must not stall the chat.
async function waitForProbes($: EngineInterface, families: readonly Family[], waitMs: number): Promise<boolean> {
  const until = (await $.clock.now()) + waitMs
  while (!families.every(isKnown)) {
    const left = until - (await $.clock.now())
    if (left <= 0) return false
    await $.clock.sleep(Math.min(PROBE_POLL_MS, left))
  }
  return true
}

// The session's model as the full id the caps know// The session's model as the full id the caps know, before a response was seen.
async function sessionStep($: EngineInterface): Promise<Step | undefined> {
  try {
    const family = familyOf(await $.session.model())
    const id = family ? S.caps?.families[family]?.id : undefined
    return id ? { model: id } : undefined
  } catch {
    return undefined
  }
}

// The tiers a decision may pick: listed by this Claude Code, not failed this
// session, and either the current one or learned (id seen answering, effort
// support known), since the engine refuses a bare alias.
const routableFamilies = (current: Step | undefined): Family[] =>
  (Object.keys(S.available.models) as Family[]).filter(family => {
    if (S.failed.has(family)) return false
    if (family === familyOf(current?.model)) return true
    const known = S.caps?.families[family]
    return Boolean(known?.id && known.ok && known.effort !== undefined)
  })

// Records the context a response came back over, as evidence of what that
// model holds (main and subagent responses alike).
async function noteContextSeen($: EngineInterface, model: string, usage: UsageLike) {
  const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
  if (!parts.every(n => typeof n === 'number' && Number.isFinite(n))) return
  const total = (parts as number[]).reduce((a, b) => a + b, 0)
  const next = S.caps ? noteContext(S.caps, model, total) : undefined
  if (next) await saveCaps($, () => next)
}

// ---- saved tools. Two lists in $.store, kept out of the project and of Git:
// one per project (by a hash of its folder) and one global.
const GLOBAL_TOOLS_KEY = 'tools:global'
const PROJECT_TOOLS_PREFIX = 'tools:project:'

async function projectToolsKey($: EngineInterface) {
  let cwd = ''
  try {
    cwd = (await $.session.cwd()).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  } catch {
    // The hash of nothing: one shared project list.
  }
  return `${PROJECT_TOOLS_PREFIX}${(await sha256Prefix(cwd)) ?? 'unknown'}`
}

async function loadTools($: EngineInterface): Promise<{ project: SavedTool[]; global: SavedTool[] }> {
  try {
    return { project: readLibrary(await $.store.get(await projectToolsKey($)), 'project'), global: readLibrary(await $.store.get(GLOBAL_TOOLS_KEY), 'global') }
  } catch {
    return { project: [], global: [] }
  }
}

async function writeTools($: EngineInterface, scope: Scope, list: readonly SavedTool[]) {
  await $.store.set(scope === 'global' ? GLOBAL_TOOLS_KEY : await projectToolsKey($), list)
}

type SavedToolFileCleanup = { deleted: number; shared: number; missing: number; protected: number; failed: number }
type ToolFileReference = { path: string; realPath?: string; unresolved?: boolean }

const emptyToolFileCleanup = (): SavedToolFileCleanup => ({ deleted: 0, shared: 0, missing: 0, protected: 0, failed: 0 })

// Compare saved paths across projects without changing Linux/macOS case
// semantics. Windows drive paths and UNC paths are case-insensitive.
function toolPathKey(path: string) {
  const flat = path.replace(/\\/g, '/')
  const unc = flat.startsWith('//')
  let normalized = flat.replace(/\/{2,}/g, '/')
  if (unc && !normalized.startsWith('//')) normalized = `/${normalized}`
  while (normalized.length > 1 && normalized.endsWith('/') && !/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.slice(0, -1)
  return /^[A-Za-z]:\//.test(normalized) || unc ? normalized.toLowerCase() : normalized
}

async function toolFileReference($: EngineInterface, path: string): Promise<ToolFileReference> {
  try {
    const stat = await $.fs.stat(path, { resolve: true })
    return { path, realPath: stat.realPath, unresolved: stat.realPath === undefined }
  } catch {
    try {
      return { path, unresolved: await $.fs.exists(path) }
    } catch {
      return { path, unresolved: true }
    }
  }
}

async function deleteSavedToolFile($: EngineInterface, path: string): Promise<boolean> {
  const cwd = await $.session.cwd().catch(() => '')
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(cwd)
  let exitCode: number
  if (windows) {
    // Keep the path in the child environment so PowerShell never parses it as
    // part of the command. File.Delete removes one file and never recurses.
    const result = await $.process.run(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'try { [System.IO.File]::Delete($env:JEV_ROUTER_DELETE_PATH); exit 0 } catch { exit 1 }'],
      { env: { JEV_ROUTER_DELETE_PATH: path }, timeoutMs: 10000 },
    )
    exitCode = result.exitCode
  } else {
    // argv execution (no shell) and no recursive flag: this can unlink only
    // the exact file registered by save_tool.
    const result = await $.process.run(['rm', '-f', '--', path], { timeoutMs: 10000 })
    exitCode = result.exitCode
  }
  return exitCode === 0 && !(await $.fs.exists(path))
}

// An entry is eligible only after its index was removed, and only if every
// remaining project/global index can be read and none still refers to that
// file. Symlinks, directories and missing paths are not followed or removed.
async function deleteUnreferencedToolFiles($: EngineInterface, paths: readonly string[]): Promise<SavedToolFileCleanup> {
  const result = emptyToolFileCleanup()
  const uniquePaths = [...new Map(paths.map(path => [toolPathKey(path), path])).values()]
  const candidates = new Map<string, { path: string; realPath: string }>()

  for (const path of uniquePaths) {
    let stat
    try {
      stat = await $.fs.stat(path, { resolve: true })
    } catch {
      result.missing++
      continue
    }
    if (stat.kind !== 'file' || stat.isLink || !stat.realPath) {
      result.protected++
      continue
    }
    const realKey = toolPathKey(stat.realPath)
    if (!candidates.has(realKey)) candidates.set(realKey, { path, realPath: stat.realPath })
  }

  let keys: string[]
  try {
    keys = await $.store.keys()
  } catch {
    result.failed += candidates.size
    return result
  }
  const references: ToolFileReference[] = []
  let couldNotAudit = false
  for (const key of keys.filter(k => k === GLOBAL_TOOLS_KEY || k.startsWith(PROJECT_TOOLS_PREFIX))) {
    try {
      const kind: Scope = key === GLOBAL_TOOLS_KEY ? 'global' : 'project'
      for (const tool of readLibrary(await $.store.get(key), kind)) {
        const reference = await toolFileReference($, tool.path)
        if (reference.unresolved) couldNotAudit = true
        references.push(reference)
      }
    } catch {
      couldNotAudit = true
    }
  }
  if (couldNotAudit) {
    result.failed += candidates.size
    return result
  }

  for (const { path, realPath } of candidates.values()) {
    const pathKey = toolPathKey(path)
    const realKey = toolPathKey(realPath)
    if (references.some(ref => toolPathKey(ref.path) === pathKey || (ref.realPath !== undefined && toolPathKey(ref.realPath) === realKey))) {
      result.shared++
      continue
    }
    try {
      if (await deleteSavedToolFile($, path)) result.deleted++
      else result.failed++
    } catch {
      result.failed++
    }
  }
  return result
}

function toolFileCleanupText(result: SavedToolFileCleanup) {
  return ` Script files: ${result.deleted} deleted, ${result.shared} still referenced, ${result.missing} missing, ${result.protected} skipped (not plain files), ${result.failed} failed.`
}

// The save_tool call: validate, check the file exists, ask Jev whether it will
// serve other work (an unreachable Jev does not block a save), then keep it.
async function saveToolCall($: EngineInterface, input: unknown): Promise<SaveResult> {
  const config = S.config
  if (!config.enabled || !config.key || !config.tools.save) return { status: 'unavailable', reason: !config.key ? 'no-key' : 'tool-saving-disabled' }
  const prepared = prepareTool(input, [config.key])
  if (!('tool' in prepared)) return prepared
  const { tool } = prepared
  if (!(await $.fs.exists(tool.path))) return { status: 'invalid_request', reason: 'path does not exist; write the file to a durable location first.' }
  if (!S.hiddenLoaded) await loadHidden($)
  // A tool the person registered under this name is theirs: not asked about, not replaced.
  const library = await loadTools($)
  const existing = (tool.scope === 'global' ? library.global : library.project).find(t => t.name === tool.name)
  if (existing && isUserTool(existing)) return { status: 'declined', reason: 'A tool registered by the user already has this name, so it was not replaced. Use another name.', name: tool.name, scope: tool.scope }
  let reusable: number | undefined
  if (config.tools.saveThreshold > 0) {
    const started = await $.clock.now()
    try {
      const reply = await sender($, started + config.timeoutMs)(JSON.stringify({ model: config.model, state: { tool: { name: tool.name, description: tool.description, usage: tool.usage, scope: tool.scope }, note: 'Judged from the description alone; no code or file content is sent.' }, questions: { reusable: saveQuestion(tool) } }))
      reusable = reply.status >= 200 && reply.status < 300 ? parseReusable(reply.text) : undefined
    } catch {
      reusable = undefined
    }
  }
  if (reusable !== undefined && reusable < config.tools.saveThreshold) {
    await log($, { type: 'tool', action: 'declined', name: tool.name, scope: tool.scope, reusable })
    return { status: 'declined', reason: 'Jev judged this tool unlikely to serve other work, so it was not saved.', name: tool.name, scope: tool.scope, reusable }
  }
  const saved = upsertTool(tool.scope === 'global' ? library.global : library.project, tool, config.tools.max, await $.clock.now())
  if (saved.refused) return { status: 'declined', reason: saved.refused === 'full' ? 'The list is full of tools registered by the user, so nothing could be dropped to make room.' : 'A tool registered by the user already has this name.', name: tool.name, scope: tool.scope }
  await writeTools($, tool.scope, saved.list)
  await log($, { type: 'tool', action: saved.updated ? 'updated' : 'saved', name: tool.name, scope: tool.scope, reusable: reusable ?? null, evicted: saved.evicted ?? null })
  return { status: saved.updated ? 'updated' : 'saved', name: tool.name, scope: tool.scope, ...(reusable !== undefined ? { reusable } : {}), ...(saved.evicted ? { evicted: saved.evicted } : {}) }
}

// A shell command that runs a tool suggested this turn counts as a use.
async function noteToolUse($: EngineInterface, command: string) {
  const used = S.hintedTools.filter(t => usesTool(command, t))
  if (used.length === 0) return
  S.hintedTools = S.hintedTools.filter(t => !used.includes(t))
  const library = await loadTools($)
  const now = await $.clock.now()
  for (const tool of used) {
    const list = tool.scope === 'global' ? library.global : library.project
    await writeTools($, tool.scope, touchTool(list, tool.name, now))
    await log($, { type: 'tool', action: 'used', name: tool.name, scope: tool.scope })
  }
}

const toolLine = async ($: EngineInterface, t: SavedTool) => `  ${t.name}${isUserTool(t) ? ' [yours]' : ''} · used ${t.used} · ${t.description} · ${t.usage}${(await $.fs.exists(t.path)) ? '' : ' [file missing]'}`

// /jev-tool add <name> <absolute path> [project|global] <description>: the
// person's own tool. Not judged by Jev, never cleared in bulk, its file never
// deleted by the plugin, and not counted against the maximum.
async function addUserTool($: EngineInterface, args: readonly string[]): Promise<string> {
  const usage = 'jev-router: /jev-tool add <name> <absolute path> [project|global] <what it does>'
  const [name, path, ...rest] = args
  if (!name || !path) return usage
  const scope = rest[0] === 'project' || rest[0] === 'global' ? rest.shift() as Scope : 'project'
  const prepared = prepareTool({ name, path, scope, description: rest.join(' '), usage: 'Read the file, then run it as it describes.' }, [S.config.key])
  if (!('tool' in prepared)) return `jev-router: ${prepared.reason ?? 'invalid tool'}\n${usage}`
  const { tool } = prepared
  if (!(await $.fs.exists(tool.path))) return `jev-router: no file at ${tool.path}.`
  const library = await loadTools($)
  const saved = upsertTool(tool.scope === 'global' ? library.global : library.project, tool, S.config.tools.max, await $.clock.now(), 'user')
  await writeTools($, tool.scope, saved.list)
  await log($, { type: 'tool', action: saved.updated ? 'updated' : 'registered', name: tool.name, scope: tool.scope, origin: 'user' })
  return `jev-router: ${saved.updated ? 'updated' : 'registered'} ${tool.name} (${tool.scope}). It is yours: bulk clears leave it and its file is never deleted.`
}

async function toolStatus($: EngineInterface) {
  const c = S.config.tools
  const library = await loadTools($)
  return `tools: selection ${c.routing ? 'on' : 'off'} (suggested at ≥ ${c.threshold}, up to ${c.hints}); Claude may save ${c.save ? 'on' : 'off'} (saved when Jev judges ≥ ${c.saveThreshold} reusable, up to ${c.max} per scope); ${library.project.length} project, ${library.global.length} global. Manage with /jev-tool.`
}

// /jev-tool: list, show, clear, and the two switches.
async function toolCommand($: EngineInterface, raw: string): Promise<string> {
  const rawArgs = raw.trim().split(/\s+/).filter(Boolean)
  const keepFiles = rawArgs.includes('--keep-files')
  const deleteFiles = rawArgs.includes('--delete-files')
  const args = rawArgs.filter(arg => arg !== '--delete-files' && arg !== '--keep-files')
  const verb = (args[0] ?? 'list').toLowerCase()
  const scopeArg = (args.at(-1) ?? '').toLowerCase()
  const scopes: Scope[] = scopeArg === 'project' ? ['project'] : scopeArg === 'global' ? ['global'] : ['project', 'global']
  if (keepFiles && deleteFiles) return 'jev-router: use either --keep-files or --delete-files, not both.'
  if ((keepFiles || deleteFiles) && verb !== 'clear') return 'jev-router: file options are available with /jev-tool clear.'
  if (verb === 'on' || verb === 'off') {
    const saved = await setOption($, 'tool_routing', verb === 'on')
    if (saved.includes('is now')) S.config.tools = { ...S.config.tools, routing: verb === 'on' }
    return saved.includes('is now') ? `jev-router: tool selection is now ${verb} (saved to settings; the plugin reloads).` : saved
  }
  if (verb === 'save' && (args[1] === 'on' || args[1] === 'off')) {
    const saved = await setOption($, 'tool_save', args[1] === 'on')
    if (saved.includes('is now')) S.config.tools = { ...S.config.tools, save: args[1] === 'on' }
    return saved.includes('is now') ? `jev-router: letting Claude save tools is now ${args[1]} (saved to settings; the plugin reloads).` : saved
  }
  if (verb === 'add') return addUserTool($, args.slice(1))
  const library = await loadTools($)
  if (verb === 'list') {
    const lines = [await toolStatus($)]
    for (const scope of ['project', 'global'] as const) {
      const list = scope === 'project' ? library.project : library.global
      if (list.length === 0) continue
      lines.push(`${scope}:`)
      for (const t of list) lines.push(await toolLine($, t))
    }
    if (library.project.length + library.global.length === 0) lines.push('No tools saved yet. Claude saves one with save_tool when it notices repeated work; register your own with /jev-tool add.')
    return lines.join('\n')
  }
  if (verb === 'show') {
    const name = args[1]
    const t = name ? [...library.project, ...library.global].find(x => x.name === name) : undefined
    return t ? [`${t.name} (${t.scope}, ${isUserTool(t) ? 'registered by you' : 'saved by an assistant'})`, `description: ${t.description}`, `run: ${t.usage}`, `file: ${t.path}${(await $.fs.exists(t.path)) ? '' : ' [missing]'}`, `used ${t.used} times`].join('\n') : `jev-router: no saved tool named ${name ?? '(none given)'}.`
  }
  if (verb === 'clear') {
    const target = (args[1] ?? '').toLowerCase()
    if (!target || ['project', 'global'].includes(target) || args.length > 3) return 'jev-router: /jev-tool clear <name | all | missing> [project|global] [--keep-files|--delete-files]'
    const removed: string[] = []
    const filePaths: string[] = []
    for (const scope of scopes) {
      const list = scope === 'project' ? library.project : library.global
      let keep = list
      // all and missing clear only what an assistant saved: the person's own stay.
      if (target === 'all') keep = list.filter(isUserTool)
      else if (target === 'missing') {
        keep = []
        for (const t of list) if (isUserTool(t) || (await $.fs.exists(t.path))) keep.push(t)
      } else if (args[1] !== undefined && list.some(t => t.name === args[1])) {
        // A name clears from the first layer that has it (project first), unless one is named.
        if (removed.length > 0) continue
        keep = list.filter(t => t.name !== args[1])
      }
      if (keep.length !== list.length) {
        await writeTools($, scope, keep)
        removed.push(`${list.length - keep.length} from ${scope}`)
        const kept = new Set(keep)
        // A script file is deleted only for what an assistant saved.
        filePaths.push(...list.filter(t => !kept.has(t) && !isUserTool(t)).map(t => t.path))
      }
    }
    const yours = (target === 'all' || target === 'missing') ? scopes.reduce((n, scope) => n + (scope === 'project' ? library.project : library.global).filter(isUserTool).length, 0) : 0
    const keptNote = yours > 0 ? ` ${yours} tool${yours === 1 ? '' : 's'} registered by you ${yours === 1 ? 'was' : 'were'} kept.` : ''
    if (removed.length === 0) return `jev-router: nothing to clear.${keptNote}`
    const cleanup = keepFiles ? undefined : await deleteUnreferencedToolFiles($, filePaths)
    return `jev-router: cleared ${removed.join(', ')}.${cleanup ? toolFileCleanupText(cleanup) : ' Script files were kept (--keep-files).'}${keptNote}`
  }
  return 'jev-router: /jev-tool list | show <name> | add <name> <path> [project|global] <what it does> | clear <name | all | missing> [project|global] [--keep-files|--delete-files] | on | off | save on|off'
}

async function clearLearnedData($: EngineInterface) {
  let removed = 0
  let failed = 0
  for (const key of [CAPS_KEY, OUTPUTS_KEY, TURNLEN_KEY]) {
    try {
      if ((await $.store.get(key)) !== undefined) {
        await $.store.delete(key)
        removed++
      }
    } catch {
      failed++
    }
  }
  S.caps = undefined
  S.outputs = {}
  S.turnLengths = []
  S.autoProbed.clear()
  S.windows = {}
  clearConversation('manual-clear')
  return { removed, failed }
}

async function clearToolMetadata($: EngineInterface, scope: 'project' | 'global' | 'all', deleteFiles = true) {
  let keys: string[]
  try {
    keys = await $.store.keys()
  } catch {
    const files = deleteFiles ? emptyToolFileCleanup() : undefined
    if (files) files.failed = 1
    return { registries: 0, entries: 0, kept: 0, failed: 1, files }
  }
  const currentProjectKey = scope === 'project' ? await projectToolsKey($) : undefined
  const targets = keys.filter(key =>
    scope === 'global' ? key === GLOBAL_TOOLS_KEY
      : scope === 'project' ? key === currentProjectKey
        : key === GLOBAL_TOOLS_KEY || key.startsWith(PROJECT_TOOLS_PREFIX),
  )
  let registries = 0
  let entries = 0
  let kept = 0
  let failed = 0
  const filePaths: string[] = []
  for (const key of targets) {
    try {
      const kind: Scope = key === GLOBAL_TOOLS_KEY ? 'global' : 'project'
      const list = readLibrary(await $.store.get(key), kind)
      const mine = list.filter(isUserTool)
      // What an assistant saved goes; what the person registered stays.
      if (mine.length > 0) await $.store.set(key, mine)
      else await $.store.delete(key)
      registries++
      entries += list.length - mine.length
      kept += mine.length
      filePaths.push(...list.filter(t => !isUserTool(t)).map(t => t.path))
    } catch {
      failed++
    }
  }
  S.hintedTools = []
  const files = deleteFiles ? await deleteUnreferencedToolFiles($, filePaths) : undefined
  return { registries, entries, kept, failed, files }
}

async function localDataText($: EngineInterface) {
  const [logs, keys, rawCaps, rawOutputs, rawTurnLengths] = await Promise.all([
    listLogFiles($), $.store.keys(), $.store.get(CAPS_KEY), $.store.get(OUTPUTS_KEY), $.store.get(TURNLEN_KEY),
  ])
  const caps = rawCaps as Caps | undefined
  const outputs = normalizeStats(rawOutputs)
  const outputSamples = Object.values(outputs).reduce((sum, rows) => sum + (rows?.length ?? 0), 0)
  const turnLengths = Array.isArray(rawTurnLengths) ? rawTurnLengths.length : 0
  let projectTools = 0
  let globalTools = 0
  for (const key of keys.filter(k => k === GLOBAL_TOOLS_KEY || k.startsWith(PROJECT_TOOLS_PREFIX))) {
    const kind: Scope = key === GLOBAL_TOOLS_KEY ? 'global' : 'project'
    try {
      const count = readLibrary(await $.store.get(key), kind).length
      if (kind === 'global') globalTools += count
      else projectTools += count
    } catch {
      // An unreadable library is not counted.
    }
  }
  const logText = logs.available ? `${logs.files.length} dated file(s)` : 'unavailable'
  return [
    'jev-router local data:',
    `logs: ${logText}`,
    `learned: ${Object.keys(caps?.families ?? {}).length} model families, ${outputSamples} output samples, ${turnLengths} turn lengths`,
    `saved tool indexes: ${projectTools} project, ${globalTools} global (script files live at their saved paths)`,
    'Preserved separately: plugin settings and API key.',
    'Clearing saved-tool indexes covers what assistants saved (a cache) and also deletes their unshared script files; add --keep-files to keep the files. Tools you registered with /jev-tool add are kept by every bulk clear and their files are never deleted; files still referenced by any saved-tool index are preserved.',
    'Commands: /jev-log clear [today|all] · /jev-data clear logs [today|all] | learned | tools [project|global|all] [--keep-files] | all [--keep-files]',
  ].join('\n')
}

async function dataCommand($: EngineInterface, raw: string): Promise<string> {
  const args = raw.trim().split(/\s+/).filter(Boolean).map(v => v.toLowerCase())
  if (args.length === 0 || args[0] === 'list' || args[0] === 'status') return localDataText($)
  if (args[0] !== 'clear') return 'jev-router: /jev-data [status | clear logs [today|all] | clear learned | clear tools [project|global|all] [--keep-files] | clear all [--keep-files]]'
  const area = args[1]
  if (area === 'logs') {
    if (args.length > 3) return 'jev-router: /jev-data clear logs [today|all]'
    const scope = args[2] ?? 'all'
    if (scope !== 'today' && scope !== 'all') return 'jev-router: /jev-data clear logs [today|all]'
    const result = await clearLogs($, scope)
    return result.failed > 0
      ? `jev-router: cleared ${result.cleared} ${scope} log file(s); ${result.failed} could not be accessed.`
      : `jev-router: cleared the contents of ${result.cleared} ${scope} log file(s). Logging will continue if enabled.`
  }
  if (area === 'learned') {
    if (args.length !== 2) return 'jev-router: /jev-data clear learned'
    const result = await clearLearnedData($)
    return `jev-router: cleared ${result.removed} learned-data store(s) and this session's routing facts.${result.failed ? ` ${result.failed} store(s) could not be cleared.` : ''}`
  }
  if (area === 'tools') {
    const keepFiles = args.includes('--keep-files')
    const deleteFiles = args.includes('--delete-files')
    const positional = args.filter(arg => arg !== '--delete-files' && arg !== '--keep-files')
    if (keepFiles && deleteFiles) return 'jev-router: use either --keep-files or --delete-files, not both.'
    if (positional.length > 3 || args.some(arg => arg.startsWith('--') && arg !== '--delete-files' && arg !== '--keep-files')) return 'jev-router: /jev-data clear tools [project|global|all] [--keep-files]'
    const scope = positional[2] ?? 'all'
    if (scope !== 'project' && scope !== 'global' && scope !== 'all') return 'jev-router: /jev-data clear tools [project|global|all] [--keep-files]'
    const result = await clearToolMetadata($, scope, !keepFiles)
    const scripts = result.files ? toolFileCleanupText(result.files) : ' Script files were kept (--keep-files).'
    return `jev-router: cleared ${result.entries} saved tool entr${result.entries === 1 ? 'y' : 'ies'} in ${result.registries} ${scope} index(es).${scripts}${result.kept ? ` ${result.kept} tool${result.kept === 1 ? '' : 's'} registered by you ${result.kept === 1 ? 'was' : 'were'} kept.` : ''}${result.failed ? ` ${result.failed} index(es) could not be cleared.` : ''}`
  }
  if (area === 'all' && (args.length === 2 || (args.length === 3 && (args[2] === '--keep-files' || args[2] === '--delete-files')))) {
    const keepFiles = args[2] === '--keep-files'
    const logs = await clearLogs($, 'all')
    const learned = await clearLearnedData($)
    const tools = await clearToolMetadata($, 'all', !keepFiles)
    return [
      `jev-router: clear all: logs ${logs.cleared} file(s)${logs.failed ? `, ${logs.failed} failed` : ''}; learned data ${learned.removed} store(s)${learned.failed ? `, ${learned.failed} failed` : ''}; saved tool indexes ${tools.entries} entr${tools.entries === 1 ? 'y' : 'ies'}${tools.failed ? `, ${tools.failed} failed` : ''}${tools.kept ? ` (${tools.kept} registered by you kept)` : ''}.${tools.files ? toolFileCleanupText(tools.files) : ''}`,
      keepFiles ? 'Plugin settings, the API key, and saved tool script files were kept (--keep-files).' : 'Plugin settings and the API key were kept.',
    ].join('\n')
  }
  return 'jev-router: /jev-data [status | clear logs [today|all] | clear learned | clear tools [project|global|all] [--keep-files] | clear all [--keep-files]]'
}

// consult: Claude asks Jev which skill or saved tool fits, before starting.
// Jev reads the task and the recent conversation; nothing is loaded or run.
async function consultCall($: EngineInterface, input: unknown): Promise<ConsultResult> {
  const config = S.config
  if (!config.enabled || !config.key) return { status: 'unavailable', reason: !config.key ? 'no-key' : 'disabled' }
  const prepared = prepareConsult(input)
  if (!('task' in prepared)) return prepared
  if (!S.hiddenLoaded) await loadHidden($)
  const started = await $.clock.now()
  const skills = config.skillRouting ? (await ensureIndex($)).skills : []
  const library = config.tools.routing ? await loadTools($) : undefined
  const toolOptions = library ? mergeTools(library.project, library.global) : []
  if (skills.length === 0 && toolOptions.length === 0) return { status: 'nothing_fits', reason: 'there are no skills or saved tools to choose from' }
  const sent = scrubText(prepared.task, [config.key])
  let messages
  if (config.awareness.enabled && config.awareness.maxChars > 0) {
    try { messages = await $.session.messages() } catch { /* unknown */ }
  }
  const recent = recentContext(messages, sent, { ...config.awareness, maxChars: Math.min(config.awareness.maxChars, Math.max(0, STATE_CHAR_BUDGET - STATE_RESERVE - sent.length)) }, [config.key])
  const result = await route(
    sent,
    skills,
    { model: config.model, gateThreshold: config.gateThreshold, fitsThreshold: config.fitsThreshold, shortlist: config.shortlist, modelFamilies: [], recentContext: recent.text, tools: toolOptions },
    sender($, started + config.timeoutMs),
    () => $.clock.now(),
  )
  if (result.outcome === 'error') {
    await log($, { type: 'consult', outcome: 'error', reason: result.reason, task_chars: sent.length, jev_calls: result.calls, total_ms: (await $.clock.now()) - started })
    return { status: 'unavailable', reason: result.reason ?? 'jev failure' }
  }
  const pickedTools: { tool: SavedTool; probability: number }[] = []
  for (const p of pickTools(result.tools, toolOptions, config.tools.threshold, config.tools.hints)) {
    if (await $.fs.exists(p.tool.path)) pickedTools.push(p)
  }
  // The same bookkeeping as a hint: a picked skill's load and a picked tool's use are noted.
  S.pending = result.selected.length > 0 ? { id: `consult-${started.toString(36)}`, selected: result.selected.map(s => s.name), delivery: Object.fromEntries(result.selected.map(s => [s.name, 'hint' as const])), loaded: new Set() } : undefined
  S.hintedTools = pickedTools.map(p => p.tool)
  await log($, {
    type: 'consult',
    outcome: result.selected.length + pickedTools.length > 0 ? 'picked' : 'nothing_fits',
    reason: result.reason,
    task_chars: sent.length,
    index_size: skills.length,
    tools: toolOptions.length > 0 ? { options: toolOptions.length, none: result.tools?.none ?? null, picked: pickedTools.map(p => ({ name: p.tool.name, scope: p.tool.scope, probability: p.probability })) } : undefined,
    gate: result.gate,
    shortlist: result.shortlist,
    fits: result.fits,
    selected: result.selected,
    jev_calls: result.calls,
    total_ms: (await $.clock.now()) - started,
  })
  $.ui.status(`jev: consulted · skill ${result.selected.map(s => s.name).join(', ') || '-'} · tool ${pickedTools.map(p => p.tool.name).join(', ') || '-'}`)
  if (result.selected.length + pickedTools.length === 0) return { status: 'nothing_fits', reason: result.reason }
  return {
    status: 'picked',
    skills: result.selected.map(s => ({ name: s.name, fits: s.fits, probability: s.probability })),
    tools: pickedTools.map(p => ({ name: p.tool.name, scope: p.tool.scope, probability: p.probability, usage: p.tool.usage, path: p.tool.path, origin: isUserTool(p.tool) ? 'user' as const : 'assistant' as const })),
  }
}

// A line in the conversation that the person sees and the model never reads.
async function chatNotice($: EngineInterface, text: string) {
  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
  } catch {
    // A host that refuses the row still has the status line and the log.
  }
}

function sender($: EngineInterface, deadline: number): Send {
  return async body => {
    const remaining = deadline - (await $.clock.now())
    if (remaining <= 0) throw new JevError('timeout')
    const abort = new AbortController()
    const timeout = new Promise<never>((_, reject) => {
      $.clock.sleep(remaining, { signal: abort.signal }).then(
        () => reject(new JevError('timeout')),
        () => {},
      )
    })
    const request = $.http
      .fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${S.config.key}`, 'Content-Type': 'application/json' },
        body,
      })
      .then(
        r => ({ status: r.status, text: r.text }),
        () => {
          throw new JevError('network')
        },
      )
    try {
      return await Promise.race([request, timeout])
    } finally {
      abort.abort()
    }
  }
}

async function noteLoad($: EngineInterface, skill: string, via: string) {
  const round = S.pending
  const already = round ? [...round.loaded].some(n => sameSkill(n, skill)) : false
  if (round) round.loaded.add(skill)
  if (already) return
  await log($, {
    type: 'load',
    round: round?.id,
    skill,
    routed: round?.selected.some(n => sameSkill(n, skill)) ?? false,
    via,
  })
}

async function finishRound($: EngineInterface, why: string) {
  const round = S.pending
  S.pending = undefined
  if (!round) return
  const status = round.selected.map(name => ({
    skill: name,
    delivery: round.delivery[name],
    status: [...round.loaded].some(n => sameSkill(n, name))
      ? 'native-loaded'
      : round.delivery[name] === 'inject'
        ? 'injected'
        : 'not-loaded',
  }))
  const others = [...round.loaded].filter(n => !round.selected.some(s => sameSkill(s, n)))
  await log($, { type: 'turn', round: round.id, why, skills: status, other_native_loads: others })
}

// Saves one of this plugin's userConfig fields through /config; the plugin reloads.
async function setOption($: EngineInterface, field: string, value: string | boolean) {
  const rows = await $.config.list()
  const row = rows.find(r => r.key.endsWith(`.${field}`) && r.key.includes($.plugin.name))
  if (!row) return `jev-router: no /config row for ${field} was found. Run /reload-plugins and try again, or set it in the plugin's settings.`
  await $.config.set({ key: row.key, value })
  return `jev-router: ${field} is now ${value} (saved to settings; the plugin reloads).`
}

// Settings kept when everything else goes back to its default.
const KEPT_ON_RESET = new Set(['typesafe_api_key', 'reset_to_defaults'])

// Puts every setting back to the default its manifest declares, the API key
// excepted, then turns the reset switch off. Safe to run again: a plugin
// reload part-way leaves the switch on, and the next load finishes the rest.
async function resetDefaults($: EngineInterface): Promise<string[]> {
  const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as {
    userConfig?: Record<string, { default?: unknown }>
  }
  const rows = await $.config.list()
  const rowOf = (field: string) => rows.find(r => r.key.endsWith(`.${field}`) && r.key.includes($.plugin.name))
  const changed: string[] = []
  for (const [field, spec] of Object.entries(manifest.userConfig ?? {})) {
    if (KEPT_ON_RESET.has(field) || spec.default === undefined) continue
    const row = rowOf(field)
    if (!row || row.value === spec.default) continue
    await $.config.set({ key: row.key, value: spec.default as never })
    changed.push(field)
  }
  for (const name of Object.keys(S.hidden)) changed.push(name)
  S.hidden = {}
  try {
    await $.store.delete(HIDDEN_KEY)
  } catch {
    // Nothing stored.
  }
  for (const [field, spec] of Object.entries(manifest.userConfig ?? {})) {
    if (!KEPT_ON_RESET.has(field) && spec.default !== undefined) S.options = { ...S.options, [field]: spec.default as string | number | boolean }
  }
  Object.assign(S.config, readConfig(S.options))
  applyHidden(S.config, S.hidden)
  const flag = rowOf('reset_to_defaults')
  if (flag && flag.value === true) await $.config.set({ key: flag.key, value: false as never })
  return changed
}

function statusText() {
  const c = S.config
  const fams = Object.entries(S.available.models).map(([f, m]) => `${f}=${m}`).join(', ') || 'none found'
  const fam = (f: Family) => {
    const v = S.caps?.families[f]
    if (!v?.id) return `${f}: id not learned`
    const effort = v.effort === undefined ? 'effort unknown' : v.effort ? 'takes effort' : 'no effort'
    return `${f}: ${v.id}, ${v.ok ? 'seen answering' : 'not seen answering yet'}, ${effort} (from ${v.source ?? '?'})`
  }
  const known = (Object.keys(S.available.models) as Family[]).map(fam).join('; ') || 'nothing to learn'
  const retry = S.caps?.retryOk === undefined ? 'untested' : S.caps.retryOk ? 'works' : 'does not work'
  const caps = `Claude Code ${S.version || '?'}: ${known} | resend after a failed step: ${retry}`
  const last = S.lastStep
    ? `last step: ${String(S.lastStep.from_model)} → ${String(S.lastStep.sent_model)} (answered by ${String(S.lastStep.answered_by ?? '?')}), effort ${String(S.lastStep.from_effort ?? '-')} → ${String(S.lastStep.sent_effort ?? '-')} [${(S.lastStep.reasons as string[] | undefined)?.join(', ') ?? ''}]`
    : 'no routed step yet'
  return [
    `jev-router model routing: ${c.routing} (the cheapest tier/effort Jev judges ≥ ${c.feasibleThreshold} feasible, the likeliest among those within ${Math.round(c.cost.tolerance * 100)}% of its cost; costed over ${horizonNow().horizon} requests (${horizonNow().source}); fallback ${c.fallback} when Jev gives no answer)`,
    `skill selection: ${c.skillRouting ? 'on' : 'off'} (gate ≥ ${c.gateThreshold}, fits ≥ ${c.fitsThreshold}, shortlist ${c.shortlist}, load mode ${c.mode}, selection ${c.selectionMode})`,
    `saved tools: selection ${c.tools.routing ? 'on' : 'off'}, saving ${c.tools.save ? 'on' : 'off'} (see /jev-tool)`,
    `decision routing: ${c.decisionRouting ? 'on' : 'off'} (assistant-owned judgments only; confidence threshold ${c.decisionConfidence})`,
    `models from this Claude Code (${S.available.source}): ${fams}`,
    `log: ${c.writeLog ? 'on' : 'off'}`,
    `learned: ${caps}`,
    `failed this session: ${[...S.failed].join(', ') || 'none'}`,
    `subscription rate limits seen: ${S.subscription === undefined ? 'not yet' : S.subscription ? 'yes' : 'no'}`,
    `costs: cache TTL ${c.cache.ttl}${c.cache.ttl === 'auto' ? ` (${S.subscription ? '1h, subscription' : '5m until a subscription or a 1h write is seen'})` : ''}; output per request ${EFFORTS.filter(e => (S.outputs[e]?.length ?? 0) > 0).map(e => `${e} ${median(S.outputs[e]!)} tokens (${S.outputs[e]!.length} seen)`).join(', ') || 'not seen yet'}; effort changes are not costed as a cache rebuild`,
    `Jev context: recent excerpts ${c.awareness.enabled ? 'on' : 'off'} (${c.awareness.messages} messages, ${c.awareness.maxChars} chars)`,
    last,
    ...(S.lastStep ? [cacheText(S.lastStep)] : []),
    'commands: /jev-model on | dry-run | off (model routing) | skills on | off | cache | fallback <session|haiku|sonnet|opus> | settings | set | unset | defaults | probe | reset | models · /jev-log [clear] · /jev-data',
  ].join('\n')
}

function feasibleText(step: Record<string, unknown>) {
  const f = step.jev_feasible as Record<string, Record<string, number>> | undefined
  if (!f || Object.keys(f).length === 0) return ''
  return ` · feasibility ${Object.entries(f).map(([family, levels]) => `${family} ${Object.entries(levels).map(([e, v]) => `${e} ${v}`).join('/')}`).join(', ')} (Jev judgment, not a measured success rate)`
}

function cacheText(step: Record<string, unknown>) {
  const advice = step.cache_advice as CacheAdvice | undefined
  const observed = step.observed_usage as UsageLike | undefined
  const recommendation = step.final_recommended as { model?: string; effort?: string | number } | undefined
  const jev = step.jev_recommended as { how?: string; usd?: number } | undefined
  const estimate = advice?.estimate
  const cost = estimate ? `estimated switch premium ${estimate.switchingPremium.toFixed(6)} API-equivalent USD, breakeven ${estimate.breakevenTurns ?? 'never in this scenario'} future turns` : 'estimated switch cost/breakeven unknown'
  return `final ${recommendation?.model ?? '?'}/${recommendation?.effort ?? '-'} · ${jev?.how ?? 'no decision'}${jev?.usd !== undefined ? ` ~$${jev.usd}` : ''} · cache ${advice?.evidence.status ?? 'unknown'} [${advice?.reason ?? 'unavailable'}/${advice?.effortReason ?? 'unavailable'}] · observed read/write ${observed?.cache_read_input_tokens ?? 'unknown'}/${observed?.cache_creation_input_tokens ?? 'unknown'} tokens · ${cost}${feasibleText(step)}`
}

export const register: Register = (on, options) => {
  S.options = { ...options }
  S.config = readConfig(options)
  const config = S.config
  S.index = undefined
  S.hiddenLoaded = false

  on('session.start', async ($, e, next) => {
    await checkSession($)
    await $.command.register({ name: 'jev-log', description: 'Show recent Jev router rounds and clear local logs', argumentHint: '[clear [today|all]]' })
    await $.command.register({
      name: 'jev-data',
      description: 'Inspect or clear Jev router logs and local learned data',
      argumentHint: '[status | clear logs [today|all] | clear learned | clear tools [project|global|all] [--keep-files] | clear all [--keep-files]]',
    })
    await $.command.register({ name: 'jev-index', description: 'Show the skills the Jev router can pick from' })
    await $.command.register({
      name: 'jev-tool',
      description: 'Saved tools Jev can suggest: list, show, clear, switches',
      argumentHint: 'list | show <name> | add <name> <path> [project|global] <what it does> | clear <name|all|missing> [project|global] [--keep-files] | on | off | save on|off',
    })
    await $.command.register({
      name: 'jev-model',
      description: 'Jev routing: status, model on/dry-run/off, skills on/off, cache, fallback, settings, set, unset, defaults, probe, reset, models',
      argumentHint: 'status | on | dry-run | off | skills on|off | cache | fallback <model> | settings | set <name> <value> | unset <name> | defaults | probe | reset | models',
    })
    if (config.resetRequested) {
      try {
        const changed = await resetDefaults($)
        await log($, { type: 'reset', via: 'setting', changed })
        $.ui.toast(`jev-router: settings reset to defaults (${changed.length} changed)`)
      } catch {
        // The switch stays on; the next load tries again.
      }
    }
    await refreshModels($)
    await loadCaps($)
    await loadHidden($)
    if (config.enabled && config.key && config.tools.save) {
      await $.tool.register({ name: 'save_tool', description: SAVE_DESCRIPTION, inputSchema: SAVE_SCHEMA, isDeferred: false })
    }
    if (config.enabled && config.key && config.selectionMode === 'consult' && (config.skillRouting || config.tools.routing)) {
      await $.tool.register({ name: 'consult', description: CONSULT_DESCRIPTION, inputSchema: CONSULT_SCHEMA, isDeferred: false })
    }
    if (config.enabled && config.key && config.decisionRouting) {
      await $.tool.register({ name: 'decide', description: DECISION_DESCRIPTION, inputSchema: DECISION_SCHEMA, isDeferred: false })
    }
    await log($, {
      type: 'session',
      enabled: config.enabled,
      has_key: config.key.length > 0,
      mode: config.mode,
      skill_routing: config.skillRouting,
      selection_mode: config.selectionMode,
      routing: config.routing,
      gate_threshold: config.gateThreshold,
      fits_threshold: config.fitsThreshold,
      feasibility_threshold: config.feasibleThreshold,
      fallback: config.fallback,
      claude_code: S.version,
      models: S.available.models,
      models_source: S.available.source,
      probed: S.caps !== undefined,
    })
    return next(e)
  })

  // A stable system section keeps the policy available during tool loops and
  // after compaction. Only add it to prompts actually offering the tool.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!config.enabled || !config.key) return result
    let sections = result.sections
    const add = (id: string, text: string) => {
      sections = [...sections.filter(s => s.id !== id), { id, text, scope: 'session' as const }]
    }
    if (config.decisionRouting && e.tools.includes(DECISION_TOOL)) add('jev-router:decisions', DECISION_INSTRUCTIONS)
    if (config.tools.save && e.tools.includes(SAVE_TOOL)) add('jev-router:tools', SAVE_INSTRUCTIONS)
    if (config.selectionMode === 'consult' && e.tools.includes(CONSULT_TOOL)) {
      add('jev-router:consult', consultInstructions(config.routing !== 'off'))
    }
    return sections === result.sections ? result : { ...result, sections }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__jev-router__save_tool' }, async ($, e) => {
    const result = await saveToolCall($, { name: e.name, description: e.description, usage: e.usage, path: e.path, scope: e.scope })
    return { result: saveText(result) }
  }).catch(() => ({ result: saveText({ status: 'unavailable', reason: 'tool-hook-failed' }) }))

  on('tool.call', { tool: 'mcp__jev-router__consult' }, async ($, e) => {
    return { result: consultText(await consultCall($, { task: e.task })) }
  }).catch(() => ({ result: consultText({ status: 'unavailable', reason: 'consult-hook-failed' }) }))

  // A saved tool the shell ran counts as a use.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (S.hintedTools.length > 0 && result.deny === undefined && result.isError !== true) await noteToolUse($, String((e as { command?: unknown }).command ?? ''))
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'jev-tool' }, async ($, e) => ({ text: await toolCommand($, e.args) }))

  on('tool.call', { tool: 'mcp__jev-router__decide' }, async ($, e) => {
    const input = { decision_owner: e.decision_owner, authority: e.authority, state: e.state, questions: e.questions }
    const prepared = prepareDecision(input, [config.key])
    if ('status' in prepared) return { result: decisionText(prepared) }
    if (!config.enabled || !config.key || !config.decisionRouting) return { result: decisionText({ status: 'unavailable', reason: !config.key ? 'no-key' : 'decision-routing-disabled' }) }
    if (!S.hiddenLoaded) await loadHidden($)
    const started = await $.clock.now()
    const result = await evaluateDecision(prepared, config.model, config.decisionConfidence, sender($, started + config.timeoutMs))
    // Question ids, rubrics, facts, options and answers are model-authored text:
    // keep only counts and numeric call metadata in the optional log.
    await log($, { type: 'decision', outcome: result.status, question_count: Object.keys(prepared.questions).length, uncertain_count: result.uncertain?.length ?? 0, threshold: config.decisionConfidence, total_ms: (await $.clock.now()) - started })
    return { result: decisionText(result) }
  }).catch(() => ({ result: decisionText({ status: 'unavailable', reason: 'decision-hook-failed' }) }))

  on('prompt.submit', async ($, e, next) => {
    await checkSession($)
    const origin = e.origin as PromptOrigin | undefined

    // A probe subagent's reply ("OK") would enter the conversation as another
    // session's message and start a turn: it is kept out, with one short line.
    if ((origin as { kind?: string } | undefined)?.kind === 'peer') {
      const agent = [...S.probeAgents].find(id => e.text.includes(id))
      if (agent) {
        S.probeAgents.delete(agent)
        return { drop: 'jev-router: model probe finished' }
      }
    }

    // The probe's own prompts: bind the next probe to the turn they start.
    const id = `${(await $.clock.now()).toString(36)}-${++S.roundSeq}`

    // An armed retry check rides the person's next message ($.prompt.submit
    // does not start a turn in every host, the VS Code panel among them).
    if (S.probeQueue.length > 0 && e.turnId === undefined && isRoutedOrigin(origin) && !isOwnPlugin(origin, $.plugin.name)) {
      const probe = S.probeQueue.shift()
      S.pendingProbe = probe
      S.nextDecision = undefined
      await finishRound($, 'superseded')
      await log($, {
        type: 'round',
        round: id,
        origin: origin?.kind ?? 'none',
        outcome: 'skipped',
        reason: 'probe',
        probe: 'retry check',
        probes_left: S.probeQueue.length,
      })
      return next(e)
    }
    const text = e.text
    const midTurn = e.turnId !== undefined
    const base = {
      round: id,
      origin: origin?.kind ?? 'none',
      prompt: { chars: text.length, sha256_12: await sha256Prefix(text) },
    }

    if (!midTurn) {
      await finishRound($, 'superseded')
      S.nextDecision = undefined
      S.hintedTools = []
    }

    const skip = (reason: string) => log($, { type: 'round', ...base, outcome: 'skipped', reason }).then(() => next(e))
    if (!config.enabled) return skip('disabled')
    if (!config.key) return skip('no-key')
    if (!isRoutedOrigin(origin)) return skip('origin')
    if (text.trimStart().startsWith('/')) return skip('slash-command')
    if (text.trim().length === 0) return skip('empty')

    // Before the deadline is worked out: it uses the stored timeout.
    if (!S.hiddenLoaded) await loadHidden($)
    // Probing comes first: a message that needs a probe (first use, a new
    // Claude Code) waits for it to end, then Jev chooses the model.
    let chosen = ''
    if (!midTurn && config.routing !== 'off' && config.autoProbe && config.probeWaitMs > 0) {
      const probing = await autoProbe($, 'first use on this Claude Code')
      if (probing.length > 0) {
        $.ui.status(`jev: probing ${probing.join(', ')} before choosing a model`)
        const waitStart = await $.clock.now()
        const done = await waitForProbes($, probing, config.probeWaitMs)
        await log($, { type: 'probe', kind: 'wait', families: probing, done, waited_ms: (await $.clock.now()) - waitStart })
      }
    }
    const started = await $.clock.now()
    const deadline = started + config.timeoutMs
    // Skill selection off: no index is built and no skill is asked about.
    // In consult mode Claude asks for skills and tools itself, so neither is asked here.
    const consulting = config.selectionMode === 'consult'
    const skills = config.skillRouting && !consulting ? (await ensureIndex($)).skills : []
    // Saved tools Jev may pick from: the project's and the global ones, a
    // project tool hiding a global one of the same name.
    const library = config.tools.routing && !consulting ? await loadTools($) : undefined
    const toolOptions = library ? mergeTools(library.project, library.global) : []
    if (S.available.source === 'not-read') await refreshModels($)
    if (!S.version) await loadCaps($)
    // The prompt, then the conversation excerpts, share one state budget Jev can take.
    const sent = scrubText(text, [config.key]).slice(0, Math.min(config.maxPromptChars, STATE_CHAR_BUDGET - STATE_RESERVE))
    let messages
    if (config.awareness.enabled && config.awareness.maxChars > 0) {
      try { messages = await $.session.messages() } catch { /* unknown; never reuse another session's transcript */ }
    }
    const recent = recentContext(messages, text, { ...config.awareness, maxChars: Math.min(config.awareness.maxChars, Math.max(0, STATE_CHAR_BUDGET - STATE_RESERVE - sent.length)) }, [config.key])
    if (config.routing !== 'off') await readContext($)
    // Before any response was seen (a fresh session, a plugin reload), the
    // session model stands in for the current one so context costs are known.
    const current = config.routing === 'off' ? undefined : S.executed ?? await sessionStep($)
    const families = config.routing === 'off' ? [] : routableFamilies(current)
    const facts = config.routing !== 'off' ? routingFacts(S.cache, current, S.caps, S.failed, S.lastAttempt, await $.clock.now(), cacheNow(), S.windows, S.executed ? 'last-response' : 'session-model') : undefined

    const result: RouteResult = await route(
      sent,
      skills,
      {
        model: config.model,
        gateThreshold: config.gateThreshold,
        fitsThreshold: config.fitsThreshold,
        shortlist: config.shortlist,
        modelFamilies: families,
        effortLevels: config.effortLevels,
        modelDescriptions: config.modelDescriptions,
        recentContext: recent.text,
        routingContext: facts,
        tools: toolOptions,
      },
      sender($, deadline),
      () => $.clock.now(),
    )

    // Jev judged each tier and effort; the cheapest feasible pair runs.
    const evidence = cacheEvidence(S.cache, await $.clock.now(), cacheNow())
    if (consulting && result.reason === 'empty-index') result.reason = 'consult-mode'
    else if (!config.skillRouting && result.reason === 'empty-index') result.reason = 'skill-routing-off'

    const decision = decide(id, result.feasible, families, (family: Family, effort: Effort) => {
      const known = S.caps?.families[family]
      const model = known?.id ?? (family === familyOf(current?.model) ? current?.model : undefined)
      return pairCost(model, effort, current, evidence, S.outputs, costNow())
    }, config.feasibleThreshold, config.cost.tolerance)
    // A prompt typed during a turn joins that turn: its decision stands.
    if (!midTurn && config.routing !== 'off') {
      S.nextDecision = decision
      // The moment Jev decides: the status line says what it chose. Whether the
      // chat panel draws it is host-dependent; the model and effort the panel
      // shows are the session's and cannot be set from a mod.
      const chose = `${decision.family ?? `keep(${decision.modelReason ?? '-'})`}/${decision.effort ?? `keep(${decision.effortReason ?? '-'})`}`
      chosen = `${chose}${config.routing === 'dry-run' ? ' (dry-run)' : ''}`
      $.ui.status(`jev: model ${chosen}`)
    }

    const delivery: Record<string, 'hint' | 'inject'> = {}
    const context: string[] = []
    if (result.outcome === 'selected') {
      const hinted: string[] = []
      for (const s of result.selected) {
        const body = config.mode === 'inject' ? skills.find(k => k.name === s.name)?.body : undefined
        if (body) {
          context.push(injectBlock(s.name, body))
          delivery[s.name] = 'inject'
        } else {
          hinted.push(s.name)
          delivery[s.name] = 'hint'
        }
      }
      if (hinted.length > 0) context.unshift(hintBlock(hinted))
      if (!midTurn) S.pending = { id, selected: result.selected.map(s => s.name), delivery, loaded: new Set() }
    }

    // A tool Jev picked is suggested only if its file is still there.
    const pickedTools: { tool: SavedTool; probability: number }[] = []
    let staleTools = 0
    for (const p of pickTools(result.tools, toolOptions, config.tools.threshold, config.tools.hints)) {
      if (await $.fs.exists(p.tool.path)) pickedTools.push(p)
      else staleTools++
    }
    if (pickedTools.length > 0) {
      context.push(toolHint(pickedTools))
      if (!midTurn) S.hintedTools = pickedTools.map(p => p.tool)
    }
    // What Jev chose, in one line: the model, then any skill or tool.
    if (!midTurn) {
      // Always all three, so "nothing chosen" shows as plainly as a choice.
      const skillText = consulting ? 'consult' : !config.skillRouting ? 'off' : result.selected.length > 0 ? result.selected.map(s => s.name).join(', ') : 'none'
      const toolText = consulting ? 'consult' : !config.tools.routing ? 'off' : pickedTools.length > 0 ? pickedTools.map(p => p.tool.name).join(', ') : 'none'
      const summary = `model ${chosen || 'off'} · skill ${skillText} · tool ${toolText}`
      $.ui.status(`jev: ${summary}`)
      if (config.chatNotice) await chatNotice($, `jev-router: ${summary}`)
    }

    await log($, {
      type: 'round',
      ...base,
      mid_turn: midTurn,
      sent_chars: sent.length,
      index_size: skills.length,
      skill_routing: config.skillRouting,
      selection_mode: config.selectionMode,
      tools: toolOptions.length > 0 ? { options: toolOptions.length, none: result.tools?.none ?? null, picked: pickedTools.map(p => ({ name: p.tool.name, scope: p.tool.scope, probability: p.probability })), stale: staleTools } : undefined,
      mode: config.mode,
      outcome: result.outcome,
      reason: result.reason,
      gate: result.gate,
      shortlist: result.shortlist,
      fits: result.fits,
      rerank_confidence: result.rerankConfidence,
      selected: result.selected,
      delivery,
      model_routing: config.routing,
      jev_feasible: result.feasible,
      cost_basis: config.routing !== 'off' ? { context_tokens: evidence.contextTokens ?? null, cache: evidence.status, ttl: evidence.ttlSource, horizon: horizonNow().horizon, horizon_source: horizonNow().source, tolerance: config.cost.tolerance, outputs: outputSummary(S.outputs) } : undefined,
      candidates: decision.candidates?.map(c => ({ pair: `${c.family}/${c.effort}`, ...c, family: undefined, effort: undefined })),
      awareness: { source: recent.source, messages: recent.messages, chars: recent.text.length, truncated: recent.truncated },
      decision: {
        family: decision.family,
        effort: decision.effort,
        how: decision.how,
        reason: decision.modelReason,
        usd: decision.usd,
        threshold: decision.feasibleThreshold,
      },
      jev_calls: result.calls,
      total_ms: (await $.clock.now()) - started,
    })

    // No match or an error: the prompt goes on untouched, so Claude's own
    // skill behaviour stands.
    if (context.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...context] })
  }).catch(($, e, next) => next(e))

  // The turn's id first appears here: bind the decision (or probe) to it.
  on('turn.start', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId !== undefined) return next(e)
    await checkSession($)
    S.mainTurn = e.turnId
    await autoProbe($, 'first use on this Claude Code')
    S.attempts.set(e.turnId, { ...EMPTY_ATTEMPT })
    while (S.attempts.size > KEPT_TURNS) {
      const oldest = S.attempts.keys().next().value
      if (oldest === undefined) break
      S.attempts.delete(oldest)
    }
    S.turnPlans.delete(e.turnId)
    if (S.pendingProbe) {
      S.turnProbes.set(e.turnId, S.pendingProbe)
      S.pendingProbe = undefined
    } else if (S.nextDecision) {
      S.turnDecisions.set(e.turnId, S.nextDecision)
      S.nextDecision = undefined
      while (S.turnDecisions.size > KEPT_TURNS) {
        const oldest = S.turnDecisions.keys().next().value
        if (oldest === undefined) break
        S.turnDecisions.delete(oldest)
        S.turnPlans.delete(oldest)
        S.turnSteps.delete(oldest)
        S.attempts.delete(oldest)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    // Subagents keep the model they were started with; their steps still
    // teach which full id each family resolves to (a probe spawns them).
    if (e.agentId !== undefined) {
      const result = yield* next(e)
      if (result.usage?.model === e.model) await learnStep($, e, true, 'subagent-step')
      if (result.usage?.model) await noteContextSeen($, result.usage.model, result.usage)
      return result
    }
    await checkSession($)

    const probe = S.turnProbes.get(e.turnId)
    if (probe) {
      let requestAt = await $.clock.now()
      let first
      try {
        first = yield* next({ ...e, model: PROBE_BAD_MODEL })
      } catch {
        first = undefined
      }
      if (first?.usage) {
        await saveCaps($, c => ({ ...c, retryOk: false }))
        await recordStep($, first.usage, { model: PROBE_BAD_MODEL, effort: e.effort }, requestAt, { type: 'probe', kind: 'retry', turn_id: e.turnId, sent_model: PROBE_BAD_MODEL, sent_effort: e.effort, retry_ok: false })
        return first
      }
      requestAt = await $.clock.now()
      const again = yield* next(e)
      await saveCaps($, c => ({ ...c, retryOk: again.usage !== null }))
      await recordStep($, again.usage, e, requestAt, { type: 'probe', kind: 'retry', turn_id: e.turnId, sent_model: e.model, sent_effort: e.effort, retry_ok: again.usage !== null })
      return again
    }

    const decision = S.turnDecisions.get(e.turnId)
    let frozen = S.turnPlans.get(e.turnId)
    if (!frozen) {
      await readContext($)
      // Actual response history supplies evidence, never a cache routing veto.
      // Preserve the original planStep confidence/capability/fallback behavior.
      const actual = S.executed
      const baseline = actual && decision
        ? { ...e, model: actual.model, effort: actual.effort ?? (actual.model === e.model ? e.effort : undefined) }
        : e
      const ideal = planStep(e, decision, config.routing === 'off' ? 'off' : 'on', S.caps, S.failed, config.fallback)
      const model = ideal.model
      const proposedEffort = ideal.effort
      // Only a named level is ever introduced (never a numeric budget carried
      // over from another request); the engine's own pass through unchanged.
      const effort = proposedEffort === e.effort || proposedEffort === undefined || isEffort(proposedEffort) ? proposedEffort : e.effort
      const advice = decision && config.routing !== 'off'
        ? cacheAdvice(baseline, { model, effort }, S.cache, await $.clock.now(), cacheNow())
        : undefined
      frozen = {
        plan: {
          model, effort, changed: false,
          wouldModel: model !== e.model ? model : undefined,
          wouldEffort: effort !== e.effort ? String(effort ?? 'none') : undefined,
          reasons: [...(config.routing === 'dry-run' ? ['dry-run'] : []), ...ideal.reasons],
        }, advice,
      }
      S.turnPlans.set(e.turnId, frozen)
      while (S.turnPlans.size > KEPT_TURNS) {
        const oldest = S.turnPlans.keys().next().value
        if (oldest === undefined) break
        S.turnPlans.delete(oldest)
        S.turnSteps.delete(oldest)
        S.attempts.delete(oldest)
      }
    }
    const final = frozen.plan
    const apply = config.routing === 'on' && decision !== undefined
    const plan = apply
      ? { ...final, changed: final.model !== e.model || final.effort !== e.effort }
      : { ...final, model: e.model, effort: e.effort, changed: false }
    const target = familyOf(plan.model)
    const entry: Record<string, unknown> = {
      type: 'step',
      round: decision?.round,
      turn: e.turnId.slice(-8),
      turn_id: e.turnId,
      index: e.index,
      routing: config.routing,
      from_model: e.model,
      from_effort: e.effort,
      sent_model: plan.model,
      sent_effort: plan.effort,
      would_model: plan.wouldModel,
      would_effort: plan.wouldEffort,
      reasons: plan.reasons,
      jev_recommended: decision ? { model: decision.family, effort: decision.effort, how: decision.how ?? decision.modelReason, usd: decision.usd } : undefined,
      jev_feasible: decision?.feasible,
      final_recommended: { model: final.model, effort: final.effort },
      cache_advice: frozen.advice,
    }
    let requestAt = await $.clock.now()
    if (!plan.changed) {
      const result = yield* next(e)
      entry.stop = result.stopReason
      await recordStep($, result.usage, e, requestAt, entry)
      return result
    }

    let sent = { ...e, model: plan.model, effort: plan.effort as typeof e.effort }
    let result
    let failure: unknown
    let streamed = false
    let failed = false
    let reprobes = 0
    for (;;) {
      result = undefined
      failure = undefined
      try {
        const stream = next(sent)
        let completed = false
        try {
          let item = await stream.next()
          while (!item.done) {
            streamed = true
            yield item.value
            item = await stream.next()
          }
          result = item.value
          completed = true
        } finally {
          if (!completed) await stream.return(undefined as never)
        }
      } catch (err) {
        failure = err
      }
      failed = !next.signal.aborted && result?.usage == null && result?.stopReason == null
      const family = familyOf(sent.model)
      // The routed request failed: back to the probe, which relearns the id and
      // is waited for, then the same pair is asked again. Twice at most; then
      // the fallback. Only where a failed step is known to be safe to send again.
      if (!failed || !family || reprobes >= MAX_REPROBES || !config.autoProbe || !S.caps?.retryOk || streamed) break
      reprobes++
      S.autoProbed.delete(family)
      const probing = await autoProbe($, `a routed request to ${family} failed (probe ${reprobes} of ${MAX_REPROBES})`, family)
      if (probing.length > 0) await waitForProbes($, probing, config.probeWaitMs)
      sent = { ...sent, model: S.caps?.families[family]?.id ?? sent.model }
      entry.reprobes = reprobes
      requestAt = await $.clock.now()
    }
    if (reprobes > 0 && !failed) {
      // A later step of this turn goes the way this one did.
      entry.sent_model = sent.model
      S.turnPlans.set(e.turnId, { plan: { ...final, model: sent.model, effort: sent.effort }, advice: frozen.advice })
    }
    if (failed) {
      const target = familyOf(sent.model)
      if (target) {
        S.failed.add(target)
        // Its id may have changed with an update: learn it again, and wait.
        if (reprobes === 0) {
          const probing = await autoProbe($, `a routed request to ${target} failed`, target)
          if (probing.length > 0) await waitForProbes($, probing, config.probeWaitMs)
        }
      }
      entry.fallback = reprobes > 0 ? `routed-request-failed after ${reprobes} probe${reprobes === 1 ? '' : 's'}` : 'routed-request-failed'
      entry.failed_recommendation = entry.final_recommended
      // Pin every remaining step to the fallback. Never retry the same bad
      // target inside a tool loop or silently re-evaluate Jev's recommendation.
      S.turnPlans.set(e.turnId, { plan: { model: e.model, effort: e.effort, changed: false, reasons: ['model:failed-this-session', 'fallback-pinned'] } })
      // Only where the probe saw a failed step sent again on the session's own model.
      if (S.caps?.retryOk && !streamed) {
        requestAt = await $.clock.now()
        result = yield* next(e)
        entry.fallback = `${String(entry.fallback)}: resent on the session model`
        entry.sent_model = e.model
        entry.sent_effort = e.effort
        entry.final_recommended = { model: e.model, effort: e.effort }
        entry.failed_cache_advice = entry.cache_advice
        delete entry.cache_advice
      }
    }
    entry.stop = result?.stopReason
    await recordStep($, result?.usage, { model: String(entry.sent_model), effort: entry.sent_effort as typeof e.effort }, requestAt, entry)
    if (!result) throw failure ?? new Error('jev-router: routed request failed; retry capability was not confirmed')
    return result
  })

  // A /model switch names the full id the alias resolved to.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await checkSession($)
    // Only the id is learned. A /model choice is the session model, which is
    // the fallback; Jev still judges every turn.
    await learnStep($, { model: e.to_model }, false, 'model-switch')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    clearConversation(`session-${e.reason}`)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    S.cache = resetCache(S.cache, 'compaction')
    S.lastAttempt = undefined
    S.attempts.clear()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const meta = e as { agentId?: string; turnId?: string }
    const turnId = meta.turnId ?? S.mainTurn
    if (meta.agentId === undefined && turnId && S.attempts.has(turnId)) {
      const facts = S.attempts.get(turnId)!
      S.attempts.set(turnId, { ...facts, toolFailures: facts.toolFailures + (result.isError === true ? 1 : 0), deniedTools: facts.deniedTools + (result.deny !== undefined ? 1 : 0) })
    }
    return result
  }).catch(($, e, next) => next(e))

  // A skill the Skill tool loaded: the tool call runs for every invocation,
  // in every surface, so it is the dependable signal.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true) await noteLoad($, e.skill, 'tool.call:Skill')
    return result
  }).catch(($, e, next) => next(e))

  // The engine's own expansion (`/name`, a preload) where it raises the event.
  on('skill.prompt', async ($, e, next) => {
    await noteLoad($, e.skill, 'skill.prompt')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn ending is not the person's turn ending.
    if ((e as { agentId?: string }).agentId !== undefined) return next(e)
    S.lastAttempt = S.attempts.get(e.turnId) ?? S.lastAttempt
    if (S.mainTurn === e.turnId) S.mainTurn = undefined
    const requests = S.stepCounts.get(e.turnId)
    S.stepCounts.delete(e.turnId)
    if (requests) {
      S.turnLengths = [...S.turnLengths, requests].slice(-KEPT_TURN_LENGTHS)
      try {
        await $.store.set(TURNLEN_KEY, S.turnLengths)
      } catch {
        // Kept for this session only.
      }
    }
    await readContext($)
    await finishRound($, 'turn-complete')

    // One line under the answer: which model really answered the turn, what
    // Jev asked for and why a step was kept. Only for a turn the router routed.
    const decision = S.turnDecisions.get(e.turnId)
    const step = S.turnSteps.get(e.turnId)
    if (!decision || config.routing === 'off' || e.isAborted) return next(e)
    const answered = step?.answered_by ?? e.usage?.model ?? 'unknown'
    const sent = step?.sent_model ? String(step.sent_model) : answered
    const effort = step?.sent_effort !== undefined ? `/${String(step.sent_effort)}` : ''
    const fellBack = ((step?.reasons as string[] | undefined) ?? []).find(x => x.startsWith('model:fallback-'))
    const cost = decision.usd !== undefined ? ` ~$${decision.usd.toFixed(3)}/${horizonNow().horizon} requests` : ', cost unknown'
    const jev = decision.family
      ? decision.how === 'none-feasible-most-capable'
        ? `no pair judged feasible, most able ${decision.family}/${decision.effort}${cost}`
        : decision.how === 'most-feasible-within-tolerance'
          ? `most feasible within ${Math.round(config.cost.tolerance * 100)}% of the cheapest: ${decision.family}/${decision.effort}${cost}`
          : `cheapest feasible ${decision.family}/${decision.effort}${cost}`
      : fellBack
        ? `fallback ${fellBack.slice('model:fallback-'.length)}`
        : `no Jev answer (${decision.modelReason ?? 'none'}), session model kept`
    const note = config.routing === 'dry-run' ? ' · dry-run, nothing was switched' : ''
    const text = `jev-router: answered by ${answered}${answered !== sent ? ` (sent ${sent})` : ''}${effort ? ` · requested effort ${effort.slice(1)}` : ''} · ${jev}${note}`
    // turn.complete shows any text that differs from the answer beneath it, so
    // the note alone is returned; the transcript's record is never rewritten.
    const res = await next(e)
    return { ...res, text }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'jev-model' }, async ($, e) => {
    if (!S.hiddenLoaded) await loadHidden($)
    const rawArgs = e.args.trim()
    if (/^settings?$/i.test(rawArgs)) return { text: hiddenText() }
    const setMatch = /^set\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(rawArgs)
    if (setMatch) return { text: await setHidden($, (setMatch[1] ?? '').toLowerCase(), setMatch[2]) }
    const unsetMatch = /^unset\s+(\S+)$/i.exec(rawArgs)
    if (unsetMatch) return { text: await unsetHidden($, (unsetMatch[1] ?? '').toLowerCase()) }
    const arg = rawArgs.toLowerCase()
    if (arg === 'cache') return { text: Object.keys(SHARED).filter(k => k.startsWith('cache_') || k.startsWith('cost_') || k.startsWith('effort_output_')).map(k => `${k} = ${String(settingValue(S.options, k, S.hidden))}`).join('\n') }
    if (arg === 'skills') return { text: `jev-router: skill selection is ${config.skillRouting ? 'on' : 'off'}. Change it with /jev-model skills on|off.` }
    const skillsSwitch = /^skills?\s+(on|off)$/.exec(arg)
    if (skillsSwitch) {
      const enable = skillsSwitch[1] === 'on'
      const saved = await setOption($, 'skill_routing', enable)
      if (saved.includes('is now')) {
        config.skillRouting = enable
        S.options = { ...S.options, skill_routing: enable }
      }
      return { text: saved.includes('is now') ? `jev-router: skill selection is now ${enable ? 'on' : 'off'} (saved to settings; the plugin reloads).` : saved }
    }
    if (arg === 'on' || arg === 'off' || arg === 'dry-run') {
      const note =
        arg === 'on' && !Object.values(S.caps?.families ?? {}).some(f => f?.ok)
          ? '\nNo model has passed /jev-model probe yet, so every step keeps the session model until one does.'
          : ''
      const saved = await setOption($, 'model_routing', arg)
      if (saved.includes('is now')) {
        config.routing = arg
        S.options = { ...S.options, model_routing: arg }
      }
      return { text: saved + note }
    }
    if (arg === 'defaults') {
      try {
        const changed = await resetDefaults($)
        return {
          text: changed.length
            ? `jev-router: reset to defaults: ${changed.join(', ')}. The API key was kept. The plugin reloads.`
            : 'jev-router: every setting is already at its default. The API key was kept.',
        }
      } catch (err) {
        return { text: `jev-router: could not reset settings (${err instanceof Error ? err.message.slice(0, 120) : 'error'}).` }
      }
    }
    const fb = /^fallback\s+(session|haiku|sonnet|opus)$/.exec(arg)
    if (fb) return { text: await setOption($, 'fallback_model', fb[1] as string) }
    if (arg === 'fallback') return { text: `jev-router: fallback is ${config.fallback}. Use /jev-model fallback session|haiku|sonnet|opus.` }
    if (arg === 'reset') {
      S.failed.clear()
      S.caps = undefined
      try {
        await $.store.delete(CAPS_KEY)
      } catch {
        // Nothing stored.
      }
      return { text: 'jev-router: probe results and this session\'s failed models are cleared.' }
    }
    if (arg === 'models') {
      await refreshModels($)
      return {
        text: [
          `jev-router models (${S.available.source})`,
          `listed: ${S.available.raw.join(', ') || 'nothing'}`,
          `routable: ${Object.entries(S.available.models).map(([f, m]) => `${f}=${m}`).join(', ') || 'none'}`,
        ].join('\n'),
      }
    }
    if (arg === 'probe') {
      await refreshModels($)
      await loadCaps($)
      const lines: string[] = []
      // One tiny background subagent per family not known yet.
      for (const [family, alias] of Object.entries(S.available.models) as [Family, string][]) {
        if (isKnown(family)) {
          lines.push(`${family}: already known (${S.caps!.families[family]!.id})`)
          continue
        }
        lines.push((await probeFamily($, family, alias)).line)
      }
      if (lines.length === 0) return { text: 'jev-router: this Claude Code lists no Haiku, Sonnet or Opus model to probe.' }
      if (S.caps?.retryOk === undefined) {
        S.probeQueue = [{ kind: 'retry' }]
        lines.push(`retry check armed: your next message here is first sent to a model id no account has, then resent on the session model (an error line before the answer is expected).`)
      }
      return { text: ['jev-router probe:', ...lines, 'Run /jev-model in a moment to see what was learned.'].join('\n') }
    }
    if (arg === 'probe cancel') {
      S.probeQueue = []
      S.pendingProbe = undefined
      return { text: 'jev-router: probe disarmed.' }
    }
    return { text: `${statusText()}\n${await toolStatus($)}` }
  })

  on('command.run', { command: 'jev-log' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (args[0] === 'clear') {
      const scope = args[1] ?? 'today'
      if ((scope !== 'today' && scope !== 'all') || args.length > 2) return { text: 'jev-router: /jev-log [clear [today|all]]' }
      const result = await clearLogs($, scope)
      return {
        text: result.failed > 0
          ? `jev-router: cleared ${result.cleared} ${scope} log file(s); ${result.failed} could not be accessed.`
          : `jev-router: cleared the contents of ${result.cleared} ${scope} log file(s). Logging will continue if enabled.`,
      }
    }
    if (args.length > 0) return { text: 'jev-router: /jev-log [clear [today|all]]' }
    const file = await logFile($)
    if (!file || !(await $.fs.exists(file))) {
      return { text: S.config.writeLog ? 'jev-router: nothing logged today.' : 'jev-router: logging is off. Turn on "Write log" in the plugin settings to record rounds and steps.' }
    }
    const lines = (await $.fs.read(file)).trim().split('\n').slice(-20)
    const rows = lines.map(l => {
      try {
        const r = JSON.parse(l) as Record<string, any>
        const time = String(r.ts).slice(11, 19)
        if (r.type === 'round') {
          const calls = (r.jev_calls ?? []).map((c: any) => `${c.step}:${c.status}/${c.ms}ms`).join(' ')
          const sel = (r.selected ?? []).map((s: any) => `${s.name}(fits ${s.fits})`).join(', ')
          const able = (r.candidates ?? []).filter((c: any) => c.feasible >= (r.decision?.threshold ?? 0)).length
          const m = r.candidates ? ` | ${able}/${r.candidates.length} pairs feasible` : ''
          const d = r.decision ? ` → ${r.decision.family ? `${r.decision.family}/${r.decision.effort} (${r.decision.how}${r.decision.usd !== undefined ? ` ~$${r.decision.usd}` : ''})` : `keep[${r.decision.reason}]`}` : ''
          return `${time} round ${r.round} ${r.outcome}${r.reason ? ` [${r.reason}]` : ''}${sel ? ` skills ${sel}` : ''}${m}${d}${calls ? ` | ${calls}` : ''}`
        }
        if (r.type === 'step') {
          return `${time} step #${r.index} ${r.routing}: Jev ${r.jev_recommended?.model ?? '?'}/${r.jev_recommended?.effort ?? '?'} → sent ${r.sent_model}/${r.sent_effort ?? '-'}, answered by ${r.answered_by ?? '?'} [${(r.reasons ?? []).join(', ')}]${r.fallback ? ` fallback: ${r.fallback}` : ''}\n  ${cacheText(r)}`
        }
        if (r.type === 'reset') return `${time} reset settings to defaults: ${(r.changed ?? []).join(', ') || 'nothing to change'}`
        if (r.type === 'load') return `${time} load ${r.skill} via ${r.via} (routed: ${r.routed})`
        if (r.type === 'turn') return `${time} turn ${r.round}: ${(r.skills ?? []).map((s: any) => `${s.skill}=${s.status}`).join(', ')}`
        if (r.type === 'probe' && r.kind === 'auto') return `${time} probe auto (${r.why}): ${(r.result ?? []).join('; ')}`
        if (r.type === 'probe') return `${time} probe ${r.kind} ${r.family ?? ''} ${r.sent_model ?? ''} ok=${r.ok ?? r.retry_ok} answered by ${r.answered_by ?? '-'}`
        return `${time} ${r.type}`
      } catch {
        return '(unreadable line)'
      }
    })
    return { text: [`jev-router log: ${file}`, ...rows].join('\n') }
  })

  on('command.run', { command: 'jev-data' }, async ($, e) => ({ text: await dataCommand($, e.args) }))

  on('command.run', { command: 'jev-index' }, async $ => {
    S.index = undefined
    const built = await ensureIndex($)
    const names = built.skills.map(s => `${s.name}${built.paths[s.name] ? '' : ' (no SKILL.md, description only)'}`)
    return {
      text: [
        `jev-router index: ${built.skills.length} skills (commands listed ${built.sources.commands}, SKILL.md files ${built.sources.files}, files not invocable ${built.sources.dropped})`,
        ...names,
      ].join('\n'),
    }
  })
}
