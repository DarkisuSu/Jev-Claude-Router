import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { SAVE_INSTRUCTIONS, SAVE_TOOL, isUserTool, mergeTools, parseReusable, pickTools, prepareTool, readLibrary, toolHint, touchTool, upsertTool, usesTool, type SavedTool } from './tools'
import { DECISION_INSTRUCTIONS, DECISION_TOOL } from './decisions'
import { saveQuestion, toolQuestion } from './questions'
import { rankWideBody, route } from './router'
import { FAKE_KEY, logLines, memoryStore, PROMPT, rankWide, rerank, world, type World } from './testkit'

const FILE = 'C:/work/tools/csv_to_json.py'
const GOOD = { name: 'csv_to_json', description: 'Converts CSV exports to JSON', usage: 'python tools/csv_to_json.py in.csv out.json', path: FILE }
const tool = (over: Partial<SavedTool> = {}): SavedTool => ({ ...GOOD, scope: 'project', origin: 'assistant', created: 1, used: 0, ...over })

describe('saved tool validation', () => {
  test('a well-formed tool is accepted, defaulting to project scope', () => {
    expect(prepareTool(GOOD)).toEqual({ tool: { ...GOOD, scope: 'project' } })
    expect(prepareTool({ ...GOOD, scope: 'global' })).toMatchObject({ tool: { scope: 'global' } })
    expect(prepareTool({ ...GOOD, description: 'Converts\n  CSV   to JSON' })).toMatchObject({ tool: { description: 'Converts CSV to JSON' } })
  })
  test('bad names, scopes and paths are refused with a reason', () => {
    for (const bad of [{ name: 'none' }, { name: '1abc' }, { name: 'has space' }, { scope: 'user' }, { path: 'tools/x.py' }, { path: 'C:/work/../secret.py' }, { path: '' }, { path: 'C:/work/a|b.py' }]) {
      expect(prepareTool({ ...GOOD, ...bad })).toMatchObject({ status: 'invalid_request' })
    }
    expect(prepareTool(undefined)).toMatchObject({ status: 'invalid_request' })
    expect(prepareTool({ ...GOOD, description: 'x'.repeat(301) })).toMatchObject({ status: 'invalid_request' })
  })
  test('credential-like values and code blocks are refused, not rewritten into the library', () => {
    expect(prepareTool({ ...GOOD, usage: 'python x.py --api_key=abcd1234efgh' })).toMatchObject({ status: 'invalid_request' })
    expect(prepareTool({ ...GOOD, description: 'uses the key ' + FAKE_KEY }, [FAKE_KEY])).toMatchObject({ status: 'invalid_request' })
    expect(prepareTool({ ...GOOD, description: 'run ```rm -rf /``` first' })).toMatchObject({ status: 'invalid_request' })
  })
})

