import { describe, expect, mock, test } from 'claude-code/testing'
import { DECISION_TOOL, evaluateDecision, prepareDecision } from './decisions'
import { FAKE_KEY, logLines, memoryStore, world } from './testkit'

// Arbitrary task vocabulary: the feature has no predefined action categories.
const input = () => ({
  decision_owner: 'assistant',
  authority: 'The user delegated choosing how to recover the current operation.',
  state: { goal: 'Recover operation', facts: ['Snapshot exists', 'Original is intact'], unknowns: ['Snapshot freshness'] },
  questions: {
    path: { type: 'choice', instructions: 'Which recovery path fits the facts?', criteria: { snapshot: 'Use the known snapshot', original: 'Use the intact original' } },
    intact: { type: 'noul', instructions: 'Is the original intact?' },
    readiness: { type: 'score', instructions: 'How complete is the recovery evidence?', criteria: ['Essential facts are missing', 'Essential facts are available', 'Facts have been independently verified'] },
  },
})
const answer = () => ({ model: 'jev-test', answers: {
  path: { type: 'choice', choice: 'original', probabilities: { snapshot: 0.1, original: 0.9 }, confidence: 0.8 },
  intact: { type: 'noul', noul: 0.9 },
  readiness: { type: 'score', score: 1.1, probabilities: { '0': 0, '1': 0.9, '2': 0.1 }, confidence: 0.8 },
} })
// A tool's result reaches the engine as text: it must be a string, and parse back into the decision.
const parsed = (call: { result?: unknown }) => {
  expect(typeof call.result).toBe('string')
  return JSON.parse(call.result as string)
}
const prepared = () => {
  const result = prepareDecision(input())
  if ('status' in result) throw new Error(result.reason)
  return result
}

describe('generic typed decisions', () => {
  test('all three primitives share supplied state and arbitrary task options', async () => {
    let sent: any
    const result = await evaluateDecision(prepared(), 'jev-configured', 0.6, async body => {
      sent = JSON.parse(body)
      return { status: 200, text: JSON.stringify(answer()) }
    })
    expect(sent.model).toBe('jev-configured')
    expect(sent.state.goal).toBe('Recover operation')
    expect(sent.state.delegated_authority).toBe(input().authority)
    expect(Object.keys(sent.questions)).toEqual(['path', 'intact', 'readiness'])
    expect(result.status).toBe('decided')
    expect(result.answers?.path?.choice).toBe('original')
    expect(result.answers?.readiness?.legend).toEqual({ '0': 'Essential facts are missing', '1': 'Essential facts are available', '2': 'Facts have been independently verified' })
  })
  test('user-owned, unsupported, oversized and incomplete inputs never become requests', () => {
    expect((prepareDecision({ decision_owner: 'user' }) as any).status).toBe('requires_user')
    for (const invalid of [
      { ...input(), decision_owner: undefined },
      { ...input(), authority: '' },
      { ...input(), questions: {} },
      { ...input(), state: { text: 'x'.repeat(20001) } },
      { ...input(), questions: { q: { type: 'plan', instructions: 'Make a plan' } } },
      { ...input(), questions: { q: { type: 'score', instructions: 'Rate it', criteria: ['one'] } } },
      { ...input(), questions: { q: { type: 'choice', instructions: 'Choose', criteria: { only: 'One' } } } },
    ]) expect((prepareDecision(invalid) as any).status).toBe('invalid_request')
  })
  test('credentials are scrubbed throughout state, authority and question descriptions', () => {
    const request = input()
    request.authority += ` ${FAKE_KEY}`
    request.state.facts.push(`password=hidden ${FAKE_KEY}`)
    request.questions.path.criteria.original += ` Bearer sensitive123 ${FAKE_KEY}`
    const result = prepareDecision({ ...request, state: { ...request.state, api_key: 'nested-secret-value', nested: [{ secret: 'another-secret-value' }] } }, [FAKE_KEY])
    const text = JSON.stringify(result)
    for (const secret of [FAKE_KEY, 'hidden', 'sensitive123', 'nested-secret-value', 'another-secret-value']) expect(text.includes(secret)).toBe(false)
    expect(text).toContain('[redacted]')
  })
  test('low confidence and ambiguous Nouls stay uncertain, retaining the typed evidence', async () => {
    const response = answer()
    response.answers.path.confidence = 0.4
    response.answers.intact.noul = 0.5
    const result = await evaluateDecision(prepared(), 'jev-latest', 0.6, async () => ({ status: 200, text: JSON.stringify(response) }))
    expect(result.status).toBe('uncertain')
    expect(result.uncertain).toEqual(['path', 'intact'])
    expect(result.answers?.intact?.noul).toBe(0.5)
  })
  test('HTTP, invalid JSON, missing answers, foreign options and inconsistent scores give no decision', async () => {
    const foreign = answer(); foreign.answers.path.choice = 'invented'
    const missing = answer(); delete (missing.answers as any).intact
    const range = answer(); range.answers.intact.noul = 4
    const distribution = answer(); distribution.answers.path.probabilities.snapshot = 0.7
    const mismatch = answer(); mismatch.answers.readiness.score = 2
    const wrongType = answer(); (wrongType.answers.path as any).type = 'noul'
    for (const response of [
      { status: 500, text: 'server text is never passed through' },
      { status: 200, text: '{' },
      ...[foreign, missing, range, distribution, mismatch, wrongType].map(body => ({ status: 200, text: JSON.stringify(body) })),
    ]) {
      const result = await evaluateDecision(prepared(), 'jev-latest', 0.6, async () => response)
      expect(result.status).toBe('unavailable')
      expect(result.answers).toBeUndefined()
    }
  })
})

