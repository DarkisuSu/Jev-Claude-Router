// Runs under `claude plugin test`: no fs, no network. Jev is answered by the
// test's own `http.fetch` hook; the key below is a placeholder, never a real one.
import { describe, expect, mock, test } from 'claude-code/testing'

import { route } from './router'
import { COMMANDS, FAKE_KEY, PROMPT, logLines, rankWide, rerank, world, type World } from './testkit'

const rounds = (w: World) => logLines(w).filter(r => r.type === 'round')

const isWide = (q: Record<string, unknown>) => 'acts_on_user_system' in q

describe('skill router', () => {
  test('match: a skill whose fits clears the 0.3 default rides beside the prompt as a hint', { options: { typesafe_api_key: FAKE_KEY, selection_mode: 'prehint', write_log: true } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, q => (isWide(q) ? { status: 200, body: rankWide(0.9, 'speckit-specify') } : { status: 200, body: rerank(q, { 'speckit-specify': 0.85 }) }))

    await $.prompt.submit({ text: PROMPT, asUser: true })

    expect(w.fetches.length).toBe(2)
    expect(w.fetches[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(w.fetches[0]?.auth).toBe(`Bearer ${FAKE_KEY}`)
    expect(w.seen?.text).toBe(PROMPT)
    expect(w.seen?.context?.join('\n')).toContain('`speckit-specify` appears relevant')

    const [round] = rounds(w)
    expect(round?.outcome).toBe('selected')
    expect(round?.selected).toEqual([{ name: 'speckit-specify', fits: 0.85, probability: 0.8 }])
    expect(round?.jev_calls?.map((c: any) => `${c.step}:${c.status}:${c.model}`)).toEqual(['rank_wide:200:jev-test-1', 'rerank:200:jev-test-1'])
    // Built-in commands never reach the index.
    expect(JSON.parse(w.fetches[0]?.body ?? '{}').questions.which.criteria.clear).toBeUndefined()

    // Nothing secret or verbatim in the log.
    const raw = [...w.written.values()].join('\n')
    expect(raw.includes(FAKE_KEY)).toBe(false)
    expect(raw.includes('VIP lobby')).toBe(false)
  })

  test('no count cap: every skill at or above the threshold is hinted, best first', { options: { typesafe_api_key: FAKE_KEY, selection_mode: 'prehint', write_log: true } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, q =>
      isWide(q)
        ? { status: 200, body: rankWide(0.9, 'speckit-specify') }
        : { status: 200, body: rerank(q, { 'speckit-specify': 0.7, 'speckit-plan': 0.92, 'typesafe:typesafe-ai': 0.2 }) },
    )

    await $.prompt.submit({ text: PROMPT, asUser: true })

    expect(rounds(w)[0]?.selected.map((x: any) => x.name)).toEqual(['speckit-plan', 'speckit-specify'])
    expect(w.seen?.context?.join('\n')).toContain('`speckit-plan`, `speckit-specify`')
  })

  test('the fits threshold comes from settings', { options: { typesafe_api_key: FAKE_KEY, selection_mode: 'prehint', write_log: true, fits_threshold: 0.85 } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, q => (isWide(q) ? { status: 200, body: rankWide(0.9, 'speckit-specify') } : { status: 200, body: rerank(q, { 'speckit-specify': 0.7 }) }))

    await $.prompt.submit({ text: PROMPT, asUser: true })

    expect(w.seen?.context).toBeUndefined()
    expect(rounds(w)[0]?.reason).toBe('fits')
  })

  test('the gate threshold comes from settings', { options: { typesafe_api_key: FAKE_KEY, selection_mode: 'prehint', write_log: true, gate_threshold: 0.95 } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, q => (isWide(q) ? { status: 200, body: rankWide(0.9, 'speckit-specify') } : { status: 200, body: rerank(q, { 'speckit-specify': 0.7 }) }))

    await $.prompt.submit({ text: PROMPT, asUser: true })

    expect(w.fetches.length).toBe(1)
    expect(w.seen?.context).toBeUndefined()
    expect(rounds(w)[0]?.reason).toBe('gate')
  })

  test('no match: a low gate leaves the prompt untouched after one call', { options: { typesafe_api_key: FAKE_KEY, selection_mode: 'prehint', write_log: true } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, () => ({ status: 200, body: rankWide(0.1, 'speckit-plan') }))

    await $.prompt.submit({ text: 'What does UTC+8 mean?', asUser: true })

    expect(w.fetches.length).toBe(1)
    expect(w.seen?.context).toBeUndefined()
    expect(rounds(w)[0]?.reason).toBe('gate')
  })

  test('API error: a 500 is logged and the prompt goes on untouched', { options: { typesafe_api_key: FAKE_KEY, selection_mode: 'prehint', write_log: true } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, () => ({ status: 500, body: { error: 'boom' } }))

    await $.prompt.submit({ text: PROMPT, asUser: true })

    expect(w.seen?.text).toBe(PROMPT)
    expect(w.seen?.context).toBeUndefined()
    expect(rounds(w)[0]?.outcome).toBe('error')
    expect(rounds(w)[0]?.reason).toBe('jev http 500')
  })

  test('API error: a hung request times out and the prompt goes on untouched', { options: { typesafe_api_key: FAKE_KEY, selection_mode: 'prehint', write_log: true } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, { advanced: { timeout_ms: 2000 } })
    const w = world(on, () => 'hang')

    const submitted = $.prompt.submit({ text: PROMPT, asUser: true })
    await clock.settle()
    await clock.advance(2500)
    await submitted

    expect(w.seen?.context).toBeUndefined()
    expect(rounds(w)[0]?.reason).toBe('jev timeout')
  })

  test('no key: the router never calls Jev', { options: { write_log: true } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, () => ({ status: 200, body: rankWide(0.9, 'speckit-plan') }))

    await $.prompt.submit({ text: PROMPT, asUser: true })

    expect(w.fetches.length).toBe(0)
    expect(rounds(w)[0]?.reason).toBe('no-key')
  })

  test('logging is off by default: nothing is written', { options: { typesafe_api_key: FAKE_KEY, selection_mode: 'prehint'.replace('', '') } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, q => (isWide(q) ? { status: 200, body: rankWide(0.9, 'speckit-specify') } : { status: 200, body: rerank(q, { 'speckit-specify': 0.85 }) }))

    await $.prompt.submit({ text: PROMPT, asUser: true })

    expect(w.fetches.length).toBe(2)
    expect(w.seen?.context?.join('\n')).toContain('`speckit-specify`')
    expect(w.written.size).toBe(0)
  })

  test('a Skill tool call marks the routed skill native-loaded', { options: { typesafe_api_key: FAKE_KEY, selection_mode: 'prehint', write_log: true } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, q => (isWide(q) ? { status: 200, body: rankWide(0.9, 'speckit-specify') } : { status: 200, body: rerank(q, { 'speckit-specify': 0.85 }) }))
    on('tool.call', () => ({ result: { success: true, commandName: 'speckit-specify' } as never }))
    on('turn.complete', ($, e) => ({ text: '' }) as never)

    await $.prompt.submit({ text: PROMPT, asUser: true })
    await $.tool.call({ tool: 'Skill', skill: 'speckit-specify' } as never)
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1 } as never)

    const lines = logLines(w)
    expect(lines.find(l => l.type === 'load')?.via).toBe('tool.call:Skill')
    expect(lines.find(l => l.type === 'turn')?.skills).toEqual([{ skill: 'speckit-specify', delivery: 'hint', status: 'native-loaded' }])
  })
})

