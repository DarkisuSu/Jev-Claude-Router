import type { EngineInterface, PluginOptions, PromptOrigin, Register } from 'claude-code'

import {
  availableFrom,
  decide,
  familyOf,
  learn,
  planStep,
  type Available,
  type Caps,
  type Decision,
  type Fallback,
  type Family,
  type RoutingMode,
} from './model'
import { DEFAULT_EFFORT_LEVELS, ENDPOINT } from './questions'
import { JevError, route, type RouteResult, type Send } from './router'
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
const PROBE_TEXT = 'Reply with exactly: OK'
// A model id no account has: the probe's check that a failed request can be
// sent again on the session's own model.
const PROBE_BAD_MODEL = 'jev-router-probe-no-such-model'

type Config = {
  key: string
  enabled: boolean
  mode: 'hint' | 'inject'
  shortlist: number
  gateThreshold: number
  fitsThreshold: number
  model: string
  timeoutMs: number
  maxPromptChars: number
  routing: RoutingMode
  modelThreshold: number
  effortThreshold: number
  fallback: Fallback
  effortLevels: [string, string, string]
  resetRequested: boolean
  writeLog: boolean
}

const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

export const readConfig = (o: PluginOptions): Config => ({
  key: typeof o.typesafe_api_key === 'string' ? o.typesafe_api_key.trim() : '',
  enabled: o.enabled !== false,
  mode: o.mode === 'inject' ? 'inject' : 'hint',
  shortlist: 3,
  gateThreshold: num(o.gate_threshold, 0.3, 0, 1),
  fitsThreshold: num(o.fits_threshold, 0.3, 0, 1),
  resetRequested: o.reset_to_defaults === true,
  writeLog: o.write_log === true,
  effortLevels: [...DEFAULT_EFFORT_LEVELS],
  model: 'jev-latest',
  timeoutMs: 8000,
  maxPromptChars: 2000,
  routing: o.model_routing === 'on' ? 'on' : o.model_routing === 'off' ? 'off' : 'dry-run',
  modelThreshold: num(o.model_threshold, 0.5, 0, 1),
  effortThreshold: num(o.effort_threshold, 0.4, 0, 1),
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
  effort_low: { kind: 'text', chars: 500, what: 'what Jev is told low effort means' },
  effort_medium: { kind: 'text', chars: 500, what: 'what Jev is told medium effort means' },
  effort_high: { kind: 'text', chars: 500, what: 'what Jev is told high effort means' },
}

const BASE = readConfig({})

const hiddenDefault = (name: string): string | number => {
  switch (name) {
    case 'jev_model': return BASE.model
    case 'timeout_ms': return BASE.timeoutMs
    case 'max_prompt_chars': return BASE.maxPromptChars
    case 'shortlist_size': return BASE.shortlist
    case 'effort_low': return BASE.effortLevels[0]
    case 'effort_medium': return BASE.effortLevels[1]
    default: return BASE.effortLevels[2]
  }
}

const level = (v: unknown, i: 0 | 1 | 2) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : BASE.effortLevels[i])

// A value stored out of range or of the wrong kind is ignored, so a bad
// store never breaks routing.
function applyHidden(c: Config, h: Record<string, unknown>) {
  c.model = typeof h.jev_model === 'string' && h.jev_model.trim() ? h.jev_model.trim().slice(0, 64) : BASE.model
  c.timeoutMs = num(h.timeout_ms, BASE.timeoutMs, 1000, 9000)
  c.maxPromptChars = Math.floor(num(h.max_prompt_chars, BASE.maxPromptChars, 200, 20000))
  c.shortlist = Math.floor(num(h.shortlist_size, BASE.shortlist, 1, 12))
  c.effortLevels = [level(h.effort_low, 0), level(h.effort_medium, 1), level(h.effort_high, 2)]
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
  turnProbes: Map<string, Probe>
  failed: Set<Family>
  lastStep?: Record<string, unknown>
  subscription?: boolean
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
  turnProbes: new Map(),
  failed: new Set(),
}

async function logFile($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return undefined
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  return `${home.replace(/\\/g, '/')}/.claude/plugins/data/${LOG_DIR_NAME}/logs/${day}.jsonl`
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
    applyHidden(S.config, S.hidden)
  } catch {
    // Defaults stand.
  }
  S.hiddenLoaded = true
}

