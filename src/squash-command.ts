/**
 * `/squash` command: argument parsing and the execution pipeline that runs
 * the vendored compaction engine over the child's post-fork region and
 * appends the merge checkpoint into the parent branch. Pure and
 * cordis-free, mirroring command.ts: the plugin shell in index.ts feeds a
 * parsed action plus {@link SquashCommandDeps}; everything here is
 * unit-testable with fake agents.
 * @module dsh-session-fork/src/squash-command
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { Session } from '@deepseek-ai/dsh-session'
import type { BranchCommandResult } from './command.js'
import { getBranch, loadRegistry } from './registry.js'
import {
  buildMergeCheckpoint,
  extractCheckpointMessage,
  postForkRange,
  squashErrorText,
  SquashCoreError,
} from './squash.js'
import { turnRangeOf } from './squash.js'
import type { MergeProvenance } from './squash.js'
import type { RegistryStore } from './types.js'
import type { CompactRegionRequest } from './vendor/compact.js'

export const SQUASH_USAGE = [
  'Usage:',
  '  /squash into <branch>   squash this branch back into <branch> as one summary',
].join('\n')

/** One parsed `/squash` invocation. */
export type SquashAction =
  | { readonly kind: 'squash'; readonly target: string }
  | { readonly kind: 'usage'; readonly problem: string }

/**
 * Parse the text after `/squash`. Never throws; anything but
 * `into <branch>` becomes a `usage` action that renders {@link SQUASH_USAGE}.
 */
export function parseSquashAction(rawInput: string): SquashAction {
  const tokens = rawInput.trim().split(/\s+/).filter(t => t.length > 0)
  const [head, second] = tokens as [string | undefined, string | undefined]
  if (head === undefined) return { kind: 'usage', problem: 'missing target branch' }
  if (head !== 'into') {
    return { kind: 'usage', problem: `expected 'into <branch>', got '${head}'` }
  }
  if (second === undefined) return { kind: 'usage', problem: `'into' needs a branch name` }
  if (tokens.length > 2) return { kind: 'usage', problem: `'into' takes exactly one branch name` }
  return { kind: 'squash', target: second }
}

/**
 * The agent shape squash needs: the public `Agent` plus the runtime phase
 * marker the agent-loop implementation carries (the public interface hides
 * it, but `runMaintenance`'s idle contract makes `phase.kind` the honest
 * fast gate for both the child and the parent).
 */
export type SquashAgent = Agent & { readonly phase: { readonly kind: string } }

/** Capabilities one `/squash` execution needs. */
export interface SquashCommandDeps {
  /** The child agent this command runs against (idle, per the command contract). */
  readonly childAgent: SquashAgent
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal: AbortSignal
  /** This command's identity, recorded in the merge provenance. */
  readonly commandId?: CommandId
  /** Per-workspace registry persistence. */
  readonly store: RegistryStore
  /** The vendored compaction shell (runMaintenance inside; see vendor/compact.ts). */
  readonly compact: (
    agent: Agent,
    signal: AbortSignal,
    request: CompactRegionRequest,
  ) => Promise<CompactionResult>
  /** Parent-side agent resolution (vendored ensureSession kernel). */
  readonly resolveParentAgent: (sessionId: string) => Promise<SquashAgent>
  /** Durability checkpoint for one agent's session (`ctx.sessions.flush`). */
  readonly flush: (agent: Agent) => Promise<unknown>
}

/** Render one unknown-target registry failure. */
function unknownBranch(name: string): string {
  return `no branch named '${name}' in this workspace`
}

/**
 * Execute one parsed `/squash` action. All failures return `kind: 'error'`
 * results — a command must never crash the host.
 */
export async function executeSquashAction(
  action: SquashAction,
  deps: SquashCommandDeps,
): Promise<BranchCommandResult> {
  if (action.kind === 'usage') {
    return { kind: 'error', text: `${action.problem}\n${SQUASH_USAGE}` }
  }
  return executeSquash(action.target, deps)
}

/**
 * The squash pipeline proper (issue #8: extracted so the RPC `squash`
 * endpoint reuses the exact command semantics): idle gate, lineage,
 * registry target check, post-fork range, vendored compaction, merge
 * checkpoint append into the parent, durability flush. Pure over the
 * injected agents and capabilities — never throws business failures.
 */
