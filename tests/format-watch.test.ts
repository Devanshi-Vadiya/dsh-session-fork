/**
 * Format watch tests: pin every message source this plugin writes to the
 * FROZEN plugin-source vocabulary of the dsh session format.
 * @module dsh-session-fork/tests/format-watch.test
 *
 * Why: the format's read path (the v0→v1→v2 migration chain and the v2
 * restore validation; deepseek-harness d1521ea783 "feat(session)!: add
 * released format migration", 2026-09-01) enforces a CLOSED allowlist on
 * `kind: 'plugin'` message sources. An unknown member does not merely
 * degrade — it makes the whole session log refuse to load
 * ("…has unexpected member…"). On 2026-09-05 the retired `branchEvent`
 * extension did exactly that to 66 stored logs, which is why the plugin's
 * builders now stay strictly inside the vocabulary and machine facts ride
 * the preamble text instead.
 *
 * Upstream source of truth (re-sync when upgrading dsh):
 * deepseek-harness/packages/session/session-format-v0-to-v1/src/
 * payload-validation.ts — `pluginSourceValue` (v0/v1/v2 read paths share
 * it; v2 calls it through session-format-v1-to-v2/src/validation.ts
 * `assertPayload`). The validator package is not published to npm, so this
 * test re-states the rule and holds every builder output against it.
 *
 * On failure: do NOT relax the assertion. Re-read the upstream rule, adapt
 * the builders (src/branch-events.ts, src/squash.ts, src/squash-midturn.ts)
 * to stay inside the vocabulary, and keep machine facts in the preamble.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  branchNoticeLines,
  buildBranchEnvelope,
  buildBranchNotice,
  type BranchEventFacts,
} from '../src/branch-events.js'
import { buildMergeCheckpoint } from '../src/squash.js'
import { handoffReport } from '../src/squash-midturn.js'
import type { BranchCommandResult } from '../src/command.js'

/** `ContextForm` literals the frozen vocabulary admits on a plugin source. */
const PLUGIN_FORMS: readonly string[] = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']

/** Optional plugin-source members every plugin may carry. */
const BASE_OPTIONAL: readonly string[] = ['form', 'sections', 'summary']

/** Additional members only `plugin: 'compact'` sources may carry. */
const COMPACT_ONLY: readonly string[] = ['compactionId', 'sourceCommandId']

/**
 * Mirror of the upstream `pluginSourceValue` rule (see module docblock):
 * exact key allowlist plus the form-dependent requirements. Deliberately
 * literal — when this disagrees with upstream, the builders change, never
 * this mirror.
 */
function assertLegalPluginSource(source: unknown): void {
  expect(source).toBeTypeOf('object')
  expect(source).not.toBeNull()
  const record = source as Record<string, unknown>
  expect(record['kind']).toBe('plugin')
  expect(record['plugin']).toBeTypeOf('string')
  expect(record['plugin'] as string).not.toBe('')
  const optional = record['plugin'] === 'compact' ? [...BASE_OPTIONAL, ...COMPACT_ONLY] : BASE_OPTIONAL
  const allowed = new Set(['kind', 'plugin', ...optional])
  const unexpected = Object.keys(record).filter(key => !allowed.has(key))
  expect(unexpected).toEqual([])
  if (record['plugin'] === 'compact') {
    expect(record['compactionId']).toBeTypeOf('string')
    expect(record['compactionId'] as string).not.toBe('')
    if (record['sourceCommandId'] !== undefined) {
      expect(record['sourceCommandId']).toBeTypeOf('string')
      expect(record['sourceCommandId'] as string).not.toBe('')
    }
  }
  const form = record['form']
  if (form === undefined) return
  expect(PLUGIN_FORMS).toContain(form)
  if (form === 'snapshot') {
    expect(record['sections']).toBeTypeOf('object')
    expect(Array.isArray(record['sections'])).toBe(true)
  } else {
    expect('sections' in record).toBe(false)
  }
  if (form === 'notice') {
    expect(record['summary']).toBeTypeOf('string')
  } else {
    expect('summary' in record).toBe(false)
  }
}