// Validates and stores one hidden setting; it applies at once.
async function setHidden($: EngineInterface, name: string, raw: string | undefined) {
  const spec = HIDDEN[name]
  if (!spec) return `jev-router: unknown setting "${name}". Settings: ${Object.keys(HIDDEN).join(', ')}.`
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
  if (!HIDDEN[name]) return `jev-router: unknown setting "${name}". Settings: ${Object.keys(HIDDEN).join(', ')}.`
  const { [name]: _gone, ...rest } = S.hidden
  S.hidden = rest
  if (Object.keys(rest).length > 0) await $.store.set(HIDDEN_KEY, rest)
  else await $.store.delete(HIDDEN_KEY)
  applyHidden(S.config, S.hidden)
  return `jev-router: ${name} is back to its default (${String(hiddenDefault(name))}).`
}

function hiddenText() {
  return [
    'jev-router settings kept off the settings page (change with /jev-model set <name> <value>, restore with /jev-model unset <name>):',
    ...Object.entries(HIDDEN).map(([name, spec]) => {
      const changed = S.hidden[name] !== undefined
      return `${name} = ${String(changed ? S.hidden[name] : hiddenDefault(name))}${changed ? `  [changed; default ${String(hiddenDefault(name))}]` : '  [default]'}\n    ${spec.what}${spec.min !== undefined ? ` (${spec.min} to ${spec.max})` : ''}`
    }),
  ].join('\n')
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
}

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
async function setOption($: EngineInterface, field: string, value: string) {
  const rows = await $.config.list()
  const row = rows.find(r => r.key.endsWith(`.${field}`) && r.key.includes($.plugin.name))
  if (!row) return `jev-router: no /config row for ${field} was found; set it in the plugin's settings instead.`
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
    `jev-router model routing: ${c.routing} (Jev's confidence: model ≥ ${c.modelThreshold}, effort ≥ ${c.effortThreshold}; then the highest probability; fallback ${c.fallback})`,
    `skills: gate ≥ ${c.gateThreshold}, fits ≥ ${c.fitsThreshold}, shortlist ${c.shortlist}, load mode ${c.mode}`,
    `models from this Claude Code (${S.available.source}): ${fams}`,
    `log: ${c.writeLog ? 'on' : 'off'}`,
    `learned: ${caps}`,
    `failed this session: ${[...S.failed].join(', ') || 'none'}`,
    `subscription rate limits seen: ${S.subscription === undefined ? 'not yet' : S.subscription ? 'yes' : 'no'}`,
    last,
    'commands: /jev-model on | dry-run | off | fallback <session|haiku|sonnet|opus> | settings | set | unset | defaults | probe | reset | models',
  ].join('\n')
}

