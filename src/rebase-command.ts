/**
 * `/rebase` command: argument parsing and the execution pipeline that
 * serializes this branch's post-fork conversation (verbatim, including
 * tool-use and thinking) and injects it into an arbitrary target branch's
 * inbox through the shared branch-event envelope. Pure and cordis-free,
 * mirroring squash-command.ts: the plugin shell in index.ts feeds a parsed
 * action plus {@link RebaseCommandDeps}; unit-testable with fake agents.
 *
 * Transport contract (docs/design/rebase.md): the target is NEVER busy-gated
 * — `inject` queues durably (next-step, no wake), so a running target claims
 * the transcript at its nearest step boundary and an idle one holds it until
 * its next turn. That is the whole point of rebase-via-inbox (issue #27
 * sibling semantics).
 * @module dsh-session-fork/src/rebase-command
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { buildBranchEnvelope } from './branch-events.js'
import type { BranchEventFacts } from './branch-events.js'
import type { BranchCommandResult } from './command.js'
import { mergeRegion } from './merge-region.js'
import { serializeTranscript } from './rebase.js'
import { getBranch, loadRegistry } from './registry.js'
import type { RegistryStore } from './types.js'

export const REBASE_USAGE = [
  'Usage:',
  '  /rebase <branch>   transfer this branch\'s own conversation verbatim into <branch>',
].join('\n')

/** One parsed `/rebase` invocation. */
export type RebaseAction =
  | { readonly kind: 'rebase'; readonly target: string }
  | { readonly kind: 'usage'; readonly problem: string }

/**
 * Parse the text after `/rebase`. Never throws; anything but a single branch
 * name becomes a `usage` action that renders {@link REBASE_USAGE}.
 */
export function parseRebaseAction(rawInput: string): RebaseAction {
  const tokens = rawInput.trim().split(/\s+/).filter(t => t.length > 0)
  const [head, second] = tokens as [string | undefined, string | undefined]
  if (head === undefined) return { kind: 'usage', problem: 'missing target branch' }
  if (head === 'into') {
    // Squash-compatible phrasing: accept it, but only with one branch name.
    if (second === undefined) return { kind: 'usage', problem: `'into' needs a branch name` }
    if (tokens.length > 2) return { kind: 'usage', problem: `'into' takes exactly one branch name` }
    return { kind: 'rebase', target: second }
  }
  if (tokens.length > 1) return { kind: 'usage', problem: `'${head}' takes no extra arguments` }
  return { kind: 'rebase', target: head }
}

/**
 * The agent shape rebase needs: the public `Agent` (its `inject` is the
 * transport) plus the runtime phase marker for the SOURCE idle gate — the
 * command contract hands over an idle agent, and the gate keeps the honest
 * wording symmetric with squash. The TARGET is deliberately not gated.
 */
export type RebaseAgent = Agent & {
  readonly phase: { readonly kind: string }
  readonly inject: (message: Parameters<Agent['inject']>[0]) => void
}

/** Capabilities one `/rebase` execution needs. */
export interface RebaseCommandDeps {
  /** The source agent this command runs against (idle, per the command contract). */
  readonly sourceAgent: RebaseAgent
  /** Per-workspace registry persistence. */
  readonly store: RegistryStore
  /** Target-side agent resolution (vendored ensureSession kernel: resume, never create). */
  readonly resolveTargetAgent: (sessionId: string) => Promise<RebaseAgent>
  /** Durability checkpoint for one agent's session (`ctx.sessions.flush`). */
  readonly flush: (agent: Agent) => Promise<unknown>
}

/** Render one unknown-target registry failure. */
function unknownBranch(name: string): string {
  return `no branch named '${name}' in this workspace`
}

/**
 * Execute one parsed `/rebase` action. All failures return `kind: 'error'`
 * results — a command must never crash the host.
 */
