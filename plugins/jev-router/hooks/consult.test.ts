import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { CONSULT_TOOL, consultInstructions, prepareConsult } from './consult'
import { SAVE_TOOL } from './tools'
import { FAKE_KEY, logLines, memoryStore, PROMPT, rankWide, rerank, world, type World } from './testkit'

const FILE = 'C:/work/tools/csv_to_json.py'
const GOOD = { name: 'csv_to_json', description: 'Converts CSV exports to JSON', usage: 'python tools/csv_to_json.py in.csv out.json', path: FILE }

describe('consult instructions and input', () => {
  test('say the choice is delegated to Jev, that every message goes to Jev first, and list nothing', () => {
    const text = consultInstructions(true)
    expect(text).toContain('the model and effort of each turn, and the choice of a skill or a saved tool are delegated to Jev')
    expect(text).toContain(`At the start of every user message, before anything else, call ${CONSULT_TOOL}`)
    expect(text).toContain('Do not pick a skill or a saved tool on your own')
    expect(text).not.toContain('Saved tools Jev can pick from')
    expect(consultInstructions(false)).toContain('the choice of a skill or a saved tool is delegated')
  })
  test('a task is required, flattened to one line', () => {
    expect(prepareConsult({ task: '  fix\n the   ledger ' })).toEqual({ task: 'fix the ledger' })
    expect(prepareConsult({})).toMatchObject({ status: 'invalid_request' })
    expect(prepareConsult(undefined)).toMatchObject({ status: 'invalid_request' })
  })
})

const CONSULT = { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off', selection_mode: 'consult' }
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
const consult = ($: Engine, task = 'convert the CSV export to JSON') => $.tool.call({ tool: CONSULT_TOOL, task } as never)
const outcome = (call: { result?: unknown }) => {
  expect(typeof call.result).toBe('string')
  return JSON.parse(call.result as string)
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
const compose = ($: Engine) => $.prompt.compose({ model: 'm', promptModel: 'm', tools: [CONSULT_TOOL], surfaces: [], outputStyle: null, traits: [] } as never)

describe('consult mode', () => {
  test('the tool is registered and its instructions list nothing', { options: { ...CONSULT, tool_save_threshold: 0 } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor())
    const registered = beneath(on)
    await saved($, w)
    await start($)
    expect(registered).toContain('consult')
    const section = (await compose($)).sections.find(s => s.id === 'jev-router:consult')
    expect(section?.text).toContain('delegated to Jev')
    expect(section?.text).not.toContain('csv_to_json')
    const without = await $.prompt.compose({ model: 'm', promptModel: 'm', tools: [], surfaces: [], outputStyle: null, traits: [] } as never)
    expect(without.sections.find(s => s.id === 'jev-router:consult')).toBeUndefined()
  })
  test('the default, prehint, has no consult tool and no consult instructions', { options: { typesafe_api_key: FAKE_KEY, model_routing: 'off' } }, async ($, on) => {
    mock.clock(on); memoryStore(on); world(on, jevFor())
    const registered = beneath(on)
    await start($)
    expect(registered).not.toContain('consult')
    expect((await compose($)).sections.find(s => s.id === 'jev-router:consult')).toBeUndefined()
  })
  test('the prompt carries no skill or tool pick, and Jev is not asked about them while it is sent', { options: { ...CONSULT, tool_save_threshold: 0 } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.9 } }))
    await saved($, w)
    await begin($)
    expect(w.fetches).toHaveLength(0)
    expect(w.seen?.context ?? []).toEqual([])
    const round = logLines(w).find(l => l.type === 'round')
    expect(round).toMatchObject({ selection_mode: 'consult', reason: 'consult-mode' })
  })
  test('consulting asks Jev about the skills and the saved tools and answers with the picks', { options: { ...CONSULT, tool_save_threshold: 0 } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.9 } }))
    await saved($, w)
    const out = outcome(await consult($))
    expect(out.status).toBe('picked')
    expect(out.skills).toMatchObject([{ name: 'speckit-specify' }])
    expect(out.tools).toMatchObject([{ name: 'csv_to_json', scope: 'project', usage: GOOD.usage, path: FILE, origin: 'assistant' }])
    const asked = w.fetches.map(f => JSON.parse(f.body))
    expect(asked[0].questions).toHaveProperty('which')
    expect(asked[0].questions).toHaveProperty('tool_which')
    // No model question rides a consult: model choice is made as the prompt is sent.
    expect(Object.keys(asked[0].questions).some(k => k.startsWith('feasible::'))).toBe(false)
    expect(asked[0].state.request).toBe('convert the CSV export to JSON')
    expect(w.status.at(-1)).toBe('jev: consulted · skill speckit-specify · tool csv_to_json')
    expect(logLines(w).find(l => l.type === 'consult')).toMatchObject({ outcome: 'picked', tools: { picked: [{ name: 'csv_to_json' }] } })
  })
  test('nothing fitting is answered as such', { options: { ...CONSULT, tool_save_threshold: 0 } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ skill: 0.05 }))
    await saved($, w)
    expect(outcome(await consult($)).status).toBe('nothing_fits')
  })
  test('with nothing to choose from it says so without asking Jev', { options: { ...CONSULT, skill_routing: false } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor())
    expect(outcome(await consult($))).toMatchObject({ status: 'nothing_fits' })
    expect(w.fetches).toHaveLength(0)
    expect(outcome(await consult($, '   '))).toMatchObject({ status: 'invalid_request' })
  })
  test('an unreachable Jev is unavailable, and Claude carries on', { options: { ...CONSULT, tool_save_threshold: 0 } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    world(on, jevFor({ fail: true }))
    expect(outcome(await consult($))).toMatchObject({ status: 'unavailable' })
  })
  test('without a key there is nothing to ask', { options: { typesafe_api_key: '', selection_mode: 'consult' } }, async ($, on) => {
    mock.clock(on); memoryStore(on); world(on, jevFor())
    expect(outcome(await consult($))).toMatchObject({ status: 'unavailable', reason: 'no-key' })
  })
})

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
  test('nothing chosen reads as none, never as silence; consult mode says so', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off' } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const session = mock.session(on)
    const w = world(on, jevFor({ skill: 0.05 }))
    await begin($)
    expect(w.status.at(-1)).toBe('jev: model off · skill none · tool none')
    expect(session.appended().at(-1)?.message).toMatchObject({ content: [{ text: 'jev-router: model off · skill none · tool none' }] })
  })
  test('consult mode shows skill and tool as consult', { options: { ...CONSULT } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor())
    await begin($)
    expect(w.status.at(-1)).toBe('jev: model off · skill consult · tool consult')
  })
})
