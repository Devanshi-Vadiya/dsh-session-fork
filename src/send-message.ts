/**
 * Branch-to-branch messaging (issue #47): the pure executor behind the
 * `send_message_by_branch` tool. One registered branch sends a short text message to
 * another registered branch BY NAME; the message rides the shared
 * `<branch-message>` envelope (src/branch-events.ts) and is delivered into
 * the target's inbox through `agent.steer()` — the waking transport:
 * a busy target claims it at its nearest step boundary, an idle target
 * starts a turn for it. One primitive covers both target states; there is
 * deliberately no `inject` (no-wake) mode and no busy gate.
 *
 * Fail-fast by design: an empty text, an unknown branch name, a self-send,
 * or an unregistered caller each return an `error` result BEFORE any
 * delivery — the tool layer renders it as an isError result the sending
 * model sees in the SAME turn and may correct and retry immediately.
 *
 * The sender is never gated: unlike squash (compacts the source) and
 * rebased-into (serializes the source's surface), a message reads only the
 * sender's session id and registry name, so a RUNNING sender is fine — an
 * agent mid-task can dispatch a message without ending its turn.
 *
 * Durability envelope: the steered envelope becomes durable once the target
 * claims it into its session log (the same boundary inject-based squash
 * delivery has); an UNCLAIMED steer may be discarded by the target's
 * cancellation or disposal. No journal, no retry queue — the branch's own
 * session log is the durable record once claimed.
 *
 * Pure and cordis-free, mirroring rebased-into-command.ts: the plugin shell
 * in index.ts feeds {@link SendMessageDeps}; unit-testable with fake agents.
 * @module dsh-session-fork/src/send-message
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { buildBranchEnvelope } from './branch-events.js'
import type { BranchEventFacts } from './branch-events.js'
import type { BranchCommandResult } from './command.js'
import { getBranch, loadRegistry } from './registry.js'
import type { RegistryStore } from './types.js'

/**
 * The target-agent shape messaging needs: the public `Agent`, whose `steer`
 * is the transport (waking: idle target starts a turn, busy target claims
 * at its nearest step boundary).
 */
export type MessageTargetAgent = Agent & {
  readonly steer: (message: Parameters<Agent['steer']>[0]) => void
}

/** Capabilities one send-message execution needs. */
export interface SendMessageDeps {
  /** The sending agent's session; only its id is read (a running sender is fine). */
  readonly sourceSession: Session
  /** Per-workspace registry persistence. */
  readonly store: RegistryStore
  /** Target-side agent resolution (vendored ensureSession kernel: resume, never create). */
  readonly resolveTargetAgent: (sessionId: string) => Promise<MessageTargetAgent>
  /** Durability checkpoint for the target's session (`ctx.sessions.flush`). */
  readonly flush: (agent: Agent) => Promise<unknown>
}

/** Render one unknown-target registry failure. */
function unknownBranch(name: string): string {
  return `no branch named '${name}' in this workspace`
}

/**
 * The send-message pipeline: argument gate, registry lookups (target by
 * name, source name by session id), shared envelope, waking delivery into
 * the target, durability flush. The source session is never mutated — a
 * message is a registry read on the source and a queue write on the target.
 * All failures return `kind: 'error'` results — never throws.
 * @param target - the receiving branch's registry name.
 * @param text - the message body, delivered verbatim inside the envelope.
 * @param deps - the executor capabilities (see {@link SendMessageDeps}).
 * @returns the command result; success text states the delivery semantics.
 */
export async function executeSendMessage(
  target: string,
  text: string,
  deps: SendMessageDeps,
): Promise<BranchCommandResult> {
  if (text.trim().length === 0) {
    return { kind: 'error', text: 'the message text is empty' }
  }

  const state = await loadRegistry(deps.store)
  let targetSessionId: string
  try {
    targetSessionId = getBranch(state, target).sessionId
  } catch {
    return { kind: 'error', text: unknownBranch(target) }
  }
  if (targetSessionId === deps.sourceSession.id) {
    // Misuse guard (issue #47 discussion): a branch messaging itself reads
    // as a note-to-self but in practice only confuses turn attribution.
    return { kind: 'error', text: 'a branch cannot send a message to itself' }
  }

  // The sender's own registry name, resolved BEFORE building facts: envelope
  // wording is point-in-time by contract, exactly like the transfer events.
  const sourceRecord = Object.values(state.branches)
    .find(record => record.sessionId === deps.sourceSession.id)
  if (sourceRecord === undefined) {
    return {
      kind: 'error',
      text: 'this session is not registered as a branch — adopt or fork it first',
    }
  }

  const facts: BranchEventFacts = {
    kind: 'message',
    from: sourceRecord.name,
    to: target,
    fromSessionId: deps.sourceSession.id,
  }
  const envelope = buildBranchEnvelope(facts, text)

  let targetAgent: MessageTargetAgent
  try {
    targetAgent = await deps.resolveTargetAgent(targetSessionId)
  } catch (error) {
    return {
      kind: 'error',
      text: `could not open the target branch's session: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  // Waking transport, no busy gate (issue #47): steer covers both target
  // states with one primitive — busy claims at the nearest step boundary
  // (several messages together cost one step), idle starts a turn.
  targetAgent.steer(envelope)
  await deps.flush(targetAgent)

  return {
    kind: 'success',
    text: `Message sent to branch '${target}' — it enters that branch's context at its nearest step boundary; an idle branch starts a turn for it. Delivery is confirmed, a reply is not awaited.`,
  }
}