describe('the library', () => {
  const entry = (name: string, created: number, lastUsed?: number) => tool({ name, created, ...(lastUsed !== undefined ? { lastUsed } : {}) })
  test('saving a name again updates it and keeps its history', () => {
    const first = upsertTool([], { ...GOOD, scope: 'project' }, 10, 100)
    expect(first).toMatchObject({ updated: false, list: [{ name: 'csv_to_json', created: 100, used: 0 }] })
    const used = touchTool(first.list, 'csv_to_json', 200)
    const again = upsertTool(used, { ...GOOD, description: 'Better words', scope: 'project' }, 10, 300)
    expect(again.updated).toBe(true)
    expect(again.list).toHaveLength(1)
    expect(again.list[0]).toMatchObject({ description: 'Better words', created: 100, used: 1, lastUsed: 200 })
  })
  test('past the maximum the least recently used goes, never the one just saved', () => {
    const list = [entry('a', 1, 50), entry('b', 2), entry('c', 3, 10)]
    const next = upsertTool(list, { ...GOOD, name: 'd', scope: 'project' }, 3, 100)
    expect(next.evicted).toBe('b')
    expect(next.list.map(t => t.name).sort()).toEqual(['a', 'c', 'd'])
    expect(upsertTool([], { ...GOOD, scope: 'project' }, 1, 1).evicted).toBeUndefined()
  })
  test('an assistant never replaces a tool the person registered, and a person replaces an assistant\'s', () => {
    const mine = [tool({ origin: 'user', description: 'mine' })]
    const refused = upsertTool(mine, { ...GOOD, scope: 'project', description: 'robot' }, 10, 5)
    expect(refused).toMatchObject({ refused: 'user-tool', updated: false })
    expect(refused.list).toEqual(mine)
    const taken = upsertTool([tool({ description: 'robot' })], { ...GOOD, scope: 'project', description: 'mine' }, 10, 5, 'user')
    expect(taken.list[0]).toMatchObject({ origin: 'user', description: 'mine', created: 1 })
  })
  test('eviction drops only an assistant\'s tool; a list full of the person\'s own refuses an assistant, never the person', () => {
    const list = [tool({ name: 'mine', origin: 'user', created: 1 }), tool({ name: 'old', created: 2 })]
    const next = upsertTool(list, { ...GOOD, name: 'new', scope: 'project' }, 2, 100)
    expect(next.evicted).toBe('old')
    expect(next.list.map(t => t.name).sort()).toEqual(['mine', 'new'])
    const full = [tool({ name: 'a', origin: 'user' }), tool({ name: 'b', origin: 'user' })]
    expect(upsertTool(full, { ...GOOD, name: 'c', scope: 'project' }, 2, 100)).toMatchObject({ refused: 'full' })
    const registered = upsertTool(full, { ...GOOD, name: 'c', scope: 'project' }, 2, 100, 'user')
    expect(registered.list).toHaveLength(3)
    expect(registered.refused).toBeUndefined()
    expect(isUserTool(registered.list.at(-1)!)).toBe(true)
  })
  test('a project tool hides a global one of the same name; both layers reach Jev as one list', () => {
    const merged = mergeTools([tool({ name: 'a', description: 'project a' }), tool({ name: 'b' })], [tool({ name: 'a', description: 'global a', scope: 'global' }), tool({ name: 'c', scope: 'global' })])
    expect(merged.map(t => `${t.name}:${t.scope}`)).toEqual(['a:project', 'b:project', 'c:global'])
    expect(merged[0]?.description).toBe('project a')
  })
  test('what storage returns is kept only where it is a well-formed tool', () => {
    expect(readLibrary([{ ...GOOD, created: 5, used: 2 }, { name: 'bad name', description: 'x', usage: 'y', path: 'z' }, 'junk', { name: 'x' }], 'global')).toEqual([{ ...GOOD, scope: 'global', origin: 'assistant', created: 5, used: 2 }])
    // Only an explicit "user" origin is the person's; anything else is an assistant's.
    expect(readLibrary([{ ...GOOD, origin: 'user' }, { ...GOOD, name: 'b', origin: 'robot' }], 'project').map(t => t.origin)).toEqual(['user', 'assistant'])
    expect(readLibrary(undefined, 'project')).toEqual([])
  })
})