export const register: Register = (on, options) => {
  S.config = readConfig(options)
  const config = S.config
  S.index = undefined
  S.hiddenLoaded = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'jev-log', description: 'Show the last Jev router rounds and steps' })
    await $.command.register({ name: 'jev-index', description: 'Show the skills the Jev router can pick from' })
    await $.command.register({
      name: 'jev-model',
      description: 'Jev model routing: status, on, dry-run, off, fallback, settings, set, unset, defaults, probe, reset, models',
      argumentHint: 'status | on | dry-run | off | fallback <model> | settings | set <name> <value> | unset <name> | defaults | probe | reset | models',
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
    await log($, {
      type: 'session',
      enabled: config.enabled,
      has_key: config.key.length > 0,
      mode: config.mode,
      routing: config.routing,
      gate_threshold: config.gateThreshold,
      fits_threshold: config.fitsThreshold,
      model_threshold: config.modelThreshold,
      effort_threshold: config.effortThreshold,
      fallback: config.fallback,
      claude_code: S.version,
      models: S.available.models,
      models_source: S.available.source,
      probed: S.caps !== undefined,
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const origin = e.origin as PromptOrigin | undefined

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
    }

    const skip = (reason: string) => log($, { type: 'round', ...base, outcome: 'skipped', reason }).then(() => next(e))
    if (!config.enabled) return skip('disabled')
    if (!config.key) return skip('no-key')
    if (!isRoutedOrigin(origin)) return skip('origin')
    if (text.trimStart().startsWith('/')) return skip('slash-command')
    if (text.trim().length === 0) return skip('empty')

    // Before the deadline is worked out: it uses the stored timeout.
    if (!S.hiddenLoaded) await loadHidden($)
    const started = await $.clock.now()
    const deadline = started + config.timeoutMs
    const skills = (await ensureIndex($)).skills
    if (S.available.source === 'not-read') await refreshModels($)
    if (!S.version) await loadCaps($)
    const families = config.routing === 'off' ? [] : Object.keys(S.available.models)
    const sent = text.slice(0, config.maxPromptChars)

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
      },
      sender($, deadline),
      () => $.clock.now(),
    )

    const decision = decide(id, result.modelAnswer, result.effortAnswer, S.available, {
      model: config.modelThreshold,
      effort: config.effortThreshold,
    })
    // A prompt typed during a turn joins that turn: its decision stands.
    if (!midTurn && config.routing !== 'off') {
      S.nextDecision = decision
      // The moment Jev decides: the status line says what it chose. Whether the
      // chat panel draws it is host-dependent; the model and effort the panel
      // shows are the session's and cannot be set from a mod.
      const chose = `${decision.family ?? `keep(${decision.modelReason ?? '-'})`}/${decision.effort ?? `keep(${decision.effortReason ?? '-'})`}`
      $.ui.status(`jev: ${chose}${config.routing === 'dry-run' ? ' (dry-run)' : ''}`)
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

    await log($, {
      type: 'round',
      ...base,
      mid_turn: midTurn,
      sent_chars: sent.length,
      index_size: skills.length,
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
      jev_model: result.modelAnswer,
      jev_effort: result.effortAnswer,
      decision: {
        family: decision.family,
        effort: decision.effort,
        model_reason: decision.modelReason,
        effort_reason: decision.effortReason,
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
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    // Subagents keep the model they were started with; their steps still
    // teach which full id each family resolves to (a probe spawns them).
    if (e.agentId !== undefined) {
      const result = yield* next(e)
      await learnStep($, e, result.usage != null, 'subagent-step')
      return result
    }

    const probe = S.turnProbes.get(e.turnId)
    if (probe) {
      let first
      try {
        first = yield* next({ ...e, model: PROBE_BAD_MODEL })
      } catch {
        first = undefined
      }
      if (first?.usage) {
        await saveCaps($, c => ({ ...c, retryOk: false }))
        return first
      }
      const again = yield* next(e)
      await saveCaps($, c => ({ ...c, retryOk: again.usage !== null }))
      await log($, { type: 'probe', kind: 'retry', retry_ok: again.usage !== null })
      return again
    }

    const decision = S.turnDecisions.get(e.turnId)
    const plan = planStep(e, decision, config.routing, S.caps, S.failed, config.fallback)
    const target = familyOf(plan.model)
    const entry: Record<string, unknown> = {
      type: 'step',
      round: decision?.round,
      turn: e.turnId.slice(-8),
      index: e.index,
      routing: config.routing,
      from_model: e.model,
      from_effort: e.effort,
      sent_model: plan.model,
      sent_effort: plan.effort,
      would_model: plan.wouldModel,
      would_effort: plan.wouldEffort,
      reasons: plan.reasons,
    }

    if (!plan.changed) {
      const result = yield* next(e)
      entry.answered_by = result.usage?.model
      entry.stop = result.stopReason
      S.lastStep = entry
      S.turnSteps.set(e.turnId, entry)
      await learnStep($, e, result.usage != null, 'main-step')
      await log($, entry)
      return result
    }

    const sent = { ...e, model: plan.model, effort: plan.effort as typeof e.effort }
    let result
    try {
      result = yield* next(sent)
    } catch {
      result = undefined
    }
    const failed = !next.signal.aborted && result?.usage == null && result?.stopReason == null
    if (failed) {
      if (target) S.failed.add(target)
      entry.fallback = 'routed-request-failed'
      // Only where the probe saw a failed step sent again on the session's own model.
      if (S.caps?.retryOk) {
        result = yield* next(e)
        entry.fallback = 'routed-request-failed: resent on the session model'
        entry.sent_model = e.model
        entry.sent_effort = e.effort
      }
    }
    entry.answered_by = result?.usage?.model
    entry.stop = result?.stopReason
    S.lastStep = entry
    S.turnSteps.set(e.turnId, entry)
    await log($, entry)
    if (!result) return yield* next(e)
    return result
  })

  // A /model switch names the full id the alias resolved to.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await learnStep($, { model: e.to_model }, false, 'model-switch')
    return next(e)
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
    try {
      S.subscription = (await $.session.usage()).rateLimits.length > 0
    } catch {
      // Left as it was.
    }
    await finishRound($, 'turn-complete')

    // One line under the answer: which model really answered the turn, what
    // Jev asked for and why a step was kept. Only for a turn the router routed.
    const decision = S.turnDecisions.get(e.turnId)
    const step = S.turnSteps.get(e.turnId)
    if (!decision || config.routing === 'off' || e.isAborted) return next(e)
    const answered = e.usage?.model ?? 'unknown'
    const sent = step?.sent_model ? String(step.sent_model) : answered
    const effort = step?.sent_effort !== undefined ? `/${String(step.sent_effort)}` : ''
    const fellBack = ((step?.reasons as string[] | undefined) ?? []).find(x => x.startsWith('model:fallback-'))
    const jev = decision.family
      ? `Jev chose ${decision.family}${decision.effort ? `/${decision.effort}` : ''}`
      : fellBack
        ? `fallback ${fellBack.slice('model:fallback-'.length)}`
        : `Jev not confident (${decision.modelReason ?? 'none'}), session model kept`
    const note = config.routing === 'dry-run' ? ' · dry-run, nothing was switched' : ''
    const text = `jev-router: answered by ${answered}${answered !== sent ? ` (sent ${sent})` : ''}${effort ? ` · effort ${effort.slice(1)}` : ''} · ${jev}${note}`
    // turn.complete shows any text that differs from the answer beneath it, so
    // the note alone is returned; the transcript's record is never rewritten.
    const res = await next(e)
    return { ...res, text }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'jev-model' }, async ($, e) => {
    const rawArgs = e.args.trim()
    if (/^settings?$/i.test(rawArgs)) return { text: hiddenText() }
    const setMatch = /^set\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(rawArgs)
    if (setMatch) return { text: await setHidden($, (setMatch[1] ?? '').toLowerCase(), setMatch[2]) }
    const unsetMatch = /^unset\s+(\S+)$/i.exec(rawArgs)
    if (unsetMatch) return { text: await unsetHidden($, (unsetMatch[1] ?? '').toLowerCase()) }
    const arg = rawArgs.toLowerCase()
    if (arg === 'on' || arg === 'off' || arg === 'dry-run') {
      const note =
        arg === 'on' && !Object.values(S.caps?.families ?? {}).some(f => f?.ok)
          ? '\nNo model has passed /jev-model probe yet, so every step keeps the session model until one does.'
          : ''
      return { text: (await setOption($, 'model_routing', arg)) + note }
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
      // One tiny background subagent per family: the engine resolves the
      // alias (agent.spawn answers the full id) and its step shows effort support.
      for (const [family, alias] of Object.entries(S.available.models)) {
        const known = S.caps?.families[family as Family]
        if (known?.id && known.ok && known.effort !== undefined) {
          lines.push(`${family}: already known (${known.id})`)
          continue
        }
        try {
          const r = await $.agent.spawn({ prompt: PROBE_TEXT, description: 'jev-router model probe', model: alias })
          if (r.deny !== undefined) {
            lines.push(`${family}: refused (${r.deny})`)
            continue
          }
          await learnStep($, { model: r.model }, false, 'probe-spawn')
          lines.push(
            familyOf(r.model) && r.model.toLowerCase() !== family
              ? `${family}: ${alias} resolves to ${r.model}; its subagent is running`
              : `${family}: subagent started; its full id is learned from its first step`,
          )
        } catch (err) {
          lines.push(`${family}: could not start a subagent (${err instanceof Error ? err.message.slice(0, 120) : 'error'}); switch to it once with /model instead`)
        }
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
    return { text: statusText() }
  })

  on('command.run', { command: 'jev-log' }, async $ => {
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
          const m = r.jev_model ? ` | jev model ${r.jev_model.choice} (${r.jev_model.confidence})` : ''
          const ef = r.jev_effort ? ` effort ${r.jev_effort.score} (${r.jev_effort.confidence})` : ''
          const d = r.decision ? ` → ${r.decision.family ?? `keep[${r.decision.model_reason}]`}/${r.decision.effort ?? `keep[${r.decision.effort_reason}]`}` : ''
          return `${time} round ${r.round} ${r.outcome}${r.reason ? ` [${r.reason}]` : ''}${sel ? ` skills ${sel}` : ''}${m}${ef}${d}${calls ? ` | ${calls}` : ''}`
        }
        if (r.type === 'step') {
          return `${time} step #${r.index} ${r.routing}: ${r.from_model}/${r.from_effort ?? '-'} → sent ${r.sent_model}/${r.sent_effort ?? '-'}, answered by ${r.answered_by ?? '?'}${r.would_model || r.would_effort ? ` (would ${r.would_model ?? 'same'}/${r.would_effort ?? 'same'})` : ''} [${(r.reasons ?? []).join(', ')}]${r.fallback ? ` fallback: ${r.fallback}` : ''}`
        }
        if (r.type === 'reset') return `${time} reset settings to defaults: ${(r.changed ?? []).join(', ') || 'nothing to change'}`
        if (r.type === 'load') return `${time} load ${r.skill} via ${r.via} (routed: ${r.routed})`
        if (r.type === 'turn') return `${time} turn ${r.round}: ${(r.skills ?? []).map((s: any) => `${s.skill}=${s.status}`).join(', ')}`
        if (r.type === 'probe') return `${time} probe ${r.kind} ${r.family ?? ''} ${r.sent_model ?? ''} ok=${r.ok ?? r.retry_ok} answered by ${r.answered_by ?? '-'}`
        return `${time} ${r.type}`
      } catch {
        return '(unreadable line)'
      }
    })
    return { text: [`jev-router log: ${file}`, ...rows].join('\n') }
  })

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
