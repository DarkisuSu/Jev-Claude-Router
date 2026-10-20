import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { FAKE_KEY, logLines, rankWide, rerank, world } from './testkit'
import { FAILURE_LINES, MAX_FILES, NOTE, READ_SNIPPETS, RECENT_CALLS, SNIPPET_CHARS, SNIPPET_LINES, codeSnippets, composeWork, parseGit, pathText, workFacts } from './work'

const use = (tool: string, input: Record<string, unknown> = {}, isError?: true) => ({ tool, input, ...(isError ? { isError } : {}) })
const assistant = (...toolUses: ReturnType<typeof use>[]) => ({ role: 'assistant', text: '', toolUses })

describe('the work summary', () => {
  test('counts the recent tool calls and the failed ones', () => {
    const facts = workFacts([assistant(use('Bash', { command: 'npm test' }, true), use('Bash'), use('Read', { file_path: 'a.cs' }))], undefined)!
    expect(facts.recent_tool_calls).toEqual({ Bash: 2, Read: 1 })
    expect(facts.failed_tool_calls).toBe(1)
  })

  test('names the edited files by how often, and the read ones newest first, as paths only', () => {
    const facts = workFacts([
      assistant(use('Read', { file_path: 'src/a.cs' }), use('Edit', { file_path: 'src/a.cs', old_string: 'SECRET BODY', new_string: 'x' })),
      assistant(use('Edit', { file_path: 'src/b.cs' }), use('Edit', { file_path: 'src/b.cs' }), use('Read', { file_path: 'src/c.cs' }), use('Read', { file_path: 'src/a.cs' })),
    ], undefined)!
    expect(facts.edited_files).toEqual([{ path: 'src/b.cs', edits: 2 }, { path: 'src/a.cs', edits: 1 }])
    expect(facts.read_files).toEqual(['src/a.cs', 'src/c.cs'])
    expect(JSON.stringify(facts)).not.toContain('SECRET BODY')
  })

  test('a failed edit is not an edit, a subagent\'s calls are not this conversation\'s', () => {
    const facts = workFacts([
      assistant(use('Edit', { file_path: 'a.cs' }, true)),
      { ...assistant(use('Edit', { file_path: 'b.cs' })), agentId: 'sub' },
    ], undefined)!
    expect(facts.edited_files).toEqual([])
    expect(facts.recent_tool_calls).toEqual({ Edit: 1 })
  })

  test('only the latest calls and a few files are looked at', () => {
    const many = Array.from({ length: RECENT_CALLS + 10 }, (_, i) => use('Edit', { file_path: `f${i}.cs` }))
    const facts = workFacts([assistant(...many)], undefined)!
    expect(facts.recent_tool_calls.Edit).toBe(RECENT_CALLS)
    expect(facts.edited_files).toHaveLength(MAX_FILES)
    expect(facts.edited_files.every(f => Number(f.path.slice(1, -3)) >= 10)).toBe(true)
  })

  test('a path that names a secret is replaced, a long one keeps its tail', () => {
    expect(pathText('C:\\proj\\.env.local')).toBe('[sensitive path]')
    expect(pathText('keys/release.keystore')).toBe('[sensitive path]')
    expect(pathText('config/db-password.json')).toBe('[sensitive path]')
    expect(pathText('src\\Game\\Login.cs')).toBe('src/Game/Login.cs')
    expect(pathText(`${'d/'.repeat(100)}end.cs`)!.length).toBe(120)
    expect(pathText(`${'d/'.repeat(100)}end.cs`)!.endsWith('end.cs')).toBe(true)
  })

  test('nothing to say when there are neither calls nor a repository', () => {
    expect(workFacts([], undefined)).toBeUndefined()
    expect(workFacts(undefined, undefined)).toBeUndefined()
    expect(workFacts([], { branch: 'main', changed: 0, untracked: 0, added: 0, removed: 0 })?.repository).toMatchObject({ branch: 'main' })
  })

  test('git: the branch, what changed, what is untracked and the lines added and removed', () => {
    const status = '## feature/login...origin/feature/login [ahead 2]\n M Assets/A.cs\nM  Assets/B.cs\n?? Assets/New.cs\n'
    const numstat = '10\t2\tAssets/A.cs\n3\t0\tAssets/B.cs\n-\t-\tAssets/img.png\n'
    expect(parseGit(status, numstat)).toEqual({ branch: 'feature/login', changed: 2, untracked: 1, added: 13, removed: 2 })
    expect(parseGit('## HEAD (no branch)\n', '')).toMatchObject({ branch: 'HEAD', changed: 0 })
    expect(parseGit('', '')).toEqual({ branch: null, changed: 0, untracked: 0, added: 0, removed: 0 })
  })
})