describe('picking and suggesting', () => {
  const known = [tool({ name: 'a' }), tool({ name: 'b' }), tool({ name: 'c' })]
  test('tools at or above the threshold are picked, likeliest first, up to the maximum; none and unknown names never', () => {
    const p = { none: 0.05, a: 0.3, b: 0.5, c: 0.45, ghost: 0.9 }
    expect(pickTools(p, known, 0.4, 5).map(x => x.tool.name)).toEqual(['b', 'c'])
    expect(pickTools(p, known, 0.4, 1).map(x => x.tool.name)).toEqual(['b'])
    expect(pickTools(p, known, 0.6, 3)).toEqual([])
    expect(pickTools(undefined, known, 0.1, 3)).toEqual([])
  })
  test('the hint says a person-written file may fit, with where and how to run it, and carries no markup of its own', () => {
    const hint = toolHint([{ tool: tool({ description: 'Converts <b>CSV</b> `now`\nplease' }) }])
    expect(hint).toContain('<tool_relevance source="jev-router (TypeSafe Jev)">')
    expect(hint).toContain('read the file before running it')
    expect(hint).toContain("- csv_to_json (project, saved by an assistant): Converts 'b'CSV'/b' 'now' please")
    expect(hint).toContain(`file: ${FILE}`)
    expect(hint.match(/<tool_relevance/g)).toHaveLength(1)
  })
  test('the hint tells a tool the person registered from one an assistant saved', () => {
    const hint = toolHint([{ tool: tool({ origin: 'user' }) }, { tool: tool({ name: 'other' }) }])
    expect(hint).toContain('- csv_to_json (project, registered by the user):')
    expect(hint).toContain('- other (project, saved by an assistant):')
  })
  test('a shell command that names the file counts as running the tool, whatever the slashes', () => {
    expect(usesTool('python C:\\work\\tools\\CSV_to_json.py a b', tool())).toBe(true)
    expect(usesTool('ls C:/work/tools', tool())).toBe(false)
  })
  test("Jev's save answer is read only from a well-formed Noul", () => {
    expect(parseReusable('{"answers":{"reusable":{"type":"noul","noul":0.7}}}')).toBe(0.7)
    for (const bad of ['not json', '{"answers":{}}', '{"answers":{"reusable":{"type":"choice"}}}', '{"answers":{"reusable":{"type":"noul","noul":2}}}']) expect(parseReusable(bad)).toBeUndefined()
  })
  test('the questions carry a none option, the tools and their scope; saving is judged from words alone', () => {
    const q = toolQuestion([{ name: 'a', description: 'does a', scope: 'project' }])
    expect(q).toMatchObject({ type: 'choice', criteria: { a: 'does a (project tool)' } })
    expect(Object.keys((q as { criteria: object }).criteria)).toEqual(['none', 'a'])
    expect(saveQuestion(GOOD)).toMatchObject({ type: 'noul' })
    expect(JSON.stringify(saveQuestion(GOOD))).not.toContain(FILE)
  })
})

describe('tool question in the routing request', () => {
  const cfg = { model: 'jev-latest', gateThreshold: 0.3, fitsThreshold: 0.3, shortlist: 3, modelFamilies: [] as string[] }
  const tools = [{ name: 'a', description: 'does a', scope: 'project' }]
  const answer = (probabilities: Record<string, number>) => ({ model: 'j', answers: { tool_which: { type: 'choice', choice: 'a', probabilities, confidence: 0.8 } } })
  test('with tools alone, one request asks only the tool question and its probabilities come back', async () => {
    const bodies: any[] = []
    const result = await route(PROMPT, [], { ...cfg, tools }, async body => {
      bodies.push(JSON.parse(body))
      return { status: 200, text: JSON.stringify(answer({ none: 0.1, a: 0.9 })) }
    }, async () => 0)
    expect(bodies).toHaveLength(1)
    expect(Object.keys(bodies[0].questions)).toEqual(['tool_which'])
    expect(result.tools).toEqual({ none: 0.1, a: 0.9 })
  })
  test('no tools, no question; malformed probabilities are dropped, not an error', async () => {
    expect(Object.keys(rankWideBody(PROMPT, [], { ...cfg, modelFamilies: ['opus'] }).questions).includes('tool_which')).toBe(false)
    const result = await route(PROMPT, [], { ...cfg, tools }, async () => ({ status: 200, text: JSON.stringify(answer({ none: 'x' as never, a: 7 })) }), async () => 0)
    expect(result.tools).toBeUndefined()
    expect(result.outcome).toBe('no-match')
  })
})

// ---- through the engine

const OPTS = { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off', skill_routing: false }
type Jev = { tool?: Record<string, number>; reusable?: number | 'fail' }
const jevFor = (j: Jev) => (q: Record<string, unknown>) => {
  if ('reusable' in q) return j.reusable === 'fail' ? { status: 500, body: {} } : { status: 200, body: { model: 'jev-test', answers: { reusable: { type: 'noul', noul: j.reusable ?? 0.9 } } } }
  const body: any = 'acts_on_user_system' in q ? rankWide(0.9, 'speckit-specify', {}, q) : rerank(q, { 'speckit-specify': 0.9 })
  if ('tool_which' in q) {
    const probabilities = j.tool ?? { none: 1 }
    body.answers.tool_which = { type: 'choice', choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0], probabilities, confidence: 0.8 }
  }
  return { status: 200, body }
}
const save = ($: Engine, over: Record<string, unknown> = {}) => $.tool.call({ tool: SAVE_TOOL, ...GOOD, ...over } as never)
const result = (call: { result?: unknown }) => {
  expect(typeof call.result).toBe('string')
  return JSON.parse(call.result as string)
}
const begin = async ($: Engine, id = 't1', text = PROMPT) => {
  await $.prompt.submit({ text, asUser: true })
  await $.turn.start({ text, turnId: id })
}
const toolBodies = (w: World) => w.fetches.map(f => JSON.parse(f.body)).filter(b => 'tool_which' in b.questions)
const withFile = (w: World) => w.written.set(FILE, '# a script')

