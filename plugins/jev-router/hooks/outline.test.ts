import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { FAKE_KEY, logLines, rankWide, rerank, world } from './testkit'
import { OUTLINE_CHARS, OUTLINE_FILES, OUTLINE_SYMBOLS, codeOutline, outlineOf } from './outline'

const CSHARP = `// Signs a player in and keeps the session token fresh.
// Talks to the auth service only through IAuthApi.
using System;

namespace Game.Login
{
    [Serializable]
    public sealed class LoginService : IDisposable
    {
        private readonly IAuthApi _api;

        public LoginService(IAuthApi api)
        {
            _api = api;
        }

        public async Task<LoginResult> SignInAsync(string account, string password)
        {
            var apiKey = "sk-live-abcdef123456";
            return await _api.SignIn(account, password);
        }

        private static string Normalize(string account) => account.Trim();
    }

    public interface IAuthApi { Task<LoginResult> SignIn(string a, string p); }
}
`

const TS = `/** Cache of the last answers. */
export interface Entry { key: string }
export class Cache<T> {
  get(key: string): T | undefined { return undefined }
}
export const load = async (path: string): Promise<Entry[]> => []
export function save(entries: Entry[]) {}
`

const PY = `"""Reads the ledger export."""
class Ledger:
    def read(self, path):
        return []

async def total(ledger):
    return 0
`

const use = (tool: string, input: Record<string, unknown>, text?: string, isError?: true) => ({ tool, input, ...(text !== undefined ? { text } : {}), ...(isError ? { isError } : {}) })
const assistant = (...toolUses: ReturnType<typeof use>[]) => ({ role: 'assistant', text: '', toolUses })
const numbered = (text: string) => text.split('\n').map((l, i) => `${String(i + 1).padStart(5)}→${l}`).join('\n')

describe('the outline of a file', () => {
  test('C#: what the file is for, then the types and methods, with no bodies', () => {
    const o = outlineOf('Game/Login/LoginService.cs', CSHARP)
    expect(o.purpose).toBe('Signs a player in and keeps the session token fresh. Talks to the auth service only through IAuthApi.')
    expect(o.symbols).toEqual([
      'public sealed class LoginService : IDisposable',
      'public LoginService(IAuthApi api)',
      'public async Task<LoginResult> SignInAsync(string account, string password)',
      'private static string Normalize(string account)',
      'public interface IAuthApi',
    ])
    expect(JSON.stringify(o)).not.toContain('_api.SignIn')
  })

  test('TypeScript and Python are read too', () => {
    expect(outlineOf('a.ts', TS)).toMatchObject({
      purpose: 'Cache of the last answers.',
      symbols: ['export interface Entry', 'export class Cache<T>', 'export const load = async (path: string): Promise<Entry[]>', 'export function save(entries: Entry[])'],
    })
    expect(outlineOf('a.py', PY)).toMatchObject({ purpose: 'Reads the ledger export.', symbols: ['class Ledger', 'def read(self, path)', 'async def total(ledger)'] })
  })

  test('a long file is cut to a few symbols, and keys in a signature are redacted', () => {
    const many = Array.from({ length: 40 }, (_, i) => `public void M${i}() {}`).join('\n')
    expect(outlineOf('a.cs', many).symbols).toHaveLength(OUTLINE_SYMBOLS)
    expect(outlineOf('a.cs', 'public void Use(string apiKey = "sk-live-abcdef123456") {}', []).symbols[0]).toContain('[redacted]')
  })
})

describe('the outlines of the files the conversation touched', () => {
  test('a file read is outlined from what was read, without the line numbers', () => {
    const [o] = codeOutline([assistant(use('Read', { file_path: 'src/LoginService.cs' }, numbered(CSHARP)))] as never)
    expect(o!.path).toBe('src/LoginService.cs')
    expect(o!.symbols[0]).toBe('public sealed class LoginService : IDisposable')
    expect(o!.lines_seen).toBeGreaterThan(20)
  })

  test('a file only edited is outlined from the text written, newest first, once each', () => {
    const outlines = codeOutline([
      assistant(use('Edit', { file_path: 'a.cs', old_string: 'x', new_string: 'public void First() {}' })),
      assistant(use('Edit', { file_path: 'b.cs', old_string: 'x', new_string: 'public void Second() {}' }), use('Edit', { file_path: 'b.cs', old_string: 'y', new_string: 'public void Third() {}' })),
    ] as never)
    expect(outlines.map(o => o.path)).toEqual(['b.cs', 'a.cs'])
    expect(outlines[0]!.symbols).toEqual(['public void Third()'])
  })

  test('a secret file, a failed call and a file with nothing to show are left out', () => {
    const outlines = codeOutline([
      assistant(use('Read', { file_path: 'config/.env' }, 'public void Hidden() {}')),
      assistant(use('Read', { file_path: 'a.cs' }, 'public void Gone() {}', true)),
      assistant(use('Read', { file_path: 'notes.txt' }, 'just some words\nand more words')),
    ] as never)
    expect(outlines).toEqual([])
  })

  test('only a few files, within a total size', () => {
    const reads = Array.from({ length: 12 }, (_, i) => use('Read', { file_path: `f${i}.cs` }, `public class C${i} { }\n${'public void Method() {}\n'.repeat(5)}`))
    const outlines = codeOutline([assistant(...reads)] as never)
    expect(outlines).toHaveLength(OUTLINE_FILES)
    expect(outlines.reduce((n, o) => n + o.path.length + o.symbols.join('').length, 0)).toBeLessThanOrEqual(OUTLINE_CHARS)
  })
})