const options = { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on', work_summary: true, code_snippets: false }
const answer = (questions: Record<string, unknown>) => ({
  status: 200,
  body: 'catalog_has_match' in questions ? rankWide(0.9, 'speckit-specify', { 'sonnet::medium': 0.9 }, questions) : rerank(questions, { 'speckit-specify': 0.9 }),
})
const begin = async ($: Engine, text = 'Apply that fix.') => {
  await $.prompt.submit({ text, asUser: true })
  await $.turn.start({ text, turnId: 'a' })
}
const GIT = { status: '## main\n M Assets/A.cs\n', numstat: '5\t1\tAssets/A.cs\n' }
const MESSAGES = [{ role: 'user', text: 'Fix the login' }, assistant(use('Edit', { file_path: 'Assets/A.cs', old_string: 'PRIVATE CODE', new_string: 'x' }), use('Bash', { command: 'dotnet test --secret hunter2' }, true))]

describe('the work summary reaches Jev', () => {
  test('on: the routing facts carry it, with the repository, and the log keeps no paths or code', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, {})
    const w = world(on, answer)
    w.messages = MESSAGES as never
    w.git = GIT
    await begin($)
    const work = JSON.parse(w.fetches[0]!.body).state.routing_context.work
    expect(work.recent_tool_calls).toEqual({ Edit: 1, Bash: 1 })
    expect(work.failed_tool_calls).toBe(1)
    expect(work.edited_files).toEqual([{ path: 'Assets/A.cs', edits: 1 }])
    expect(work.repository).toEqual({ branch: 'main', changed: 1, untracked: 0, added: 5, removed: 1 })
    const body = w.fetches[0]!.body
    expect(body.includes('PRIVATE CODE')).toBe(false)
    expect(body.includes('hunter2')).toBe(false)
    const logs = [...w.written.values()].join('\n')
    expect(logs.includes('Assets/A.cs')).toBe(false)
    expect(logs.includes('PRIVATE CODE')).toBe(false)
  })

  test('off: nothing about the work is sent and git is not asked', { options: { ...options, work_summary: false } }, async ($, on) => {
    mock.clock(on); mock.store(on, {})
    const w = world(on, answer)
    w.messages = MESSAGES as never
    w.git = GIT
    await begin($)
    expect(JSON.parse(w.fetches[0]!.body).state.routing_context.work).toBeUndefined()
    expect(w.processRuns.some(r => r.argv[0] === 'git')).toBe(false)
    expect(logLines(w).some(l => l.type === 'round' && l.work)).toBe(false)
  })

})