describe('save_tool', () => {
  test('a tool with a real file is saved after Jev judges it reusable; the library keeps pointers, never content', { options: OPTS }, async ($, on) => {
    mock.clock(on); const stored = memoryStore(on)
    const w = world(on, jevFor({ reusable: 0.9 })); withFile(w)
    const out = result(await save($))
    expect(out).toMatchObject({ status: 'saved', name: 'csv_to_json', scope: 'project', reusable: 0.9 })
    const key = Object.keys(stored).find(k => k.startsWith('tools:project:'))!
    expect(stored[key]).toMatchObject([{ ...GOOD, scope: undefined, used: 0 }].map(({ scope, ...t }) => t))
    // What Jev saw: the description, not the path or any code.
    const asked = w.fetches[0]!.body
    expect(asked).toContain('Converts CSV exports to JSON')
    expect(asked).not.toContain(FILE)
    expect(asked).not.toContain(FAKE_KEY)
    expect(logLines(w).find(l => l.type === 'tool')).toMatchObject({ action: 'saved', name: 'csv_to_json', scope: 'project' })
    expect(JSON.stringify(logLines(w))).not.toContain('Converts CSV')
  })
  test('global scope goes to its own list', { options: OPTS }, async ($, on) => {
    mock.clock(on); const stored = memoryStore(on)
    const w = world(on, jevFor({})); withFile(w)
    expect(result(await save($, { scope: 'global' })).scope).toBe('global')
    expect(stored['tools:global']).toHaveLength(1)
    expect(Object.keys(stored).some(k => k.startsWith('tools:project:'))).toBe(false)
  })
  test('below the save threshold it is declined and nothing is kept', { options: { ...OPTS, tool_save_threshold: 0.6 } }, async ($, on) => {
    mock.clock(on); const stored = memoryStore(on)
    const w = world(on, jevFor({ reusable: 0.4 })); withFile(w)
    expect(result(await save($))).toMatchObject({ status: 'declined', reusable: 0.4 })
    expect(Object.keys(stored).some(k => k.startsWith('tools:'))).toBe(false)
  })
  test('an unreachable Jev does not block a save; threshold 0 does not ask at all', { options: OPTS }, async ($, on) => {
    mock.clock(on); const stored = memoryStore(on)
    const w = world(on, jevFor({ reusable: 'fail' })); withFile(w)
    const out = result(await save($))
    expect(out.status).toBe('saved')
    expect(out.reusable).toBeUndefined()
    expect(stored['tools:global']).toBeUndefined()
  })
  test('threshold 0 saves without a Jev request', { options: { ...OPTS, tool_save_threshold: 0 } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({})); withFile(w)
    expect(result(await save($)).status).toBe('saved')
    expect(w.fetches).toHaveLength(0)
  })
  test('a missing file or an invalid request is refused before Jev is asked', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({}))
    expect(result(await save($)).reason).toContain('path does not exist')
    withFile(w)
    expect(result(await save($, { name: 'none' })).status).toBe('invalid_request')
    expect(result(await save($, { description: 'uses ' + FAKE_KEY })).status).toBe('invalid_request')
    expect(w.fetches).toHaveLength(0)
  })
  test('saving a name again updates it; past the maximum the least recently used is dropped', { options: OPTS }, async ($, on) => {
    mock.clock(on); const stored = memoryStore(on, { advanced: { tool_max: 2 } })
    const w = world(on, jevFor({})); for (const n of ['a', 'b', 'c']) w.written.set(`C:/work/${n}.py`, '')
    expect(result(await save($, { name: 'a', path: 'C:/work/a.py' })).status).toBe('saved')
    expect(result(await save($, { name: 'a', path: 'C:/work/a.py', description: 'Better words' })).status).toBe('updated')
    await save($, { name: 'b', path: 'C:/work/b.py' })
    const third = result(await save($, { name: 'c', path: 'C:/work/c.py' }))
    expect(third.evicted).toBe('a')
    const key = Object.keys(stored).find(k => k.startsWith('tools:project:'))!
    expect((stored[key] as { name: string }[]).map(t => t.name).sort()).toEqual(['b', 'c'])
  })
  test('with saving off the tool is not registered, answers unavailable, and no policy is added', { options: { ...OPTS, tool_save: false } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({})); withFile(w)
    const registered: string[] = []
    on('tool.register', (_, e) => { registered.push(e.name); return { value: { tool: e.name } } as never })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: 'C:/fakeproject' } as never)
    expect(registered).not.toContain('save_tool')
    expect((await $.prompt.compose({ model: 'm', promptModel: 'm', tools: [SAVE_TOOL], surfaces: [], outputStyle: null, traits: [] } as never)).sections).toHaveLength(0)
    expect(result(await save($)).status).toBe('unavailable')
  })
  test('with saving on it is registered, and its policy sits beside the decision policy', { options: { ...OPTS, tool_save: true } }, async ($, on) => {
    mock.clock(on); memoryStore(on); world(on, jevFor({}))
    const registered: string[] = []
    on('tool.register', (_, e) => { registered.push(e.name); return { value: { tool: e.name } } as never })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: 'C:/fakeproject' } as never)
    expect(registered).toContain('save_tool')
    const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', tools: [SAVE_TOOL, DECISION_TOOL], surfaces: [], outputStyle: null, traits: [] } as never)
    expect(composed.sections.map(s => [s.id, s.text])).toEqual([['jev-router:decisions', DECISION_INSTRUCTIONS], ['jev-router:tools', SAVE_INSTRUCTIONS]])
    const noTool = await $.prompt.compose({ model: 'm', promptModel: 'm', tools: [], surfaces: [], outputStyle: null, traits: [] } as never)
    expect(noTool.sections).toHaveLength(0)
  })
})

