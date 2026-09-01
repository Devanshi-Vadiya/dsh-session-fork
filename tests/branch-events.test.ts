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

const adoptFacts: BranchEventFacts = {
  kind: 'adopt',
  from: 'sess-abc',
  to: 'main',
}

const renameFacts: BranchEventFacts = {
  kind: 'rename',
  from: 'main',
  to: 'develop',
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

  test('renders the adopt line stating the session is now a root branch (issue #37)', () => {
    const message = buildBranchNotice(adoptFacts, branchNoticeLines.adopted(adoptFacts))
    expect(text(message)).toBe(
      'This session is now branch "main" — the root branch of this workspace (adopted via /branch adopt). '
      + 'The conversation is your own work. Treat branch-scoped operations (fork from here, squash into you, '
      + 'rebased into you) as applying to this session.',
    )
    expect(message.source).toMatchObject({
      form: 'notice',
      branchEvent: { kind: 'adopt', from: 'sess-abc', to: 'main' },
    })
  })

  test('renders the rename line stating old and new vocabulary (issue #37)', () => {
    const message = buildBranchNotice(renameFacts, branchNoticeLines.renamed(renameFacts))
    expect(text(message)).toBe(
      'Your branch was renamed: "main" is now "develop". '
      + 'Use "develop" in branch commands (/squash into, /rebased into, /branch rm). '
      + 'Earlier notices may still say "main" — they were true when written.',
    )
    expect(message.source).toMatchObject({
      form: 'notice',
      branchEvent: { kind: 'rename', from: 'main', to: 'develop' },
    })
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

  test('a message envelope marks the payload as peer input, not background (issue #47)', () => {
    const messageFacts: BranchEventFacts = {
      kind: 'message',
      from: 'feat/review',
      to: 'main',
      fromSessionId: 'sess-review',
    }
    const message = buildBranchEnvelope(messageFacts, 'please handle the checkpoint')
    const t = text(message)
    expect(t).toContain('This is a message from branch "feat/review" into branch "main"')
    expect(t).toContain('The message below happened on')
    expect(t).toContain('<branch-message>')
    expect(t.endsWith('</branch-message>')).toBe(true)
    expect(t).toContain('act on it or reply as appropriate')
    expect(t).not.toContain('Treat it as established background')
    expect((message.source as { form: string }).form).toBe('notice')
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
