import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { HIDDEN, applyHide, hiddenNames } from './hide'
import { SAVE_TOOL } from './tools'
import { FAKE_KEY, logLines, memoryStore, PROMPT, rankWide, rerank, world, type World } from './testkit'

const FILE = 'C:/work/tools/csv_to_json.py'
const GOOD = { name: 'csv_to_json', description: 'Converts CSV exports to JSON', usage: 'python tools/csv_to_json.py in.csv out.json', path: FILE }

const PREHINT = { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off' }
type Jev = { tool?: Record<string, number>; skill?: number; fail?: boolean }
const jevFor = (j: Jev = {}) => (q: Record<string, unknown>) => {
  if (j.fail) return { status: 500, body: {} }
  const body: any = 'acts_on_user_system' in q ? rankWide(0.9, 'speckit-specify', {}, q) : rerank(q, { 'speckit-specify': j.skill ?? 0.9 })
  if ('tool_which' in q) {
    const probabilities = j.tool ?? { none: 1 }
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
  on('prompt.compose', () => ({ sections: [] }))
  return registered
}
const start = ($: Engine) => $.session.start({ cwd: 'C:/fakeproject' } as never)

describe('prehint mode says what Jev chose', () => {
  test('the status line names a picked tool', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off', skill_routing: false, tool_save_threshold: 0 } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.9 } }))
    await saved($, w)
    await begin($)
    expect(w.status.at(-1)).toBe('jev: model off · skill off · tool csv_to_json')
  })
})

describe('a line in the conversation', () => {
  const TOOLS = { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off', skill_routing: false, tool_save_threshold: 0 }
  test('says what Jev chose, as a notice the model does not read', { options: TOOLS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.9 } }))
    await saved($, w)
    await begin($)
    const rows = session.appended().map(r => r.message as { type: string; content: { text: string }[] })
    expect(rows.at(-1)).toMatchObject({ type: 'system', content: [{ text: 'jev-router: model off · skill off · tool csv_to_json' }] })
  })
  test('chat_notice off adds nothing', { options: { ...TOOLS, chat_notice: false } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.9 } }))
    await saved($, w)
    await begin($)
    expect(session.appended()).toHaveLength(0)
  })
  test('nothing chosen reads as none, never as silence', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off' } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor({ skill: 0.05 }))
    await begin($)
    expect(w.status.at(-1)).toBe('jev: model off · skill none · tool none')
    expect(session.appended().at(-1)?.message).toMatchObject({ content: [{ text: 'jev-router: model off · skill none · tool none' }] })
  })
})

describe('cutting project skills to a name', () => {
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

  const DIR = 'C:/fakeproject/.claude'
  const SETTINGS = `${DIR}/settings.local.json`
  const run = ($: Engine, args: string) => $.command.run({ command: 'jev-skills', args } as never).then(r => r.text as string)
  const project = (w: World) => {
    for (const n of ['plan', 'tasks']) w.written.set(`${DIR}/skills/speckit-${n}/SKILL.md`, `---\nname: speckit-${n}\ndescription: ${n} things\n---\nDo ${n}.`)
  }

  test('hide writes the project settings, keeping what is there; show takes it back', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }))
    expect(await run($, '')).toContain('project skills (2)')
    const out = await run($, 'hide all')
    expect(out).toContain("name only in Claude's listing: speckit-plan, speckit-tasks")
    expect(JSON.parse(w.written.get(SETTINGS)!)).toEqual({ permissions: { allow: ['Bash(ls)'] }, skillOverrides: { 'speckit-plan': HIDDEN, 'speckit-tasks': HIDDEN } })
    expect(await run($, '')).toContain('speckit-plan [name only]')
    expect(await run($, 'show speckit-plan')).toContain('listed in full again: speckit-plan')
    expect(JSON.parse(w.written.get(SETTINGS)!).skillOverrides).toEqual({ 'speckit-tasks': HIDDEN })
    expect(await run($, 'hide speckit-plan nope')).toContain('No such project skill: nope')
    expect(logLines(w).filter(l => l.type === 'skills').map(l => l.action)).toEqual(['hide', 'show', 'hide'])
  })
  test('a missing settings file is created', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor()); project(w)
    await run($, 'hide speckit-tasks')
    expect(JSON.parse(w.written.get(SETTINGS)!)).toEqual({ skillOverrides: { 'speckit-tasks': HIDDEN } })
  })
  test('a settings file that is not JSON is left alone', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, '{ not json')
    expect(await run($, 'hide all')).toContain('not valid JSON')
    expect(w.written.get(SETTINGS)).toBe('{ not json')
  })
  test('a skill the person set to another value is left alone', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, JSON.stringify({ skillOverrides: { 'speckit-plan': 'off' } }))
    const out = await run($, 'hide all')
    expect(out).toContain('Left alone')
    expect(JSON.parse(w.written.get(SETTINGS)!).skillOverrides).toEqual({ 'speckit-plan': 'off', 'speckit-tasks': HIDDEN })
  })
  test('usage on a bad verb or no name', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on); world(on, jevFor())
    expect(await run($, 'wipe')).toContain('/jev-skills [status')
    expect(await run($, 'hide')).toContain('/jev-skills [status')
  })

  const noticeTexts = (session: { appended: () => readonly { message: unknown }[] }) =>
    session.appended().map(r => ((r.message as { content?: { text?: string }[] }).content ?? []).map(b => b.text ?? '').join(''))

  test('every session start says so while a project skill sends its full description, and writes nothing', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor()); project(w)
    beneath(on)
    await start($)
    expect(noticeTexts(session).some(x => x.includes('2 project skills send their full description') && x.includes('/jev-skills hide all'))).toBe(true)
    expect(w.written.has(SETTINGS)).toBe(false)
    // Again at the next start, until it is done.
    await start($)
    expect(noticeTexts(session).filter(x => x.includes('/jev-skills hide all'))).toHaveLength(2)
  })
  test('a skill already cut to a name, or set by the person, is not counted; none left, no reminder', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, JSON.stringify({ skillOverrides: { 'speckit-plan': HIDDEN, 'speckit-tasks': 'off' } }))
    beneath(on)
    await start($)
    expect(noticeTexts(session).some(x => x.includes('/jev-skills hide all'))).toBe(false)
  })
  test('one left is counted as one', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, JSON.stringify({ skillOverrides: { 'speckit-plan': HIDDEN } }))
    beneath(on)
    await start($)
    expect(noticeTexts(session).some(x => x.includes('1 project skill sends its full description'))).toBe(true)
  })
  test('skill_trim_hint off, or a settings file that is not JSON: no reminder', { options: { ...PREHINT, skill_trim_hint: false } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor()); project(w)
    beneath(on)
    await start($)
    expect(noticeTexts(session).some(x => x.includes('/jev-skills hide all'))).toBe(false)
  })
  test('a settings file that is not JSON gets no reminder', { options: PREHINT }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor()); project(w)
    w.written.set(SETTINGS, '{ not json')
    beneath(on)
    await start($)
    expect(noticeTexts(session).some(x => x.includes('/jev-skills hide all'))).toBe(false)
  })
})