describe('choosing a saved tool', () => {
  test('a tool Jev puts enough probability on is suggested beside the prompt, with its path and how to run it', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.85 } })); withFile(w)
    await save($)
    await begin($)
    const asked = toolBodies(w)
    expect(asked).toHaveLength(1)
    expect(Object.keys(asked[0].questions)).toEqual(['tool_which'])
    expect(asked[0].questions.tool_which.criteria.csv_to_json).toBe('Converts CSV exports to JSON (project tool)')
    const hint = (w.seen?.context ?? []).join('\n')
    expect(hint).toContain('<tool_relevance')
    expect(hint).toContain(`file: ${FILE}`)
    expect(hint).toContain('run: python tools/csv_to_json.py in.csv out.json')
    const round = logLines(w).find(l => l.type === 'round')!
    expect(round.tools).toEqual({ options: 1, none: 0.1, picked: [{ name: 'csv_to_json', scope: 'project', probability: 0.85 }], stale: 0 })
    expect(JSON.stringify(round)).not.toContain(FILE)
  })
  test('below the selection threshold, or with none likelier, nothing is suggested', { options: { ...OPTS, tool_threshold: 0.9 } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.85 } })); withFile(w)
    await save($)
    await begin($)
    expect((w.seen?.context ?? []).join('\n')).not.toContain('tool_relevance')
    expect(logLines(w).find(l => l.type === 'round')?.tools.picked).toEqual([])
  })
  test('a suggested tool whose file is gone is skipped and counted', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.85 } })); withFile(w)
    await save($)
    w.written.delete(FILE)
    await begin($)
    expect((w.seen?.context ?? []).join('\n')).not.toContain('tool_relevance')
    expect(logLines(w).find(l => l.type === 'round')?.tools).toMatchObject({ picked: [], stale: 1 })
  })
  test('with tool selection off, saved tools are neither asked about nor suggested', { options: { ...OPTS, tool_routing: false } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { csv_to_json: 0.9 } })); withFile(w)
    await save($)
    const before = w.fetches.length
    await begin($)
    expect(w.fetches.length).toBe(before)
    expect(logLines(w).find(l => l.type === 'round')?.tools).toBeUndefined()
  })
  test('an empty library asks nothing about tools', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({}))
    await begin($)
    expect(toolBodies(w)).toHaveLength(0)
    expect(w.fetches).toHaveLength(0)
  })
  test('the tool question rides the same request as the skills and the model questions', { options: { ...OPTS, skill_routing: true } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { csv_to_json: 0.9 } })); withFile(w)
    await save($)
    const before = w.fetches.length
    await begin($)
    const wide = JSON.parse(w.fetches[before]!.body)
    expect(Object.keys(wide.questions)).toEqual(expect.arrayContaining(['which', 'acts_on_user_system', 'tool_which']))
  })
  test('a global tool is offered in any project, and a project tool of the same name wins', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { csv_to_json: 0.9 } })); withFile(w)
    await save($, { scope: 'global', description: 'global version' })
    await save($, { scope: 'project', description: 'project version' })
    await begin($)
    expect(toolBodies(w).at(-1).questions.tool_which.criteria.csv_to_json).toBe('project version (project tool)')
  })
  test('a shell command that runs a suggested tool counts as a use', { options: OPTS }, async ($, on) => {
    mock.clock(on); const stored = memoryStore(on)
    on('tool.call', () => ({ result: 'done' }) as never)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.85 } })); withFile(w)
    await save($)
    await begin($)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const key = Object.keys(stored).find(k => k.startsWith('tools:project:'))!
    expect((stored[key] as { used: number }[])[0]?.used).toBe(0)
    await $.tool.call({ tool: 'Bash', command: `python ${FILE} a.csv b.json` } as never)
    expect((stored[key] as { used: number }[])[0]).toMatchObject({ used: 1 })
    expect(logLines(w).find(l => l.type === 'tool' && l.action === 'used')).toMatchObject({ name: 'csv_to_json' })
    // Once counted for the turn, running it again does not count twice.
    await $.tool.call({ tool: 'Bash', command: `python ${FILE} again` } as never)
    expect((stored[key] as { used: number }[])[0]?.used).toBe(1)
  })
})