const options = { typesafe_api_key: FAKE_KEY, skill_routing: true, tool_routing: true, write_log: true, model_routing: 'on' }
const CAPS = { version: '9.9.9', families: { haiku: { id: 'claude-haiku-t', ok: true, effort: true, at: '' }, sonnet: { id: 'claude-sonnet-t', ok: true, effort: true, at: '' }, opus: { id: 'claude-opus-t', ok: true, effort: true, at: '' } }, retryOk: true }
const answer = (questions: Record<string, unknown>) => ({
  status: 200,
  body: 'catalog_has_match' in questions ? rankWide(0.9, 'speckit-specify', { 'sonnet::medium': 0.9 }, questions) : rerank(questions, { 'speckit-specify': 0.9 }),
})
const begin = async ($: Engine, text = 'Apply that fix.') => {
  await $.prompt.submit({ text, asUser: true })
  await $.turn.start({ text, turnId: 'a' })
}
const MESSAGES = [assistant(use('Read', { file_path: 'Assets/LoginService.cs' }, numbered(CSHARP)))]

describe('Jev sees the gist of the code', () => {
  test('on by default: the outline and the snippets ride in the routing facts, and the question says what they are', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps: CAPS })
    const w = world(on, answer)
    w.messages = MESSAGES as never
    await begin($)
    const body = JSON.parse(w.fetches[0]!.body)
    const work = body.state.routing_context.work
    expect(work.code_outline[0].path).toBe('Assets/LoginService.cs')
    expect(work.code_outline[0].symbols).toContain('public async Task<LoginResult> SignInAsync(string account, string password)')
    expect(work.code_snippets[0]).toMatchObject({ kind: 'read', path: 'Assets/LoginService.cs' })
    expect(JSON.stringify(work)).not.toContain('sk-live-abcdef123456')
    expect(body.questions['feasible::haiku::low'].instructions).toContain('routing_context.work')
    expect(body.questions['feasible::haiku::low'].instructions).toContain('code_outline')
    expect(logLines(w).find(l => l.type === 'round' && l.work)?.work).toMatchObject({ outlines: 1, snippets: 1 })
    expect([...w.written.values()].join('\n').includes('SignInAsync')).toBe(false)
  })

  test('off with its switch', { options: { ...options, code_snippets: false, work_summary: false } }, async ($, on) => {
    mock.clock(on); mock.store(on, {})
    const w = world(on, answer)
    w.messages = MESSAGES as never
    await begin($)
    expect(JSON.parse(w.fetches[0]!.body).state.routing_context.work).toBeUndefined()
  })

  test('sharing recent context off keeps all of it home, and so does routing off', { options: { ...options, jev_context_enabled: false } }, async ($, on) => {
    mock.clock(on); mock.store(on, {})
    const w = world(on, answer)
    w.messages = MESSAGES as never
    await begin($)
    expect(JSON.parse(w.fetches[0]!.body).state.routing_context.work).toBeUndefined()
    expect(w.messageReads).toBe(0)
  })

  test('the first time, the person is told once and how to stop it', { options }, async ($, on) => {
    mock.clock(on); mock.store(on, {})
    const session = mock.session(on)
    world(on, answer)
    on('tool.register', () => ({ value: { tool: 'x' } }) as never)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: 'C:/fakeproject' } as never)
    await $.session.start({ cwd: 'C:/fakeproject' } as never)
    const notices = session.appended().map(r => JSON.stringify(r.message)).filter(t => t.includes('gist of the code'))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("Share the gist of the code with Jev")
  })
})

describe('the state stays within its budget', () => {
  test('a long conversation with a lot of work still fits, the excerpts giving way to the work', { options: { ...options, jev_context_chars: 20000, jev_context_messages: 40 } }, async ($, on) => {
    mock.clock(on); mock.store(on, { caps: CAPS, advanced: { max_prompt_chars: 20000, jev_context_chars: 20000, jev_context_messages: 40 } })
    const w = world(on, answer)
    const big = `// A file of some size.\n${Array.from({ length: 60 }, (_, i) => `public void Method${i}(int a, string b) { }`).join('\n')}`
    w.messages = [
      ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i} ${'words '.repeat(400)}` })),
      assistant(...Array.from({ length: 8 }, (_, i) => use('Read', { file_path: `Assets/File${i}.cs` }, numbered(big))), ...Array.from({ length: 8 }, (_, i) => use('Edit', { file_path: `Assets/Edit${i}.cs`, old_string: big, new_string: big }))),
    ] as never
    await begin($, 'Apply that fix. '.repeat(100))
    const state = JSON.parse(w.fetches[0]!.body).state
    expect(state.routing_context.work.code_outline.length).toBeGreaterThan(0)
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(24000)
  })
})

describe('an edit that shows nothing does not hide the file read before it', () => {
  test('a rename fragment after a read: the read still gives the outline', () => {
    const outlines = codeOutline([
      assistant(use('Read', { file_path: 'Assets/Login.cs' }, numbered(CSHARP))),
      assistant(use('Edit', { file_path: 'Assets/Login.cs', old_string: 'SignIn(', new_string: 'SignInAsync(' })),
    ] as never)
    expect(outlines).toHaveLength(1)
    expect(outlines[0]!.symbols[0]).toBe('public sealed class LoginService : IDisposable')
  })

  test('a read is preferred over an edit fragment of the same file, the file keeping its place by recency', () => {
    const outlines = codeOutline([
      assistant(use('Read', { file_path: 'a.cs' }, 'public class Whole { }\npublic void One() {}')),
      assistant(use('Read', { file_path: 'b.cs' }, 'public class Other { }')),
      assistant(use('Edit', { file_path: 'a.cs', old_string: 'x', new_string: 'public void Added() {}' })),
    ] as never)
    expect(outlines.map(o => o.path)).toEqual(['a.cs', 'b.cs'])
    expect(outlines[0]!.symbols).toEqual(['public class Whole', 'public void One()'])
  })
})
