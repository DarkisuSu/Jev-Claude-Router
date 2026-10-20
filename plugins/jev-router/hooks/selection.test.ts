import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { DESC_CAP, HIDDEN, applyHide, applyOpt, capOf, hiddenNames } from './hide'
import { SAVE_TOOL } from './tools'
import { FAKE_KEY, logLines, memoryStore, PROMPT, rankWide, rerank, world, type World } from './testkit'

const FILE = 'C:/work/tools/csv_to_json.py'
const GOOD = { name: 'csv_to_json', description: 'Converts CSV exports to JSON', usage: 'python tools/csv_to_json.py in.csv out.json', path: FILE }

const PREHINT = { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'off' }
type Jev = { tool?: Record<string, number>; skill?: number; fail?: boolean }
const jevFor = (j: Jev = {}) => (q: Record<string, unknown>) => {
  if (j.fail) return { status: 500, body: {} }
  const body: any = 'catalog_has_match' in q ? rankWide(0.9, 'speckit-specify', {}, q) : rerank(q, { 'speckit-specify': j.skill ?? 0.9 })
  if ('tool_which' in q) {
    const probabilities = j.tool ?? { none: 1 }
    body.answers.tool_has_match = { type: 'noul', noul: 1 - (probabilities.none ?? 0) }
    body.answers.tool_which = { type: 'choice', choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0], probabilities, confidence: 0.8 }
  }
  return { status: 200, body }
}
const begin = async ($: Engine, id = 't1', text = PROMPT) => {
  await $.prompt.submit({ text, asUser: true })
  await $.turn.start({ text, turnId: id })
}
const saved = ($: Engine, w: World) => {
  w.written.set(FILE, '# a script')
  return $.tool.call({ tool: SAVE_TOOL, ...GOOD } as never)
}
// The hooks beneath the plugin go in before the test first uses $.
const beneath = (on: Parameters<typeof memoryStore>[0]) => {
  const registered: string[] = []
  on('tool.register', (_, e) => { registered.push(e.name); return { value: { tool: e.name } } as never })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return registered
}
const start = ($: Engine) => $.session.start({ cwd: 'C:/fakeproject' } as never)

describe('prehint mode says what Jev chose', () => {
  test('the status line names a picked tool', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off', skill_routing: false, tool_routing: true, tool_save_threshold: 0 } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.9 } }))
    await saved($, w)
    await begin($)
    expect(w.status.at(-1)).toBe('jev: model off · tool csv_to_json')
  })
})

describe('a line in the conversation', () => {
  const TOOLS = { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off', skill_routing: false, tool_routing: true, tool_save_threshold: 0 }
  test('says what Jev chose, as a notice the model does not read', { options: TOOLS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.9 } }))
    await saved($, w)
    await begin($)
    const rows = session.appended().map(r => r.message as { type: string; content: { text: string }[] })
    expect(rows.at(-1)).toMatchObject({ type: 'system', content: [{ text: 'jev-router: model off · tool csv_to_json' }] })
  })
  test('chat_notice off adds nothing', { options: { ...TOOLS, chat_notice: false } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.9 } }))
    await saved($, w)
    await begin($)
    expect(session.appended()).toHaveLength(0)
  })
  test('nothing chosen reads as none, never as silence', { options: { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'off' } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor({ skill: 0.05 }))
    await begin($)
    expect(w.status.at(-1)).toBe('jev: model off · skill none · tool none')
    expect(session.appended().at(-1)?.message).toMatchObject({ content: [{ text: 'jev-router: model off · skill none · tool none' }] })
  })
})

describe('the status line says why nothing works', () => {
  test('with no API key it says so, on every message', { options: { typesafe_api_key: '', write_log: true, model_routing: 'on' } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor())
    await begin($)
    expect(w.status.at(-1)).toContain('not working: no TypeSafe API key')
  })
  test('with the router disabled it says so', { options: { typesafe_api_key: FAKE_KEY, enabled: false, write_log: true } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor())
    await begin($)
    expect(w.status.at(-1)).toContain('not working: router disabled')
  })
  test('while it works the status does not mention it, and the experimental selections stay out while off', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off' } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor())
    await begin($)
    expect(w.status.at(-1)).toBe('jev: model off')
  })
})