describe('/jev-tool', () => {
  const run = ($: Engine, args: string) => $.command.run({ command: 'jev-tool', args } as never).then(r => r.text as string)
  test('list shows the switches, both layers, and a missing file', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({})); withFile(w); w.written.set('C:/work/g.py', '')
    expect(await run($, '')).toContain('No tools saved yet')
    await save($)
    await save($, { name: 'g', path: 'C:/work/g.py', scope: 'global', description: 'Global helper' })
    w.written.delete('C:/work/g.py')
    const list = await run($, 'list')
    expect(list).toContain('tools: selection on (suggested at ≥ 0.5, up to 3); Claude may save on')
    expect(list).toContain('1 project, 1 global')
    expect(list).toContain('csv_to_json · used 0 · Converts CSV exports to JSON')
    expect(list).toMatch(/g · used 0 · Global helper .*\[file missing\]/)
    expect(await run($, 'show csv_to_json')).toContain(`file: ${FILE}`)
    expect(await run($, 'show nope')).toContain('no saved tool named nope')
  })
  test('clear removes indexes and their unshared files by default', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({}))
    for (const n of ['a', 'b', 'c']) w.written.set(`C:/work/${n}.py`, '')
    await save($, { name: 'a', path: 'C:/work/a.py' })
    await save($, { name: 'b', path: 'C:/work/b.py' })
    await save($, { name: 'c', path: 'C:/work/c.py', scope: 'global' })
    const clearedA = await run($, 'clear a')
    expect(clearedA).toContain('jev-router: cleared 1 from project.')
    expect(clearedA).toContain('1 deleted')
    expect(w.written.has('C:/work/a.py')).toBe(false)
    expect(await run($, 'clear nope')).toBe('jev-router: nothing to clear.')
    w.written.delete('C:/work/b.py')
    const missing = await run($, 'clear missing project')
    expect(missing).toContain('jev-router: cleared 1 from project.')
    expect(missing).toContain('1 missing')
    expect(await run($, 'list')).toContain('0 project, 1 global')
    const clearedGlobal = await run($, 'clear all global')
    expect(clearedGlobal).toContain('jev-router: cleared 1 from global.')
    expect(clearedGlobal).toContain('1 deleted')
    expect(await run($, 'clear')).toContain('/jev-tool clear')
    expect(await run($, 'clear all')).toBe('jev-router: nothing to clear.')
  })
  test('--keep-files clears a tool index while preserving its script', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({}))
    w.written.set(FILE, 'print("keep")')
    await save($)
    const result = await run($, 'clear csv_to_json --keep-files')
    expect(result).toContain('Script files were kept (--keep-files)')
    expect(w.written.get(FILE)).toBe('print("keep")')
    expect(w.deletedFiles).toEqual([])
    expect(await run($, 'list')).toContain('0 project, 0 global')
  })
  test('on and off write the settings page values and apply at once', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({}))
    expect(await run($, 'off')).toContain('tool selection is now off')
    expect(w.sets.at(-1)).toEqual({ key: 'jev-router@inline.tool_routing', value: false })
    expect(await run($, 'save off')).toContain('letting Claude save tools is now off')
    expect(w.sets.at(-1)).toEqual({ key: 'jev-router@inline.tool_save', value: false })
    expect(await run($, 'on')).toContain('is now on')
    expect(w.sets.at(-1)).toEqual({ key: 'jev-router@inline.tool_routing', value: true })
    expect(await run($, 'bogus')).toContain('/jev-tool list')
  })
  test('the model-routing status shows the tool line too', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on); world(on, jevFor({}))
    const status = (await $.command.run({ command: 'jev-model', args: '' } as never)).text as string
    expect(status).toContain('saved tools: selection on, saving on')
    expect(status).toContain('tools: selection on (suggested at ≥ 0.5')
  })
})