describe('decision plugin integration', () => {
  test('registers an upfront tool', { options: { typesafe_api_key: FAKE_KEY } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    world(on, () => ({ status: 200, body: answer() }))
    let tool: any
    on('tool.register', ($, e) => { tool = e; return { value: { tool: DECISION_TOOL } } as never })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: 'C:/fakeproject' } as never)
    expect(tool.name).toBe('decide')
    expect(tool.isDeferred).toBe(false)
  })
  test('a tool call sends evidence and returns a decision even with model and skill routing off', { options: { typesafe_api_key: FAKE_KEY, model_routing: 'off', skill_routing: false, write_log: true } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, () => ({ status: 200, body: answer() }))
    const result = await $.tool.call({ tool: DECISION_TOOL, ...input() } as never)
    expect(parsed(result).status).toBe('decided')
    expect(w.fetches.length).toBe(1)
    expect(w.fetches[0]?.auth).toBe(`Bearer ${FAKE_KEY}`)
    expect(JSON.parse(w.fetches[0]!.body).state.facts).toEqual(input().state.facts)
    const entries = logLines(w)
    expect(entries[0]?.type).toBe('decision')
    expect(entries[0]?.question_count).toBe(3)
    const logs = JSON.stringify(entries)
    for (const text of [FAKE_KEY, 'Recover operation', 'Snapshot exists', 'recovery path', 'original']) expect(logs.includes(text)).toBe(false)
    const owned = await $.tool.call({ tool: DECISION_TOOL, ...input(), decision_owner: 'user' } as never)
    expect(parsed(owned).status).toBe('requires_user')
    expect(w.fetches.length).toBe(1)
  })
  for (const options of [{ decision_routing: false, typesafe_api_key: FAKE_KEY }, { enabled: false, typesafe_api_key: FAKE_KEY }, {}]) {
    test(`disabled or no key: no request (${JSON.stringify(options)})`, { options }, async ($, on) => {
      mock.clock(on); memoryStore(on)
      const w = world(on, () => ({ status: 200, body: answer() }))
      const result = await $.tool.call({ tool: DECISION_TOOL, ...input() } as never)
      expect(parsed(result).status).toBe('unavailable')
      expect(w.fetches.length).toBe(0)
    })
  }
  test('the shared timeout bounds a hung decision without fabricating an answer', { options: { typesafe_api_key: FAKE_KEY } }, async ($, on) => {
    const clock = mock.clock(on)
    memoryStore(on, { advanced: { timeout_ms: 2000 } })
    world(on, () => 'hang')
    const called = $.tool.call({ tool: DECISION_TOOL, ...input() } as never)
    await clock.settle()
    await clock.advance(2500)
    const result = await called
    expect(parsed(result).status).toBe('unavailable')
    expect(parsed(result).reason).toBe('jev timeout')
  })
  test('confidence settings apply immediately and logging stays off by default', { options: { typesafe_api_key: FAKE_KEY } }, async ($, on) => {
    mock.clock(on); memoryStore(on)
    const w = world(on, () => ({ status: 200, body: answer() }))
    await $.command.run({ command: 'jev-model', args: 'set decision_confidence_threshold 0.95' })
    const result = await $.tool.call({ tool: DECISION_TOOL, ...input() } as never)
    expect(parsed(result).status).toBe('uncertain')
    expect(w.written.size).toBe(0)
  })
})