export async function executeSquash(
  target: string,
  deps: SquashCommandDeps,
): Promise<BranchCommandResult> {
  // Idle gate: the vendored shell re-checks through runMaintenance, but a
  // fast local check gives the squash-specific wording immediately.
  if (deps.childAgent.phase.kind !== 'idle') {
    return { kind: 'error', text: squashErrorText('busy') }
  }

  // Lineage: squash runs from a forked child and merges into the branch
  // that owns the child's parent session.
  const childSession = deps.childAgent.session as Session
  const parentSessionId = childSession.header.parentSession
  if (parentSessionId === undefined) {
    return {
      kind: 'error',
      text: 'squash must run from a forked child session — this session has no parent',
    }
  }

  const state = await loadRegistry(deps.store)
  let targetSessionId: string
  try {
    targetSessionId = getBranch(state, target).sessionId
  } catch {
    return { kind: 'error', text: unknownBranch(target) }
  }
  if (targetSessionId !== parentSessionId) {
    return {
      kind: 'error',
      text: `branch '${target}' is not this session's parent — squash into the branch this session was forked from`,
    }
  }

  // Fork anchor for the merge provenance: the child's own registry record
  // first, then the durable header lineage (seedLength anchors one past the
  // parent's turn-end seq, so atSeq = seedLength - 1).
  const childRecord = Object.values(state.branches)
    .find(record => record.sessionId === childSession.id)
  const atSeq = childRecord?.forkOrigin?.atSeq
    ?? (childSession.header.seedLength !== undefined ? childSession.header.seedLength - 1 : undefined)
  if (atSeq === undefined) {
    return { kind: 'error', text: 'cannot determine the fork anchor for merge provenance' }
  }
  // Branch names are point-in-time facts: resolve them from the registry now,
  // before building the merge envelope. The target is the registry key the
  // user named; the child must be a registered branch to be named in the
  // AI-visible provenance.
  const childName = childRecord?.name
  if (childName === undefined) {
    return {
      kind: 'error',
      text: 'cannot resolve this session\'s branch name — register the branch before squashing',
    }
  }

  let range
  try {
    range = postForkRange(childSession)
  } catch (error) {
    if (error instanceof SquashCoreError) return { kind: 'error', text: error.message }
    throw error
  }

  let result: CompactionResult
  try {
    result = await deps.compact(deps.childAgent, deps.signal, {
      start: range.start,
      end: range.end,
      flush: async () => { await deps.flush(deps.childAgent) },
      ...deps.commandId === undefined ? {} : { sourceCommandId: deps.commandId },
    })
  } catch (error) {
    if (error instanceof ManualCompactionError) {
      return { kind: 'error', text: squashErrorText(error.code) }
    }
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }

  let mergeMessage
  const provenance: MergeProvenance = {
    childSessionId: childSession.id,
    atSeq,
    shadowedRange: result.shadowedRange,
    shadowedSeqs: result.shadowedSeqs,
    turnRange: turnRangeOf(childSession, result.shadowedSeqs),
    compactionId: result.compactionId,
    ...deps.commandId === undefined ? {} : { sourceCommandId: deps.commandId },
  }
  try {
    mergeMessage = buildMergeCheckpoint(
      extractCheckpointMessage(childSession),
      provenance,
      { child: childName, target },
    )
  } catch (error) {
    if (error instanceof SquashCoreError) return { kind: 'error', text: error.message }
    throw error
  }

  let parentAgent: SquashAgent
  try {
    parentAgent = await deps.resolveParentAgent(parentSessionId)
  } catch (error) {
    return {
      kind: 'error',
      text: `could not open the parent branch's session: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (parentAgent.phase.kind !== 'idle') {
    return {
      kind: 'error',
      text: 'the parent branch\'s agent is busy — retry /squash once it goes idle',
    }
  }

  parentAgent.session.append('user/message', mergeMessage, { surfaceOp: 'append' })
  await deps.flush(parentAgent)

  return {
    kind: 'success',
    text: `Squashed ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens) into branch '${target}' as one checkpoint.`,
  }
}