describe('tools the person registers', () => {
  const run = ($: Engine, args: string) => $.command.run({ command: 'jev-tool', args } as never).then(r => r.text as string)
  const lib = (stored: Record<string, unknown>, scope: 'project' | 'global' = 'project') => {
    const key = scope === 'global' ? 'tools:global' : Object.keys(stored).find(k => k.startsWith('tools:project:'))
    return ((key && stored[key]) || []) as { name: string; origin?: string }[]
  }

  test('/jev-tool add registers a file as the person\'s own, without asking Jev', { options: OPTS }, async ($, on) => {
    mock.clock(on); const stored = memoryStore(on)
    const w = world(on, jevFor({})); withFile(w)
    expect(await run($, `add csv_to_json ${FILE} Converts CSV exports to JSON`)).toContain('registered csv_to_json (project)')
    expect(lib(stored)).toMatchObject([{ name: 'csv_to_json', origin: 'user' }])
    expect(w.fetches).toHaveLength(0)
    expect(logLines(w).find(l => l.type === 'tool')).toMatchObject({ action: 'registered', origin: 'user' })
    expect(await run($, 'list')).toContain('csv_to_json [yours]')
    expect(await run($, 'show csv_to_json')).toContain('registered by you')
    // Global scope, and a missing file or bad input explain themselves.
    expect(await run($, `add g ${FILE} global Global helper`)).toContain('registered g (global)')
    expect(lib(stored, 'global')).toMatchObject([{ name: 'g', origin: 'user' }])
    expect(await run($, 'add x C:/nope.py Does something')).toContain('no file at C:/nope.py')
    expect(await run($, `add none ${FILE} words`)).toContain('/jev-tool add')
    expect(await run($, 'add')).toContain('/jev-tool add <name>')
  })
  test('an assistant cannot overwrite a tool the person registered', { options: OPTS }, async ($, on) => {
    mock.clock(on); const stored = memoryStore(on)
    const w = world(on, jevFor({ reusable: 0.9 })); withFile(w)
    await run($, `add csv_to_json ${FILE} Mine`)
    const out = result(await save($, { description: 'Robot words' }))
    expect(out).toMatchObject({ status: 'declined', name: 'csv_to_json' })
    expect(out.reason).toContain('registered by the user')
    expect(w.fetches).toHaveLength(0)
    expect(lib(stored)[0]).toMatchObject({ origin: 'user' })
  })
  test('bulk clears take what assistants saved and leave the person\'s tools and files', { options: OPTS }, async ($, on) => {
    mock.clock(on); const stored = memoryStore(on)
    const w = world(on, jevFor({}))
    for (const n of ['mine', 'robot', 'global_robot']) w.written.set(`C:/work/${n}.py`, `# ${n}`)
    await run($, 'add mine C:/work/mine.py My own script')
    await save($, { name: 'robot', path: 'C:/work/robot.py' })
    await save($, { name: 'global_robot', path: 'C:/work/global_robot.py', scope: 'global' })

    const cleared = await run($, 'clear all')
    expect(cleared).toContain('cleared 1 from project, 1 from global')
    expect(cleared).toContain('1 tool registered by you was kept')
    expect(lib(stored).map(t => t.name)).toEqual(['mine'])
    expect(lib(stored, 'global')).toEqual([])
    expect(w.deletedFiles.sort()).toEqual(['C:/work/global_robot.py', 'C:/work/robot.py'])
    expect(w.written.has('C:/work/mine.py')).toBe(true)
    // Nothing left to clear but the person's own.
    expect(await run($, 'clear all')).toContain('nothing to clear. 1 tool registered by you was kept')
    expect(await run($, 'clear missing')).toContain('1 tool registered by you was kept')
  })
  test('/jev-data clear tools and clear all keep the person\'s tools and never delete their files', { options: OPTS }, async ($, on) => {
    mock.clock(on); const stored = memoryStore(on)
    const w = world(on, jevFor({}))
    for (const n of ['mine', 'robot']) w.written.set(`C:/work/${n}.py`, `# ${n}`)
    await run($, 'add mine C:/work/mine.py My own script')
    await save($, { name: 'robot', path: 'C:/work/robot.py' })
    const data = (args: string) => $.command.run({ command: 'jev-data', args } as never).then(r => r.text as string)

    expect(await data('clear tools')).toContain('1 tool registered by you was kept')
    expect(lib(stored).map(t => t.name)).toEqual(['mine'])
    expect(w.deletedFiles).toEqual(['C:/work/robot.py'])
    expect(await data('clear all')).toContain('(1 registered by you kept)')
    expect(lib(stored).map(t => t.name)).toEqual(['mine'])
    expect(w.written.has('C:/work/mine.py')).toBe(true)
    expect(w.deletedFiles).toEqual(['C:/work/robot.py'])
  })
  test('clearing the person\'s tool by name removes the entry only, never the file', { options: OPTS }, async ($, on) => {
    mock.clock(on); const stored = memoryStore(on)
    const w = world(on, jevFor({}))
    w.written.set('C:/work/mine.py', '# mine')
    await run($, 'add mine C:/work/mine.py My own script')
    expect(await run($, 'clear mine')).toContain('cleared 1 from project')
    expect(lib(stored)).toEqual([])
    expect(w.written.has('C:/work/mine.py')).toBe(true)
    expect(w.deletedFiles).toEqual([])
  })
  test('the file of an assistant\'s tool that the person also registered is kept', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({}))
    w.written.set('C:/work/shared.py', '# shared')
    await save($, { name: 'robot_copy', path: 'C:/work/shared.py' })
    await run($, 'add mine C:/work/shared.py My own script')
    const out = await run($, 'clear robot_copy')
    expect(out).toContain('1 still referenced')
    expect(w.written.has('C:/work/shared.py')).toBe(true)
  })
  test('a registered tool is offered to Jev and suggested like any other, marked as the person\'s', { options: OPTS }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, jevFor({ tool: { none: 0.1, csv_to_json: 0.9 } })); withFile(w)
    await run($, `add csv_to_json ${FILE} Converts CSV exports to JSON`)
    await begin($)
    expect((w.seen?.context ?? []).join('\n')).toContain('(project, registered by the user)')
  })
  test('an assistant\'s save is refused when the list holds only the person\'s tools and is full', { options: { ...OPTS, tool_save_threshold: 0 } }, async ($, on) => {
    mock.clock(on); memoryStore(on, { advanced: { tool_max: 1 } })
    const w = world(on, jevFor({}))
    w.written.set('C:/work/a.py', ''); w.written.set('C:/work/b.py', '')
    await run($, 'add a C:/work/a.py Mine')
    const out = result(await save($, { name: 'b', path: 'C:/work/b.py' }))
    expect(out).toMatchObject({ status: 'declined' })
    expect(out.reason).toContain('full of tools registered by the user')
  })
})