describe('code snippets from the conversation\'s own records', () => {
  const TOOL_TEXT = { text: '  12→line one\n  13→line two' }
  const withText = (tool: string, input: Record<string, unknown>, text: string, isError?: true) => ({ tool, input, text, ...(isError ? { isError } : {}) })

  test('an edit shows its text before and after, cut to a few lines', () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const [snippet] = codeSnippets([assistant(use('Edit', { file_path: 'src/a.cs', old_string: 'old();', new_string: body }))])
    expect(snippet).toMatchObject({ kind: 'edit', path: 'src/a.cs', before: 'old();' })
    expect(snippet!.after!.split('\n')).toHaveLength(SNIPPET_LINES)
  })

  test('a failed command shows how its output ended, not the command', () => {
    const out = Array.from({ length: 20 }, (_, i) => `out ${i}`).join('\n')
    const snippets = codeSnippets([assistant(withText('Bash', { command: 'dotnet test --token abc123' }, out, true))] as never)
    expect(snippets).toHaveLength(1)
    expect(snippets[0]!.kind).toBe('failure')
    expect(snippets[0]!.text!.split('\n')).toHaveLength(FAILURE_LINES)
    expect(snippets[0]!.text!.endsWith('out 19')).toBe(true)
    expect(JSON.stringify(snippets)).not.toContain('abc123')
  })

  test('a file read shows its start without the line numbers; only a couple of files', () => {
    const reads = ['a', 'b', 'c'].map(n => withText('Read', { file_path: `src/${n}.cs` }, TOOL_TEXT.text))
    const snippets = codeSnippets([assistant(...reads)] as never)
    expect(snippets.filter(s => s.kind === 'read')).toHaveLength(READ_SNIPPETS)
    expect(snippets[0]!.text).toBe('line one\nline two')
  })

  test('keys and tokens are redacted, and a secret file is left out altogether', () => {
    const snippets = codeSnippets([
      assistant(use('Edit', { file_path: 'src/a.cs', old_string: 'x', new_string: 'var apiKey = "sk-live-abcdef123456"; password = hunter2' })),
      assistant(use('Edit', { file_path: 'config/.env', old_string: 'A=1', new_string: 'A=2' })),
      assistant(withText('Read', { file_path: 'keys/release.keystore' }, 'binary') as never),
    ] as never, ['mykey'])
    const text = JSON.stringify(snippets)
    expect(snippets).toHaveLength(1)
    expect(text).not.toContain('sk-live-abcdef123456')
    expect(text).not.toContain('hunter2')
    expect(text).toContain('[redacted]')
  })

  test('newest first, edits before failures before reads, within a total size', () => {
    const big = 'x'.repeat(150)
    const edits = Array.from({ length: 20 }, (_, i) => use('Edit', { file_path: `f${i}.cs`, old_string: big, new_string: `${big}${i}` }))
    const snippets = codeSnippets([assistant(...edits)])
    expect(snippets[0]!.path).toBe('f19.cs')
    expect(snippets.reduce((n, s) => n + (s.path?.length ?? 0) + (s.before?.length ?? 0) + (s.after?.length ?? 0), 0)).toBeLessThanOrEqual(SNIPPET_CHARS)
    expect(snippets.length).toBeLessThan(20)
  })

  test('the work is the summary, the snippets, or both', () => {
    const summary = workFacts([assistant(use('Bash'))], undefined)
    const snippet = { kind: 'failure' as const, text: 'boom' }
    expect(composeWork(undefined, [])).toBeUndefined()
    expect(composeWork(summary, [])).toMatchObject({ failed_tool_calls: 0 })
    expect(composeWork(undefined, [snippet])).toEqual({ note: NOTE, code_snippets: [snippet] })
    expect(composeWork(summary, [snippet])).toMatchObject({ failed_tool_calls: 0, code_snippets: [snippet] })
  })
})

describe('code snippets reach Jev', () => {
  const on$ = { ...options, work_summary: false, code_snippets: true }
  const messages = [assistant(use('Edit', { file_path: 'Assets/A.cs', old_string: 'PRIVATE OLD', new_string: 'PRIVATE NEW' }))]

  test('on: the snippets ride in the routing facts, and the log keeps only a count', { options: on$ }, async ($, on) => {
    mock.clock(on); mock.store(on, {})
    const w = world(on, answer)
    w.messages = messages as never
    await begin($)
    const work = JSON.parse(w.fetches[0]!.body).state.routing_context.work
    expect(work.code_snippets).toEqual([{ kind: 'edit', path: 'Assets/A.cs', before: 'PRIVATE OLD', after: 'PRIVATE NEW' }])
    expect(work.recent_tool_calls).toBeUndefined()
    const logs = [...w.written.values()].join('\n')
    expect(logs.includes('PRIVATE NEW')).toBe(false)
    expect(logLines(w).find(l => l.type === 'round' && l.work)?.work).toMatchObject({ snippets: 1 })
  })

  test('off: no code is sent', { options: { ...on$, code_snippets: false } }, async ($, on) => {
    mock.clock(on); mock.store(on, {})
    const w = world(on, answer)
    w.messages = messages as never
    await begin($)
    expect(w.fetches[0]!.body.includes('PRIVATE')).toBe(false)
    expect(JSON.parse(w.fetches[0]!.body).state.routing_context.work).toBeUndefined()
  })

  test('with model routing off nothing about the work is sent', { options: { ...on$, model_routing: 'off' } }, async ($, on) => {
    mock.clock(on); mock.store(on, {})
    const w = world(on, answer)
    w.messages = messages as never
    await begin($)
    expect(w.fetches.every(f => !f.body.includes('PRIVATE'))).toBe(true)
  })
})
