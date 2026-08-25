/**
 * Tests for the shared branch event envelopes: notice lines, tag symmetry,
 * paging coordinates, and the machine-readable provenance riding the message
 * source. The wording follows the official compaction checkpoint style
 * (English preamble + XML-style tags).
 * @module dsh-session-fork/tests/branch-events.test
 */

import { describe, expect, test } from 'bun:test'
import {
  branchNoticeLines,
  buildBranchEnvelope,
  buildBranchNotice,
} from '../src/branch-events.js'
import type { BranchEventFacts } from '../src/branch-events.js'

function text(message: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = message.content.find(b => b.type === 'text')
  return block?.text ?? ''
}

const forkFacts: BranchEventFacts = {
  kind: 'fork',
  from: 'main',
  to: 'review',
  atTurn: 12,
  fromSessionId: 'sess-abc',
}

const squashFacts: BranchEventFacts = {
  kind: 'squash',
  from: 'review',
  to: 'main',
  atTurn: 12,
  range: { start: 13, end: 20 },
  fromSessionId: 'sess-abc',
}

describe('buildBranchNotice', () => {
  test('renders the child line and the structured provenance on the source', () => {
    const message = buildBranchNotice(forkFacts, branchNoticeLines.forkChild(forkFacts))
    expect(text(message)).toBe(
      'You are branch "review", forked from branch "main" at turn 12. ' +
      'The conversation above was inherited from "main" — you did not produce it. ' +
      'Treat it as established background and continue the task from here.',
    )
    expect(message.role).toBe('user')
    expect(message.source).toMatchObject({
      kind: 'plugin',
      plugin: 'dsh-session-fork',
      form: 'notice',
      branchEvent: { kind: 'fork', from: 'main', to: 'review', atTurn: 12 },
    })
  })

  test('bounds the UI summary to the official 120-char notice limit', () => {
    const long: BranchEventFacts = { ...forkFacts, from: `main-${'x'.repeat(300)}` }
    const message = buildBranchNotice(long, branchNoticeLines.forkChild(long))
    const summary = (message.source as { summary: string }).summary
    expect(summary.length).toBeLessThanOrEqual(120)
    expect(summary.endsWith('…')).toBe(true)
  })

  test('renders the fork-parent line for the diverged parent', () => {
    const message = buildBranchNotice(forkFacts, branchNoticeLines.forkParent(forkFacts))
    expect(text(message)).toBe('Branch "review" forked from you at turn 12.')
  })
})

describe('buildBranchEnvelope', () => {
  test('wraps the payload in a symmetric tag pair with a full-provenance preamble', () => {
    const message = buildBranchEnvelope(squashFacts, 'Done A and B.')
    const t = text(message)
    expect(t.startsWith(
      'This is a squash from branch "review" (forked at turn 12, covering its turns 13–20) into branch "main". ' +
      'The summary below happened on "review" and was transferred by dsh-session-fork; ' +
      "it is not part of this branch's own conversation. Treat it as established background.\n" +
      '<branch-squash>\n',
    )).toBe(true)
    expect(t).toContain('Done A and B.')
    expect(t.endsWith('</branch-squash>')).toBe(true)
    const opens = t.match(/<branch-squash>/g) ?? []
    const closes = t.match(/<\/branch-squash>/g) ?? []
    expect(opens.length).toBe(1)
    expect(closes.length).toBe(1)
  })

  test('omits the fork clause when atTurn is unknown, keeping the range', () => {
    const facts: BranchEventFacts = { kind: 'rebased-into', from: 'review', to: 'main', range: { start: 13, end: 20 } }
    const message = buildBranchEnvelope(facts, 'transcript')
    expect(text(message)).toContain(
      'This is a rebased-into from branch "review" (covering its turns 13–20) into branch "main".',
    )
  })

  test('names the material per kind: summary vs transcript', () => {
    expect(text(buildBranchEnvelope(squashFacts, 'x'))).toContain('The summary below happened on')
    const rebasedInto: BranchEventFacts = { kind: 'rebased-into', from: 'review', to: 'main' }
    expect(text(buildBranchEnvelope(rebasedInto, 'x'))).toContain('The transcript below happened on')
  })

  test('pages a long rebased-into transcript with stable coordinates in tags and summary', () => {
    const message = buildBranchEnvelope(squashFacts, 'page body', { index: 2, total: 3 })
    const t = text(message)
    expect(t).toContain('<branch-squash 2/3>\npage body\n</branch-squash>')
    expect((message.source as { summary: string }).summary).toBe('squash 2/3: review → main')
  })

  test('a single page (total 1) renders unpaged', () => {
    const message = buildBranchEnvelope(squashFacts, 'body', { index: 1, total: 1 })
    expect(text(message)).toContain('<branch-squash>\nbody\n</branch-squash>')
  })

  test('rebased-into transcripts use the recall context form', () => {
    const rebasedInto: BranchEventFacts = { kind: 'rebased-into', from: 'review', to: 'main' }
    expect((buildBranchEnvelope(rebasedInto, 't').source as { form: string }).form).toBe('recall')
    expect((buildBranchEnvelope(squashFacts, 't').source as { form: string }).form).toBe('notice')
  })
})

describe('source extensions (extraSource)', () => {
  const tracedFacts: BranchEventFacts = {
    ...squashFacts,
  }

  test('extraSource fields ride the built message source after branchEvent', () => {
    const extra = {
      childSessionId: 'sess-child',
      atSeq: 7,
      shadowedRange: { start: 13, end: 20 },
      shadowedSeqs: [26, 27],
      sourceCommandId: 'cmd-9',
    }
    expect(buildBranchEnvelope(tracedFacts, 'payload', undefined, extra).source).toMatchObject({
      kind: 'plugin',
      plugin: 'dsh-session-fork',
      branchEvent: tracedFacts,
      ...extra,
    })
    expect(buildBranchNotice(tracedFacts, 'line', { childSessionId: 'sess-child' }).source).toMatchObject({
      branchEvent: tracedFacts,
      childSessionId: 'sess-child',
    })
  })

  test('omitting extraSource leaves the source shape unchanged (regression)', () => {
    const source = buildBranchEnvelope(squashFacts, 'payload').source as Record<string, unknown>
    expect(Object.keys(source).sort()).toEqual(['branchEvent', 'form', 'kind', 'plugin', 'summary'])
    const noticeSource = buildBranchNotice(forkFacts, 'line').source as Record<string, unknown>
    expect(Object.keys(noticeSource).sort()).toEqual(['branchEvent', 'form', 'kind', 'plugin', 'summary'])
  })
})