/** Every message a writer can emit, labeled for failure readability. */
function everyPluginMessage(): readonly [label: string, message: UserMessage][] {
  const forkFacts: BranchEventFacts = { kind: 'fork', from: 'main', to: 'review', atTurn: 12 }
  const adoptFacts: BranchEventFacts = { kind: 'adopt', from: 'sess-abc', to: 'main' }
  const renameFacts: BranchEventFacts = { kind: 'rename', from: 'main', to: 'develop' }
  const squashFacts: BranchEventFacts = {
    kind: 'squash', from: 'review', to: 'main', atTurn: 12, range: { start: 13, end: 20 },
  }
  const rebasedIntoFacts: BranchEventFacts = { kind: 'rebased-into', from: 'review', to: 'main' }
  const messageFacts: BranchEventFacts = { kind: 'message', from: 'feat/review', to: 'main' }

  const checkpoint = buildBranchNotice(forkFacts, 'checkpoint placeholder')
  const success: BranchCommandResult = { kind: 'success', text: 'Squashed 3 surface nodes into branch \'main\'.' }
  const failure: BranchCommandResult = { kind: 'error', text: 'Squash is unavailable.' }

  return [
    ['notice: fork child seed', buildBranchNotice(forkFacts, branchNoticeLines.forkChild(forkFacts))],
    ['notice: fork parent', buildBranchNotice(forkFacts, branchNoticeLines.forkParent(forkFacts))],
    ['notice: adopt', buildBranchNotice(adoptFacts, branchNoticeLines.adopted(adoptFacts))],
    ['notice: rename', buildBranchNotice(renameFacts, branchNoticeLines.renamed(renameFacts))],
    ['envelope: squash', buildBranchEnvelope(squashFacts, 'the conclusion')],
    ['envelope: rebased-into', buildBranchEnvelope(rebasedIntoFacts, 'transcript page')],
    ['envelope: rebased-into paged', buildBranchEnvelope(rebasedIntoFacts, 'page 2', { index: 2, total: 3 })],
    ['envelope: message', buildBranchEnvelope(messageFacts, 'please handle the checkpoint')],
    [
      'merge checkpoint: no command id',
      buildMergeCheckpoint(checkpoint, { compactionId: CompactionId('c-1') }, { child: 'review', target: 'main' }),
    ],
    [
      'merge checkpoint: with command id',
      buildMergeCheckpoint(
        checkpoint,
        { compactionId: CompactionId('c-2'), turnRange: { start: 2, end: 5 }, sourceCommandId: 'cmd-7' as CommandId },
        { child: 'review', target: 'main' },
      ),
    ],
    ['handoff report: success', handoffReport('main', success)],
    ['handoff report: failure', handoffReport('main', failure)],
  ]
}

describe('frozen plugin-source vocabulary (format watch)', () => {
  test('every message this plugin writes carries a legal plugin source', () => {
    for (const [, message] of everyPluginMessage()) {
      assertLegalPluginSource(message.source)
    }
  })

  test('the official compact checkpoint constructor stays legal under the mirror', () => {
    // vendor/compact.ts writes its checkpoints with the OFFICIAL
    // `compactCheckpointSource` — pin that the mirror agrees with it, so a
    // rule drift here cannot silently condemn the vendored path either.
    assertLegalPluginSource(compactCheckpointSource(CompactionId('official-1')))
  })

  test('the writer inventory stays complete (every createUserMessage site is asserted)', () => {
    // The inventory in everyPluginMessage is only as good as its coverage,
    // so discover it: every module under src/ that calls createUserMessage
    // must be a known writer whose output this file asserts (directly or
    // via a builder) — a new writer fails here until it is added above.
    const srcRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')
    const discovered: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').includes('createUserMessage(')) {
          discovered.push(relative(srcRoot, path).split(sep).join('/'))
        }
      }
    }
    walk(srcRoot)
    expect(discovered.sort()).toEqual([
      'branch-events.ts',
      'squash-midturn.ts',
      'squash.ts',
      'vendor/compact.ts',
    ])
  })
})
