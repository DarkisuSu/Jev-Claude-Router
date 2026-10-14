import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { FAKE_KEY, memoryStore, world } from './testkit'
import { SAVE_TOOL } from './tools'

const options = { typesafe_api_key: FAKE_KEY, write_log: true, model_routing: 'off' }
// The mocked clock starts at 0, so the plugin's UTC day is 1970-01-01.
const TODAY = '1970-01-01'
const DATA_DIR = 'C:/fakehome/.claude/plugins/data/jev-router-jev-local/logs'
const run = ($: Engine, command: string, args = '') => $.command.run({ command, args } as never).then(r => r.text as string)

describe('local data cleanup', () => {
  test('/jev-log clear today empties only the current UTC log', { options }, async ($, on) => {
    mock.clock(on)
    memoryStore(on)
    const w = world(on, () => ({ status: 200, body: {} }))
    const today = TODAY
    const todayFile = `${DATA_DIR}/${today}.jsonl`
    const olderFile = `${DATA_DIR}/2020-01-01.jsonl`
    w.written.set(todayFile, '{"type":"today"}\n')
    w.written.set(olderFile, '{"type":"older"}\n')

    expect(await run($, 'jev-log', 'clear today')).toContain('cleared the contents of 1 today log file')
    expect(w.written.get(todayFile)).toBe('')
    expect(w.written.get(olderFile)).toContain('older')
  })

  test('/jev-data clear all removes Jev data and unshared saved-tool files but preserves settings', { options }, async ($, on) => {
    mock.clock(on)
    const stored = memoryStore(on, {
      caps: { version: '9.9.9', families: { sonnet: { id: 'claude-sonnet-test', ok: true } } },
      outputs: { medium: [20, 30] },
      turnlen: [2, 3],
      advanced: { max_prompt_chars: 4000 },
      'tools:global': [{ name: 'helper', description: 'A helper', usage: 'python helper.py', path: 'C:/work/helper.py', created: 1, used: 0 }],
      'tools:project:other': [{ name: 'project_helper', description: 'Project helper', usage: 'python project.py', path: 'C:/work/project.py', created: 1, used: 0 }],
    })
    const w = world(on, () => ({ status: 200, body: {} }))
    const today = TODAY
    const log = `${DATA_DIR}/${today}.jsonl`
    w.written.set(log, '{"type":"round"}\n')
    w.written.set('C:/work/helper.py', "keep the user's script")

    const result = await run($, 'jev-data', 'clear all')
    expect(result).toContain('clear all: logs 1 file')
    expect(result).toContain('1 deleted')
    expect(result).toContain('Plugin settings and the API key were kept.')
    expect(w.written.get(log)).toBe('')
    expect(w.written.has('C:/work/helper.py')).toBe(false)
    expect(Object.keys(stored).sort()).toEqual(['advanced'])
  })

  test('/jev-data clear all --keep-files preserves saved-tool scripts', { options }, async ($, on) => {
    mock.clock(on)
    memoryStore(on, {
      'tools:global': [{ name: 'helper', description: 'A helper', usage: 'python helper.py', path: 'C:/work/helper.py', created: 1, used: 0 }],
    })
    const w = world(on, () => ({ status: 200, body: {} }))
    w.written.set('C:/work/helper.py', 'keep this script')

    const result = await run($, 'jev-data', 'clear all --keep-files')
    expect(result).toContain('saved tool script files were kept (--keep-files)')
    expect(w.written.get('C:/work/helper.py')).toBe('keep this script')
    expect(w.deletedFiles).toEqual([])
  })

  test('clearing saved-tool indexes deletes unshared files by default', { options }, async ($, on) => {
    mock.clock(on)
    const stored = memoryStore(on)
    const w = world(on, () => ({ status: 200, body: {} }))
    const file = 'C:/fakeproject/.jev-tools/cleanup.py'
    w.written.set(file, 'print("temporary helper")')
    await $.tool.call({
      tool: SAVE_TOOL,
      name: 'cleanup_helper',
      description: 'Removes temporary test files',
      usage: `python ${file}`,
      path: file,
      scope: 'project',
    } as never)

    const result = await run($, 'jev-data', 'clear tools project')
    expect(result).toContain('1 deleted')
    expect(w.written.has(file)).toBe(false)
    expect(w.deletedFiles).toEqual([file])
    expect(Object.keys(stored).some(key => key.startsWith('tools:project:'))).toBe(false)
  })

  test('/jev-data clear tools --delete-files removes an unshared saved script', { options }, async ($, on) => {
    mock.clock(on)
    memoryStore(on)
    const w = world(on, () => ({ status: 200, body: {} }))
    const file = 'C:/fakeproject/.jev-tools/data-cleanup.py'
    w.written.set(file, 'print("cleanup")')
    await $.tool.call({ tool: SAVE_TOOL, name: 'data_cleanup', description: 'A cleanup helper', usage: `python ${file}`, path: file } as never)

    const result = await run($, 'jev-data', 'clear tools project --delete-files')
    expect(result).toContain('1 deleted')
    expect(w.written.has(file)).toBe(false)
    expect(w.deletedFiles).toEqual([file])
  })

  test('shared saved-tool files survive index clearing', { options }, async ($, on) => {
    mock.clock(on)
    const stored = memoryStore(on)
    const w = world(on, () => ({ status: 200, body: {} }))
    const file = 'C:/fakeproject/.jev-tools/shared.py'
    w.written.set(file, 'print("shared helper")')
    await $.tool.call({ tool: SAVE_TOOL, name: 'shared_helper', description: 'A shared helper', usage: `python ${file}`, path: file } as never)
    stored['tools:project:another-project'] = [{ name: 'shared_elsewhere', description: 'Also uses this file', usage: `python ${file}`, path: file, created: 1, used: 0 }]

    const result = await run($, 'jev-tool', 'clear shared_helper project')
    expect(result).toContain('1 still referenced')
    expect(w.written.has(file)).toBe(true)
    expect(w.deletedFiles).toEqual([])
  })

  test('default deletion unlinks one unshared file without passing its path through a shell command', { options }, async ($, on) => {
    mock.clock(on)
    memoryStore(on)
    const w = world(on, () => ({ status: 200, body: {} }))
    const file = "C:/fakeproject/.jev-tools/helper's; safe.py"
    w.written.set(file, 'print("helper")')
    await $.tool.call({ tool: SAVE_TOOL, name: 'safe_helper', description: 'A safe helper', usage: `python ${file}`, path: file } as never)

    const result = await run($, 'jev-tool', 'clear safe_helper project')
    expect(result).toContain('1 deleted')
    expect(w.written.has(file)).toBe(false)
    expect(w.deletedFiles).toEqual([file])
    expect(w.processRuns[0]?.argv[0]).toBe('powershell.exe')
    expect(w.processRuns[0]?.argv.join(' ')).not.toContain(file)
    expect(w.processRuns[0]?.env?.JEV_ROUTER_DELETE_PATH).toBe(file)
  })

  test('status describes only data handled by the cleanup commands', { options }, async ($, on) => {
    mock.clock(on)
    memoryStore(on, { caps: { version: '9.9.9', families: { opus: {} } }, outputs: { high: [9] }, turnlen: [1] })
    world(on, () => ({ status: 200, body: {} }))

    const status = await run($, 'jev-data')
    expect(status).toContain('logs: 0 dated file(s)')
    expect(status).toContain('learned: 1 model families, 1 output samples, 1 turn lengths')
    expect(status).toContain('Preserved separately: plugin settings and API key.')
  })
})