export async function executeRebaseAction(
  action: RebaseAction,
  deps: RebaseCommandDeps,
): Promise<BranchCommandResult> {
  if (action.kind === 'usage') {
    return { kind: 'error', text: `${action.problem}\n${REBASE_USAGE}` }
  }
  return executeRebase(action.target, deps)
}

/**
 * The rebase pipeline proper: source idle gate, registry lookups (source
 * name by session id, target by name), post-fork region with the shared
 * squash gates, verbatim serialization, shared envelope, inbox injection
 * into the target, durability flush. The source session is never mutated —
 * rebase is a read on the source and a queue write on the target.
 */
export async function executeRebase(
  target: string,
  deps: RebaseCommandDeps,
): Promise<BranchCommandResult> {
  // Source idle gate: the command contract promises an idle agent; refuse
  // loudly if that contract is ever violated (a moving source would serialize
  // a region the agent is still appending to).
  if (deps.sourceAgent.phase.kind !== 'idle') {
    return { kind: 'error', text: 'Rebase is unavailable while this branch is not idle.' }
  }

  const sourceSession = deps.sourceAgent.session as Session

  const state = await loadRegistry(deps.store)
  let targetSessionId: string
  try {
    targetSessionId = getBranch(state, target).sessionId
  } catch {
    return { kind: 'error', text: unknownBranch(target) }
  }
  if (targetSessionId === sourceSession.id) {
    return { kind: 'error', text: 'cannot rebase a branch into itself' }
  }

  // The source branch's own registry name, resolved BEFORE building facts:
  // envelope wording is point-in-time by contract.
  const sourceRecord = Object.values(state.branches)
    .find(record => record.sessionId === sourceSession.id)
  if (sourceRecord === undefined) {
    return {
      kind: 'error',
      text: 'this session is not registered as a branch — adopt or fork it first',
    }
  }

  // Lineage authority: any target goes (direct parent, distant relative, no
  // kinship); the region tracks what this branch carries that the target
  // lacks. See docs/design/rebase.md §merge-region.
  const region = mergeRegion(state, sourceSession, targetSessionId)
  if (region.kind === 'error') {
    return { kind: 'error', text: region.message.replace(/^(?:squash|merge-region):/, 'rebase:') }
  }

  const transcript = serializeTranscript(sourceSession, region)
  if (transcript.nodeCount === 0) {
    return { kind: 'error', text: 'rebase: this branch has no conversation of its own yet' }
  }

  const facts: BranchEventFacts = {
    kind: 'rebase',
    from: sourceRecord.name,
    to: target,
    ...transcript.turns.start !== undefined && transcript.turns.end !== undefined
      ? { range: { start: transcript.turns.start, end: transcript.turns.end } }
      : {},
    fromSessionId: sourceSession.id,
  }
  const envelope = buildBranchEnvelope(facts, transcript.text)

  let targetAgent: RebaseAgent
  try {
    targetAgent = await deps.resolveTargetAgent(targetSessionId)
  } catch (error) {
    return {
      kind: 'error',
      text: `could not open the target branch's session: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  // No busy gate, by design (docs/design/rebase.md §2): inject queues durably.
  targetAgent.inject(envelope)
  await deps.flush(targetAgent)

  const turnsPart = transcript.turns.start !== undefined && transcript.turns.end !== undefined
    ? ` (turns ${transcript.turns.start}–${transcript.turns.end})`
    : ''
  return {
    kind: 'success',
    text: `Rebased ${transcript.nodeCount} messages${turnsPart} from '${sourceRecord.name}' into branch '${target}' (${relationWording(region.relation)}). The transcript is queued and enters its context at the next step boundary.`,
  }
}

/** One-line human wording for a merge-region relation. */
function relationWording(relation: string): string {
  switch (relation) {
    case 'direct-parent': return 'back into its fork parent'
    case 'ancestor': return 'back into an ancestor branch'
    case 'source-ancestor': return 'into a descendant branch'
    case 'relative': return 'across a shared lineage'
    default: return 'no shared lineage'
  }
}
