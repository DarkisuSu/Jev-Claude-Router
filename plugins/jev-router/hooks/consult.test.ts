import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { CONSULT_TOOL, SKILL_TEXT_CHARS, SKILL_TEXT_TOTAL, consultInstructions, prepareConsult, skillTexts } from './consult'
import { SAVE_TOOL } from './tools'
import { FAKE_KEY, logLines, memoryStore, PROMPT, rankWide, rerank, world, type World } from './testkit'

const FILE = 'C:/work/tools/csv_to_json.py'
const GOOD = { name: 'csv_to_json', description: 'Converts CSV exports to JSON', usage: 'python tools/csv_to_json.py in.csv out.json', path: FILE }

describe('consult instructions and input', () => {
  test('say the choice is delegated to Jev, that every message goes to Jev first, and list nothing', () => {
    const text = consultInstructions(true)
    expect(text).toContain('the model and effort of each turn, and the choice of a skill or a saved tool are delegated to Jev')
    expect(text).toContain(`At the start of every user message, before anything else, call ${CONSULT_TOOL}`)
    expect(text).toContain('Use only a skill or a saved tool that Jev returned')
    expect(text).not.toContain('Saved tools Jev can pick from')
    expect(consultInstructions(false)).toContain('the choice of a skill or a saved tool is delegated')
  })
  test('picked skills\' own text is delivered, each cut to a bound and all to a total; a skill without a file has none', () => {
    const long = 'x'.repeat(SKILL_TEXT_CHARS + 50)
    const texts = skillTexts([{ name: 'a', body: 'do a' }, { name: 'b' }, { name: 'c', body: long }])
    expect(texts.a).toBe('do a')
    expect('b' in texts).toBe(false)
    expect(texts.c).toContain('[cut: the rest of the skill is not shown]')
    expect(texts.c!.length).toBeLessThan(SKILL_TEXT_CHARS + 100)
    const many = skillTexts(Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, body: 'y'.repeat(SKILL_TEXT_CHARS) })))
    expect(Object.values(many).reduce((n, v) => n + v.length, 0)).toBeLessThanOrEqual(SKILL_TEXT_TOTAL)
    expect(consultInstructions(true)).toContain('do not load it again with the Skill tool')
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
  test('prehint has no consult tool and no consult instructions', { options: { typesafe_api_key: FAKE_KEY, model_routing: 'off', selection_mode: 'prehint' } }, async ($, on) => {
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
    expect(w.status.at(-1)).toBe('jev: model off · skill speckit-specify · tool csv_to_json')
    expect(logLines(w).find(l => l.type === 'consult')).toMatchObject({ outcome: 'picked', tools: { picked: [{ name: 'csv_to_json' }] } })
  })
  test('nothing fitting is answered as such', { options: { ...CONSULT, tool_save_threshold: 0 } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ skill: 0.05 }))
    await saved($, w)
    expect(outcome(await consult($)).status).toBe('nothing_fits')
    expect(w.status.at(-1)).toBe('jev: model off · skill none · tool none')
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
  test('the status line names a picked tool', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off', skill_routing: false, tool_save_threshold: 0, selection_mode: 'prehint' } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.9 } }))
    await saved($, w)
    await begin($)
    expect(w.status.at(-1)).toBe('jev: model off · skill off · tool csv_to_json')
  })
})