describe('trimming the skill listing', () => {
  test('applyHide changes only skillOverrides, only for the named skills, and never a value the person set', () => {
    const settings = { permissions: { allow: ['x'] }, skillOverrides: { mine: 'off', a: HIDDEN } }
    const hid = applyHide(settings, ['a', 'b', 'mine'], 'hide')
    expect(hid.changed).toEqual(['b'])
    expect(hid.skipped).toEqual(['mine'])
    expect(hid.settings).toEqual({ permissions: { allow: ['x'] }, skillOverrides: { mine: 'off', a: HIDDEN, b: HIDDEN } })
    const shown = applyHide(hid.settings, ['a', 'b', 'mine'], 'show')
    expect(shown.changed).toEqual(['a', 'b'])
    expect(shown.skipped).toEqual(['mine'])
    expect(shown.settings).toEqual({ permissions: { allow: ['x'] }, skillOverrides: { mine: 'off' } })
    // Nothing left: the key goes too. Input is not mutated.
    expect(applyHide({ skillOverrides: { a: HIDDEN } }, ['a'], 'show').settings).toEqual({})
    expect(settings.skillOverrides).toEqual({ mine: 'off', a: HIDDEN })
    expect(hiddenNames(hid.settings).sort()).toEqual(['a', 'b'])
    expect(applyHide(undefined, ['a'], 'hide').settings).toEqual({ skillOverrides: { a: HIDDEN } })
    expect(HIDDEN).toBe('name-only')
  })
  test('applyOpt caps the descriptions and cuts the names, unless a cap is already set; off takes back only what it wrote', () => {
    const on = applyOpt({ permissions: { allow: ['x'] } }, ['a', 'b'], true)
    expect(on.settings).toEqual({ permissions: { allow: ['x'] }, skillOverrides: { a: HIDDEN, b: HIDDEN }, skillListingMaxDescChars: DESC_CAP })
    expect(on).toMatchObject({ cap: true, changed: ['a', 'b'] })
    expect(DESC_CAP).toBe(100)
    // A cap the person set, in these settings or in the user's, stays as it is.
    expect(applyOpt({ skillListingMaxDescChars: 200 }, [], true).cap).toBe(false)
    expect(applyOpt({}, [], true, 150).settings).toEqual({})
    const off = applyOpt(on.settings, ['a', 'b'], false)
    expect(off.settings).toEqual({ permissions: { allow: ['x'] } })
    expect(off).toMatchObject({ cap: true, changed: ['a', 'b'] })
    expect(applyOpt({ skillListingMaxDescChars: 200 }, [], false).settings).toEqual({ skillListingMaxDescChars: 200 })
    expect(capOf({ skillListingMaxDescChars: 'x' })).toBeUndefined()
  })

  const DIR = 'C:/fakeproject/.claude'
  const SETTINGS = `${DIR}/settings.local.json`
  const USER = 'C:/fakehome/.claude/settings.json'
  const run = ($: Engine, args: string) => $.command.run({ command: 'jev-skills', args } as never).then(r => r.text as string)
  const project = (w: World) => {
    for (const n of ['plan', 'tasks']) w.written.set(`${DIR}/skills/speckit-${n}/SKILL.md`, `---\nname: speckit-${n}\ndescription: ${n} things\n---\nDo ${n}.`)
  }
  const saved$ = (w: World) => JSON.parse(w.written.get(SETTINGS)!)

  test('opt writes the cap and the names to the project settings, keeping what is there; opt off takes back only those', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }))
    expect(await run($, '')).toContain('descriptions full · 0/2 project skills name only')
    expect(await run($, 'opt')).toContain('trimmed: descriptions cut to 100 chars, 2 project skills name only. New session to apply.')
    expect(saved$(w)).toEqual({ permissions: { allow: ['Bash(ls)'] }, skillOverrides: { 'speckit-plan': HIDDEN, 'speckit-tasks': HIDDEN }, skillListingMaxDescChars: 100 })
    expect(await run($, '')).toContain('descriptions cut to 100 chars · 2/2 project skills name only')
    expect(await run($, 'opt')).toContain('nothing to trim')
    expect(await run($, 'opt off')).toContain('restored: descriptions full, 2 project skills in full.')
    expect(saved$(w)).toEqual({ permissions: { allow: ['Bash(ls)'] } })
    expect(logLines(w).filter(l => l.type === 'skills').map(l => l.action)).toEqual(['opt', 'opt', 'opt-off'])
  })
  test('a cap already set in the user settings is not written again, and shows in the status', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(USER, JSON.stringify({ skillListingMaxDescChars: 120 }))
    const out = await run($, 'opt')
    expect(out).toContain('2 project skills name only')
    expect(out).not.toContain('descriptions cut')
    expect(saved$(w).skillListingMaxDescChars).toBeUndefined()
    expect(await run($, '')).toContain('cut to 120 chars')
  })
  test('a missing settings file is created', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor()); project(w)
    await run($, 'opt')
    expect(saved$(w)).toEqual({ skillOverrides: { 'speckit-plan': HIDDEN, 'speckit-tasks': HIDDEN }, skillListingMaxDescChars: 100 })
  })
  test('a settings file that is not JSON is left alone', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, '{ not json')
    expect(await run($, 'opt')).toContain('not valid JSON')
    expect(w.written.get(SETTINGS)).toBe('{ not json')
  })
  test('a skill the person set to another value is left alone', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, JSON.stringify({ skillOverrides: { 'speckit-plan': 'off' } }))
    const out = await run($, 'opt')
    expect(out).toContain('Left alone')
    expect(saved$(w).skillOverrides).toEqual({ 'speckit-plan': 'off', 'speckit-tasks': HIDDEN })
  })
  test('usage on a bad verb', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on); world(on, jevFor())
    expect(await run($, 'wipe')).toContain('/jev-skills [opt | opt off]')
    expect(await run($, 'opt now')).toContain('/jev-skills [opt | opt off]')
  })

  const noticeTexts = (session: { appended: () => readonly { message: unknown }[] }) =>
    session.appended().map(r => ((r.message as { content?: { text?: string }[] }).content ?? []).map(b => b.text ?? '').join(''))
  const reminders = (session: Parameters<typeof noticeTexts>[0]) => noticeTexts(session).filter(x => x.includes('/jev-skills opt'))

  test('every session start says so while the listing is not trimmed, and writes nothing', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor()); project(w)
    beneath(on)
    await start($)
    expect(reminders(session).some(x => x.includes('descriptions uncapped, 2 project skills in full'))).toBe(true)
    expect(w.written.has(SETTINGS)).toBe(false)
    // Again at the next start, until it is done.
    await start($)
    expect(reminders(session)).toHaveLength(2)
  })
  test('a trimmed listing, with the cap in the project or the user settings, gets no reminder', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, JSON.stringify({ skillListingMaxDescChars: 100, skillOverrides: { 'speckit-plan': HIDDEN, 'speckit-tasks': 'off' } }))
    beneath(on)
    await start($)
    expect(reminders(session)).toHaveLength(0)
    w.written.set(SETTINGS, JSON.stringify({ skillOverrides: { 'speckit-plan': HIDDEN, 'speckit-tasks': HIDDEN } }))
    w.written.set(USER, JSON.stringify({ skillListingMaxDescChars: 100 }))
    await start($)
    expect(reminders(session)).toHaveLength(0)
  })
  test('the reminder names only what is missing', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, JSON.stringify({ skillOverrides: { 'speckit-plan': HIDDEN, 'speckit-tasks': HIDDEN } }))
    beneath(on)
    await start($)
    expect(reminders(session).some(x => x.includes('(descriptions uncapped)'))).toBe(true)
    w.written.set(SETTINGS, JSON.stringify({ skillListingMaxDescChars: 100, skillOverrides: { 'speckit-plan': HIDDEN } }))
    await start($)
    expect(reminders(session).some(x => x.includes('(1 project skill in full)'))).toBe(true)
  })
  test('skill selection off: no reminder, since the listing matters only while the hint is used', { options: { ...PREHINT, skill_routing: false } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor()); project(w)
    beneath(on)
    await start($)
    expect(reminders(session)).toHaveLength(0)
    expect(w.status.every(x => !x.includes('/jev-skills opt'))).toBe(true)
  })
  test('skill_trim_hint off, or a settings file that is not JSON: no reminder', { options: { ...PREHINT, skill_trim_hint: false } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor()); project(w)
    beneath(on)
    await start($)
    expect(reminders(session)).toHaveLength(0)
  })
  test('a settings file that is not JSON gets no reminder', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, '{ not json')
    beneath(on)
    await start($)
    expect(reminders(session)).toHaveLength(0)
  })
})