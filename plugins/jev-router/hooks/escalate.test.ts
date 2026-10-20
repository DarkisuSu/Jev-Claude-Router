import { describe, expect, test } from 'claude-code/testing'

import { afterEscalation, emptySignals, nextRung, noteCall, raise, triggered, type Call, type Signals, type Thresholds } from './escalate'
import type { Caps } from './model'

const LIMITS: Thresholds = { failures: 3, repeats: 3, edits: 4, max: 2 }
const bash = (command: string, isError = false): Call => ({ tool: 'Bash', input: { command }, isError, denied: false })
const edit = (file_path: string, isError = false): Call => ({ tool: 'Edit', input: { file_path }, isError, denied: false })
const feed = (calls: Call[]): Signals => calls.reduce(noteCall, emptySignals())

describe('signs of trouble', () => {
  test('failed work calls in a row trigger; one that works ends the run', () => {
    expect(triggered(feed([bash('a', true), bash('b', true)]), LIMITS)).toBeUndefined()
    expect(triggered(feed([bash('a', true), bash('b', true), bash('c', true)]), LIMITS)).toBe('failures')
    expect(triggered(feed([bash('a', true), bash('b', true), bash('c'), bash('d', true)]), LIMITS)).toBeUndefined()
  })

  test('the same operation failing again triggers, even with successes between', () => {
    const calls = [bash('npm test', true), bash('ls'), bash('npm test', true), bash('ls'), bash('npm test', true)]
    expect(triggered(feed(calls), LIMITS)).toBe('repeat-failure')
  })

  test('a file edited back and forth triggers; other files do not add up', () => {
    expect(triggered(feed([edit('a.cs'), edit('b.cs'), edit('a.cs'), edit('b.cs'), edit('c.cs')]), LIMITS)).toBeUndefined()
    expect(triggered(feed([edit('a.cs'), edit('a.cs'), edit('a.cs'), edit('a.cs')]), LIMITS)).toBe('edits')
  })

  test('searching is not trouble: a failed Read or Grep counts for nothing', () => {
    const miss = (tool: string): Call => ({ tool, input: { file_path: 'x' }, isError: true, denied: false })
    expect(triggered(feed([miss('Read'), miss('Grep'), miss('Read'), miss('Glob')]), LIMITS)).toBeUndefined()
  })

  test('a call the person refused is not the work failing', () => {
    const refused: Call = { tool: 'Bash', input: { command: 'rm -rf x' }, isError: true, denied: true }
    expect(triggered(feed([refused, refused, refused]), LIMITS)).toBeUndefined()
  })

  test('after an escalation the evidence starts over, and a turn climbs only so often', () => {
    const trouble = feed([bash('a', true), bash('b', true), bash('c', true)])
    const once = afterEscalation(trouble)
    expect(once.escalations).toBe(1)
    expect(triggered(once, LIMITS)).toBeUndefined()
    expect(triggered(feed([]), LIMITS)).toBeUndefined()
    const again = { ...afterEscalation(once), consecutive: 3 }
    expect(again.escalations).toBe(2)
    expect(triggered(again, LIMITS)).toBeUndefined()
  })

  test('commands are told apart by their first 80 characters, whitespace folded', () => {
    const calls = [bash('npm   test', true), bash('npm test', true), bash('npm\ttest', true)]
    expect(triggered({ ...feed(calls), consecutive: 0 }, LIMITS)).toBe('repeat-failure')
  })
})

const CAPS: Caps = {
  version: '9.9.9',
  families: {
    sonnet: { id: 'claude-sonnet-x', ok: true, effort: true, at: '' },
    opus: { id: 'claude-opus-x', ok: true, effort: true, at: '' },
  },
}

describe('the next rung', () => {
  test('effort goes up a level while there is one', () => {
    expect(nextRung({ model: 'claude-sonnet-x', effort: 'medium' }, CAPS, new Set())).toEqual({ pair: { model: 'claude-sonnet-x', effort: 'high' }, kind: 'effort' })
    expect(nextRung({ model: 'claude-sonnet-x', effort: 'xhigh' }, CAPS, new Set())?.pair.effort).toBe('max')
  })

  test('at max the model goes up a family, at a high effort, if it was seen answering', () => {
    expect(nextRung({ model: 'claude-sonnet-x', effort: 'max' }, CAPS, new Set())).toEqual({ pair: { model: 'claude-opus-x', effort: 'high' }, kind: 'model' })
  })

  test('no rung where the larger family is unknown, failed, or the top is reached', () => {
    expect(nextRung({ model: 'claude-sonnet-x', effort: 'max' }, undefined, new Set())).toBeUndefined()
    expect(nextRung({ model: 'claude-sonnet-x', effort: 'max' }, CAPS, new Set(['opus']))).toBeUndefined()
    expect(nextRung({ model: 'claude-opus-x', effort: 'max' }, CAPS, new Set())).toBeUndefined()
    const unseen: Caps = { version: '9', families: { opus: { id: 'claude-opus-x', at: '' } } }
    expect(nextRung({ model: 'claude-sonnet-x', effort: 'max' }, unseen, new Set())).toBeUndefined()
  })

  test('a model that takes no effort moves to the next family; no effort is carried over blindly', () => {
    const none: Caps = { version: '9', families: { sonnet: { id: 'claude-sonnet-x', ok: true, effort: false, at: '' }, opus: { id: 'claude-opus-x', ok: true, effort: false, at: '' } } }
    expect(nextRung({ model: 'claude-sonnet-x', effort: 'medium' }, none, new Set())).toEqual({ pair: { model: 'claude-opus-x', effort: undefined }, kind: 'model' })
  })
})

describe('the floor an escalation sets', () => {
  test('a step is never lower than the floor, in family or in effort', () => {
    const floor = { model: 'claude-sonnet-x', effort: 'high' }
    expect(raise({ model: 'claude-sonnet-x', effort: 'medium' }, floor)).toEqual({ model: 'claude-sonnet-x', effort: 'high' })
    expect(raise({ model: 'claude-sonnet-x', effort: 'xhigh' }, floor)).toEqual({ model: 'claude-sonnet-x', effort: 'xhigh' })
    expect(raise({ model: 'claude-haiku-x', effort: 'medium' }, floor)).toEqual({ model: 'claude-sonnet-x', effort: 'high' })
    expect(raise({ model: 'claude-opus-x', effort: 'low' }, floor)).toEqual({ model: 'claude-opus-x', effort: 'high' })
  })

  test('without a floor the plan stands', () => {
    expect(raise({ model: 'claude-sonnet-x', effort: 'low' }, undefined)).toEqual({ model: 'claude-sonnet-x', effort: 'low' })
  })
})