describe('a line in the conversation', () => {
  const TOOLS = { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off', skill_routing: false, tool_save_threshold: 0, selection_mode: 'prehint' }
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
  test('nothing chosen reads as none, never as silence', { options: { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off', selection_mode: 'prehint' } }, async ($, on) => {
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

describe('the skill list the engine adds', () => {
  const listing = ($: Engine) => $.prompt.attachment({ type: 'skill_listing', text: '- speckit-plan: plans' } as never)
  test('consult mode leaves it out of the request, so Claude is not shown the skills', { options: CONSULT }, async ($, on) => {
    mock.clock(on); memoryStore(on); world(on, jevFor())
    on('prompt.attachment', (_, e) => ({ text: e.text }))
    expect((await listing($)).text).toBeNull()
  })
  test('prehint keeps it', { options: { typesafe_api_key: FAKE_KEY, model_routing: 'off', selection_mode: 'prehint' } }, async ($, on) => {
    mock.clock(on); memoryStore(on); world(on, jevFor())
    on('prompt.attachment', (_, e) => ({ text: e.text }))
    expect((await listing($)).text).toBe('- speckit-plan: plans')
  })
  test('consult with skill selection off keeps it too', { options: { ...CONSULT, skill_routing: false } }, async ($, on) => {
    mock.clock(on); memoryStore(on); world(on, jevFor())
    on('prompt.attachment', (_, e) => ({ text: e.text }))
    expect((await listing($)).text).toBe('- speckit-plan: plans')
  })
  test('a session in consult mode asks the engine to ask about its attachments again', { options: CONSULT }, async ($, on) => {
    mock.clock(on); memoryStore(on); world(on, jevFor())
    const dropped: string[] = []
    on('ui.invalidate', (_, e) => { dropped.push(String((e as { event?: unknown }).event)); return { value: undefined } as never })
    beneath(on)
    await start($)
    expect(dropped).toContain('prompt.attachment')
  })
})

describe('every skill and saved tool during the work goes through Jev', () => {
  const OPTS = { ...CONSULT, tool_save_threshold: 0 }
  const skill = ($: Engine, name: string, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Skill', skill: name, ...extra } as never)
  const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)
  const refused = (r: unknown) => JSON.stringify(r).includes('Jev has not returned')
  const beneathTools = (on: Parameters<typeof memoryStore>[0]) => {
    on('tool.call', { tool: 'Skill' }, () => ({ result: 'loaded' }) as never)
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }) as never)
  }

  test('a skill is refused until a consult returns it, and the refusal says to consult', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on); beneathTools(on)
    const w = world(on, jevFor())
    const before = await skill($, 'speckit-specify')
    expect(refused(before)).toBe(true)
    expect(JSON.stringify(before)).toContain(CONSULT_TOOL)
    expect(logLines(w).find(l => l.type === 'consult' && l.outcome === 'denied')).toMatchObject({ kind: 'skill', name: 'speckit-specify' })
    await consult($)
    expect(refused(await skill($, 'speckit-specify'))).toBe(false)
    // Only what Jev returned.
    expect(refused(await skill($, 'speckit-plan'))).toBe(true)
  })
  test('a later consult in the same work adds to what is allowed', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on); beneathTools(on)
    world(on, jevFor())
    await consult($)
    expect(refused(await skill($, 'speckit-plan'))).toBe(true)
    // Jev answers the same ranking; the point is that the allowed set only grows within the work.
    await consult($, 'plan the next step')
    expect(refused(await skill($, 'speckit-specify'))).toBe(false)
  })
  test('a new message starts again: nothing is allowed until it is consulted about', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on); beneathTools(on)
    world(on, jevFor())
    await begin($, 't1')
    await consult($)
    expect(refused(await skill($, 'speckit-specify'))).toBe(false)
    await begin($, 't2')
    expect(refused(await skill($, 'speckit-specify'))).toBe(true)
  })
  test('a message typed during the turn does not start again', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on); beneathTools(on)
    world(on, jevFor())
    await begin($, 't1')
    await consult($)
    await $.prompt.submit({ text: 'and one more thing', asUser: true, turnId: 't1' } as never)
    expect(refused(await skill($, 'speckit-specify'))).toBe(false)
  })
  test('with Jev unreachable nothing is refused', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on); beneathTools(on)
    world(on, jevFor({ fail: true }))
    expect(outcome(await consult($)).status).toBe('unavailable')
    expect(refused(await skill($, 'speckit-plan'))).toBe(false)
    expect(refused(await bash($, 'python ' + FILE))).toBe(false)
  })
  test('a saved tool is not run until a consult returns it; other commands are untouched', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on); beneathTools(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.9 } }))
    await saved($, w)
    expect(refused(await bash($, 'ls -la'))).toBe(false)
    expect(refused(await bash($, 'python ' + FILE + ' in.csv out.json'))).toBe(true)
    expect(logLines(w).find(l => l.type === 'consult' && l.outcome === 'denied' && l.kind === 'tool')).toMatchObject({ name: 'csv_to_json' })
    await consult($)
    expect(refused(await bash($, 'python ' + FILE + ' in.csv out.json'))).toBe(false)
  })
  test('a subagent is held to the same, with its own allowed set', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on); beneathTools(on)
    world(on, jevFor())
    expect(refused(await skill($, 'speckit-plan', { agentId: 'sub-1' }))).toBe(true)
    await consult($)
    // What the main agent was given does not carry to the subagent.
    expect(refused(await skill($, 'speckit-specify', { agentId: 'sub-1' }))).toBe(true)
    const own = outcome(await $.tool.call({ tool: CONSULT_TOOL, task: 'the subagent task', agentId: 'sub-1' } as never))
    expect(own.status).toBe('picked')
    expect(refused(await skill($, 'speckit-specify', { agentId: 'sub-1' }))).toBe(false)
    expect(refused(await skill($, 'speckit-plan', { agentId: 'sub-1' }))).toBe(true)
  })
  test('a subagent\'s consult leaves the status line and the main agent\'s picks alone', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on); beneathTools(on)
    const w = world(on, jevFor())
    const before = w.status.length
    await $.tool.call({ tool: CONSULT_TOOL, task: 'the subagent task', agentId: 'sub-1' } as never)
    expect(w.status.length).toBe(before)
    expect(refused(await skill($, 'speckit-specify'))).toBe(true)
  })
  test('with Jev unreachable Claude is handed the lists and descriptions to choose from', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on); beneathTools(on)
    const w = world(on, jevFor({ fail: true }))
    await saved($, w)
    const out = outcome(await consult($))
    expect(out.status).toBe('unavailable')
    expect(out.fallback.note).toContain('choose from these yourself')
    expect(out.fallback.skills.find((k: { name: string }) => k.name === 'speckit-specify')).toMatchObject({ description: expect.any(String) })
    expect(out.fallback.tools).toMatchObject([{ name: 'csv_to_json', description: GOOD.description, usage: GOOD.usage, path: FILE }])
    expect(w.status.at(-1)).toContain('Claude chooses')
  })
  test('prehint refuses nothing', { options: { ...OPTS, selection_mode: 'prehint' } }, async ($, on) => {
    mock.clock(on); memoryStore(on); beneathTools(on)
    world(on, jevFor())
    expect(refused(await skill($, 'speckit-plan'))).toBe(false)
  })
  test('with skill selection off no skill is refused', { options: { ...OPTS, skill_routing: false } }, async ($, on) => {
    mock.clock(on); memoryStore(on); beneathTools(on)
    world(on, jevFor())
    expect(refused(await skill($, 'speckit-plan'))).toBe(false)
  })
})