describe('route', () => {
  const skills = COMMANDS.slice(0, 3).map(c => ({ name: c.name, description: c.description }))
  const now = async () => 0
  const cfg = { model: 'jev-latest', gateThreshold: 0.3, fitsThreshold: 0.6, shortlist: 3, modelFamilies: [] }

  test('a malformed answer is an error, not a pick', async () => {
    const send = async () => ({ status: 200, text: '{"answers":{}}' })
    const result = await route(PROMPT, skills, cfg, send, now)
    expect(result.outcome).toBe('error')
    expect(result.selected).toEqual([])
  })

  test('model questions ride request 1 even with an empty skill index', async () => {
    const bodies: string[] = []
    const send = async (body: string) => {
      bodies.push(body)
      return { status: 200, text: JSON.stringify(rankWide(0.9, 'x', { 'haiku::low': 0.8 }, JSON.parse(body).questions)) }
    }
    const result = await route(PROMPT, [], { ...cfg, modelFamilies: ['haiku', 'sonnet', 'opus'] }, send, now)
    expect(bodies.length).toBe(1)
    const questions = JSON.parse(bodies[0] ?? '{}').questions
    expect(Object.keys(questions)).toEqual(['haiku', 'sonnet', 'opus'].flatMap(f => ['low', 'medium', 'high', 'xhigh', 'max'].map(e => `feasible::${f}::${e}`)))
    expect(questions['feasible::sonnet::high'].instructions).toContain('sonnet tier at high effort')
    expect(questions['feasible::sonnet::high'].instructions).toContain('not cost')
    expect(result.feasible?.haiku).toEqual({ low: 0.8, medium: 0.1, high: 0.1, xhigh: 0.1, max: 0.1 })
  })
  test('one routable tier still gets all five efforts asked', async () => {
    const bodies: string[] = []
    const send = async (body: string) => {
      bodies.push(body)
      return { status: 200, text: JSON.stringify(rankWide(0.9, 'x', {}, JSON.parse(body).questions)) }
    }
    await route(PROMPT, [], { ...cfg, modelFamilies: ['opus'] }, send, now)
    expect(Object.keys(JSON.parse(bodies[0] ?? '{}').questions)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'].map(e => `feasible::opus::${e}`))
  })
  test('a malformed model answer does not prevent valid two-stage Skill Selection', async () => {
    let calls = 0
    const send = async (body: string) => {
      calls++
      const q = JSON.parse(body).questions
      const response: any = calls === 1 ? rankWide(0.9, 'speckit-specify') : rerank(q, { 'speckit-specify': 0.9 })
      if (calls === 1) response.answers['feasible::opus::high'] = { type: 'noul', noul: 7 }
      return { status: 200, text: JSON.stringify(response) }
    }
    const result = await route(PROMPT, skills, { ...cfg, modelFamilies: ['haiku', 'sonnet', 'opus'] }, send, now)
    expect(calls).toBe(2)
    expect(result.outcome).toBe('selected')
    expect(result.selected[0]?.name).toBe('speckit-specify')
    expect(result.feasible).toBeUndefined()
  })
})
