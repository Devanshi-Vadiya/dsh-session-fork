/**
 * dsh-session-fork: git-style conversation branching for DeepSeek Harness.
 * @module dsh-session-fork
 *
 * v0.0.1 (ref layer): a per-workspace branch registry persisted through the
 * storage-domain facility, plus the `/branch` command family. Host-side
 * only; zero client/GUI changes (see docs/ROADMAP.md).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
// Type-only presence import: pulls in this package's Context augmentation
// (`ctx.sessionPersistence`) without any runtime dependency on it.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Same presence pattern for the compaction services the squash pipeline
// consumes (`ctx.llm`, `ctx.tokenMeter`).
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
// Same presence pattern for the prompt-assembly service the vocabulary
// section registers into (`ctx.systemPrompt`, issue #28).
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ArchiveOutcome, BranchPorts, SourceSessionView } from './branch.js'
import { BranchArchiveError, BranchForkError } from './branch.js'
import { executeBranchAction, parseBranchAction, createNamedBranch } from './command.js'
import type { BranchCommandDeps } from './command.js'
import { forkSeedNoticeEvent } from './branch.js'
import { loadRegistry, saveRegistry } from './registry.js'
import { createBranchRpcHandler, registerRpcChannel } from './rpc.js'
import type { BranchRpcPorts, ConnectionRpcLike } from './rpc.js'
import { executeRebasedIntoAction, parseRebasedIntoAction } from './rebased-into-command.js'
import type { RebasedIntoAgent, RebasedIntoCommandDeps } from './rebased-into-command.js'
import { executeSquashAction, parseSquashAction } from './squash-command.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { dispatchSquashAction } from './squash-midturn.js'
import type { SquashChildAgent } from './squash-command.js'
import type { SquashHandoffDeps } from './squash-midturn.js'
import { registerBranchTools } from './tools.js'
import type { BranchToolPorts } from './tools.js'
import {
  BRANCH_VOCABULARY,
  BRANCH_VOCABULARY_ORDER,
  BRANCH_VOCABULARY_SECTION,
} from './prompt.js'
import {
  BRANCH_IDENTITY_ORDER,
  BRANCH_IDENTITY_SECTION,
  branchIdentityProvider,
  createBranchIdentity,
  identityTrackingStore,
} from './branch-identity.js'
import { createDomainStore, dshForkDomainSpec } from './store.js'
import type { DomainLike } from './store.js'
import { compactNow } from './vendor/compact.js'
import { resolveSessionPreset } from './vendor/resolve-session-preset.js'
import { composeAgent, forkWorkspace, getOrResumeAgent, getOrResumeDeps } from './vendor/fork.js'
import type { AgentPresetsLike, WorkspaceLike } from './vendor/fork.js'

export type * from './types.js'
export {
  BranchRegistryError,
  assertBranchNameFree,
  createBranch,
  createFileStore,
  emptyState,
  getBranch,
  listBranches,
  loadRegistry,
  removeBranch,
  renameBranch,
  saveRegistry,
  setBranchSession,
} from './registry.js'
export type { CreateBranchInput } from './registry.js'
export {
  BranchForkError,
  createBranchFrom,
  createRootBranch,
} from './branch.js'
export type {
  BranchPorts,
  CreateBranchOptions,
  SourceEvent,
  SourceSessionView,
} from './branch.js'
export {
  BRANCH_USAGE,
  branchErrorMessage,
  createNamedBranch,
  executeBranchAction,
  parseBranchAction,
} from './command.js'
export type { BranchAction, BranchCommandResult } from './command.js'
export {
  RPC_CHANNEL,
  createBranchRpcHandler,
  registerRpcChannel,
} from './rpc.js'
export type {
  BranchRpcPorts,
  BranchSnapshot,
  ConnectionRpcLike,
  ForkValue,
  RegistrySnapshot,
  RpcHandler,
  RpcInternalError,
  RpcResult,
} from './rpc.js'
export {
  REBASED_INTO_USAGE,
  executeRebasedIntoAction,
  parseRebasedIntoAction,
} from './rebased-into-command.js'
export type { RebasedIntoAction, RebasedIntoCommandDeps } from './rebased-into-command.js'
export { mergeRegion } from './merge-region.js'
export type {
  MergeRegion,
  MergeRegionError,
  MergeRegionResult,
  MergeRelation,
} from './merge-region.js'
export {
  SQUASH_USAGE,
  executeSquashAction,
  parseSquashAction,
} from './squash-command.js'
export type { SquashAction, SquashCommandDeps } from './squash-command.js'
export {
  SQUASH_HANDOFF_CAUSE,
  dispatchSquash,
  dispatchSquashAction,
  handoffReport,
  inboxPendingText,
  initiateSquashHandoff,
} from './squash-midturn.js'
export type {
  DetachedRunner,
  SquashHandoffAgent,
  SquashHandoffDeps,
} from './squash-midturn.js'
export { createDomainStore, dshForkDomainSpec } from './store.js'
export type { DomainLike } from './store.js'

export const name = 'dsh-session-fork'

/** Host services this plugin needs; the web-app bundle provides all. */
export const inject = [
  'commands',
  'storageDomain',
  'sessions',
  'sessionPersistence',
  'agents',
  'tokenMeter',
  'llm',
  'sessionController',
  'connection',
  'tools',
  'systemPrompt'
]

/**
 * Full log (header + events) of each view handed out by {@link makePorts},
 * retained so the seeded fork path can slice the real `SessionEvent`
 * objects and resolve the source's recorded preset. (The view itself only
 * promises `{ seq, type }` + cwd to keep boundary logic testable.)
 */
interface SourceLog {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

const sourceLogs = new WeakMap<SourceSessionView, SourceLog>()

/** Structural slice of `ctx.get('agentDefaultModel')` relied on. */
interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string }
}

/** Structural slice of `ctx.get('workspaceRegistry')` relied on. */
interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
}

/** Structural slice of `ctx.get('sessionQuery')` relied on. */
interface SessionQueryLike {
  traceSession(sessionId: string): Promise<{ ancestors: ReadonlyArray<{ header: { id: string } }> }>
}

/**
 * Structural slice of `ctx.sessionController` relied on: the official
 * `session.rename` command only. Calling it in-process drives the same
 * command object (and the same SessionTitleService behind it) as the web
 * GUI's rename dialog; a rejection surfaces as a `TypertRemoteFailure`
 * whose `.failure` carries the coded `{ code, message }` pair.
 */
interface SessionControllerLike {
  rename(request: {
    sessionId: Session['id']
    title: string
  }): Promise<{ title: string; seq: number }>
}

/**
 * Structural slice of `ctx.workspaceController` relied on: the official
 * `archiveSession` remote only. In-process, same gateway as the web GUI —
 * the session joins the registry-global archive set (hidden from every
 * grouping surface, log and workspace slot kept). Business codes:
 * `session-not-found` for a session neither live nor persisted; anything
 * else is an internal failure.
 */
interface WorkspaceControllerLike {
  archiveSession(request: {
    sessionId: Session['id']
  }): Promise<{ archivedSessionIds: readonly string[] }>
}

/**
 * The `rm` companion over the official archive handler: returns `'missing'`
 * for the `session-not-found` business rejection (the dangling-ref case —
 * nothing to archive, the ref alone goes) and `'archived'` otherwise; an
 * unmounted gateway or a non-business rejection raises
 * {@link BranchArchiveError} so the command layer aborts BEFORE the
 * registry write.
 */
function makeArchiveSession(ctx: Context): (sessionId: string) => Promise<ArchiveOutcome> {
  return async (sessionId) => {
    const controller = ctx.get('workspaceController') as WorkspaceControllerLike | undefined
    if (controller === undefined) {
      throw new BranchArchiveError(
        'the workspace controller is not mounted in this deployment',
      )
    }
    try {
      await controller.archiveSession({ sessionId: sessionId as Session['id'] })
    } catch (error) {
      const failure = (error as { failure?: { code?: string; message?: string } }).failure
      if (failure?.code === 'session-not-found') return 'missing'
      throw new BranchArchiveError(
        `session archive rejected: ${failure?.code ?? 'unknown'}: ${failure?.message ?? String(error)}`,
      )
    }
    return 'archived'
  }
}

/** Build the fork ports over live-first session reads. */
function makePorts(ctx: Context): BranchPorts {
  return {
    async readSession(sessionId) {
      const live = ctx.sessions.get(sessionId as Session['id'])
      if (live !== undefined) {
        const events = [...live.events]
        const view: SourceSessionView = {
          id: live.id,
          events,
          header: live.header.cwd === undefined ? {} : { cwd: live.header.cwd },
        }
        sourceLogs.set(view, { header: live.header, events })
        return view
      }
      // Cold path: persistence inspect, like api-proxy's readSessionState.
      // Any inspect failure (including not-found) reports as a missing
      // source; the command layer turns that into a clear user error.
      try {
        const inspected = await ctx.sessionPersistence.inspect(sessionId as Session['id'])
        const view: SourceSessionView = {
          id: inspected.meta.id,
          events: [...inspected.events],
          header: inspected.meta.cwd === undefined ? {} : { cwd: inspected.meta.cwd },
        }
        sourceLogs.set(view, { header: inspected.meta, events: inspected.events })
        return view
      } catch (error) {
        ctx.logger.debug(
          `dsh-session-fork: inspect of session "${sessionId}" failed: ${String(error)}`,
        )
        return null
      }
    },
    async createChildFromSeed(childId, source, cut, forkNotice) {
      const log = sourceLogs.get(source)
      if (log === undefined) {
        // Invariant: makePorts always pairs a view with its full log. A miss
        // means a port caller fabricated a view — slicing a fabricated seed
        // would silently fork from nothing.
        throw new Error(
          `dsh-session-fork invariant violation: no source log retained for session "${source.id}"`,
        )
      }
      const events = log.events
      // The vendored helpers from src/vendor/fork.ts mirror the host fork
      // handler's helper chain (forkWorkspace → composeAgent → agents.create
      // → workspace.attachSession); markers and upstream coordinates live
      // there. The host's installSelection is composed through agentOptions
      // here (the plugin seeds the default model selection the same way as
      // the host's entry points), so composeAgent receives a no-op installer
      // and mounting happens in setup exactly like upstream.
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
      // Resolve the target workspace BEFORE creating the child, like the
      // official path: creation is the point of no return, so everything
      // that can be settled up front is.
      const workspace = registry === undefined
        ? undefined
        : await forkWorkspace(
          {
            listWorkspaces: () => registry.list(),
            // Without the query service no ancestor lookup is possible;
            // an ungrouped child is preferable to a failed fork.
            traceSession: async id => query?.traceSession(id) ?? { ancestors: [] },
          },
          { id: source.id, header: log.header },
        )
      const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
      const forkComposition = await composeAgent(
        { presets, installSelection: () => { } },
        resolveSessionPreset(log),
      )
      // Seed the same default model selection the host's entry points use.
      // Issue #28: the fork notice rides the seed as its final event —
      // atomic with creation, at the inherit/own-history boundary — so
      // `seedLength` counts it in and any grandchild fork inherits it.
      const seed: SessionEvent[] = events.slice(0, cut)
      if (forkNotice !== undefined) {
        seed.push(forkSeedNoticeEvent(cut, Date.now(), forkNotice))
      }
      const defaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
      await ctx.agents.create({
        sessionId: childId as Session['id'],
        seed,
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.id as Session['id'],
          seedLength: seed.length,
          ...(forkComposition.agentPreset === undefined ? {} : { agentPreset: forkComposition.agentPreset }),
        },
        ...(defaultModel === undefined ? {} : { agentOptions: defaultModel.currentSelection() }),
        setup: forkComposition.setup,
      })
      // Attach failures are surfaced, not swallowed: an unattached child is
      // real but invisible in its workspace, which the user must hear about.
      await workspace?.attachSession(childId)
    },
    async renameSession(sessionId, title) {
      // The official rename command, in process. The registry gate has
      // already proved the official normalizer holds this title to
      // identity, so a rejection here is an internal anomaly — map it
      // onto BranchForkError so the command layer renders it like every
      // other branch-operation failure.
      const controller = ctx.get('sessionController') as SessionControllerLike | undefined
      if (controller === undefined) {
        throw new BranchForkError(
          'rename-failed',
          'the session controller is not mounted in this deployment',
        )
      }
      try {
        await controller.rename({ sessionId: sessionId as Session['id'], title })
      } catch (error) {
        const failure = (error as { failure?: { code?: string; message?: string } }).failure
        throw new BranchForkError(
          'rename-failed',
          `session rename rejected: ${failure?.code ?? 'unknown'}: ${failure?.message ?? String(error)}`,
        )
      }
    },
  }
}

/** Whether a session exists live or on disk. */
async function sessionExists(ctx: Context, sessionId: string): Promise<boolean> {
  if (ctx.sessions.get(sessionId as Session['id']) !== undefined) return true
  try {
    await ctx.sessionPersistence.inspect(sessionId as Session['id'])
    return true
  } catch {
    return false
  }
}

/**
 * Live-first workspace-key resolution (the session's `cwd`, `''` when
 * unset): the live session store answers first, persistence inspect is the
 * cold fallback, and a failed inspect means the session is missing
 * (`null`). Shared by the RPC read endpoints and the `fork` endpoint's
 * store selection.
 */
async function resolveWorkspaceKey(ctx: Context, sessionId: string): Promise<string | null> {
  const live = ctx.sessions.get(sessionId as Session['id'])
  if (live !== undefined) return live.header.cwd ?? ''
  try {
    const inspected = await ctx.sessionPersistence.inspect(sessionId as Session['id'])
    return inspected.meta.cwd ?? ''
  } catch {
    return null
  }
}

/**
 * The `/branch` command definition registered by {@link apply}.
 *
 * The `input` descriptor is load-bearing: the web client's admission
 * (ui-commands matchEnter) treats a registered command without one as
 * bare-only — `/branch main` would fall through to a normal message. With
 * a hint the command claims its leading arguments, and the handler receives
 * them through `invocation.rawInput`.
 */
export const branchCommandDefinition = {
  name: 'branch',
  description: 'Git-style conversation branches: create, list, rm, rename',
  input: { hint: '[<name> | create <name> | adopt <name> | list | rm <name> --yes | rename <old> <new>]' },
} as const

/**
 * The `/squash` command definition registered by {@link apply}. The
 * `input` hint is load-bearing for the same bare-command reason as above.
 */
export const squashCommandDefinition = {
  name: 'squash',
  description: 'Squash this branch back into its parent as one summary checkpoint',
  input: { hint: 'into <branch>' },
} as const

/**
 * The `/rebased` command definition registered by {@link apply}. The `input`
 * hint is load-bearing for the same bare-command reason as above: without it
 * the web client treats `/rebased into <branch>` as a plain message to the model.
 */
export const rebasedIntoCommandDefinition = {
  name: 'rebased',
  description: 'Transfer this branch\'s own conversation verbatim into any branch',
  input: { hint: 'into <branch>' },
} as const

/**
 * Register `/branch`, serve the GUI's custom RPC channel, and own the
 * storage-domain lifecycle — the same effect shape the command-compact
 * lifecycle uses. The yields run: command registration, RPC channel
 * registration, the in-flight command drain, the storage-domain close.
 * Cordis runs yielded disposers in reverse registration order (LIFO), so
 * the set tears down atomically with the plugin fiber.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(dshForkDomainSpec)
  const active = new Set<Promise<CommandResult>>()

  // Ambient branch identity (issue #28 phase 2): the sync read plane behind
  // the identity prompt section. Warmed once at plugin start so the FIRST
  // assembly of an already-registered session is correct; a warm failure is
  // a logged warning only — the section then degrades to no line until the
  // miss-triggered refresh succeeds.
  const identity = createBranchIdentity(domain as unknown as DomainLike)
  void identity.refresh().catch((error: unknown) => {
    ctx.logger.warn(`dsh-session-fork: branch identity warm-up failed: ${String(error)}`)
  })

  // Every registry store this plugin hands out, wrapped so each successful
  // save mirrors into the identity cache — one choke point for every
  // mutation path (command, GUI RPC, tools) keeps the prompt honest.
  const openStore = (workspaceKey: string) =>
    identityTrackingStore(
      createDomainStore(domain as unknown as DomainLike, workspaceKey),
      workspaceKey,
      identity,
    )

  // Track one detached mid-turn handoff continuation in the same in-flight
  // set the command operations retire from, so plugin disposal drains a
  // running compaction too (src/squash-midturn.ts lifetime contract).
  const trackDetached = (operation: Promise<void>): void => {
    const tracked = operation as unknown as Promise<CommandResult>
    active.add(tracked)
    const retire = (): void => { active.delete(tracked) }
    void operation.then(retire, retire)
  }

  // Structural read of the host connection registry (the web-app bundle
  // provides the connection service). When absent — a non-web host — the
  // /branch command family still works and only the RPC channel is skipped.
  const connection = ctx.get('connection') as ConnectionRpcLike | undefined

  ctx.effect(function* () {
    // Branch-event notice delivery (issues #28/#37): inject a one-line
    // notice into any session — the forked parent, the adopted session, or
    // the renamed branch's session — through the agreed transport,
    // `agent.inject()` (inbox next-step, NO wake): a busy target receives
    // it at its next step boundary; an idle target holds it durably until
    // its next turn. The agent resolves live-first, cold sources resume
    // through the vendored ensureSession kernel (resume, never create), and
    // the write is flushed but the agent never destroyed here. Never
    // throws: the branch change has already succeeded, a notification
    // failure is a logged warning only.
    const notifySession = async (sessionId: string, notice: UserMessage): Promise<void> => {
      try {
        const agent = await getOrResumeAgent(getOrResumeDeps(ctx), sessionId as Session['id'])
        agent.inject(notice)
        await ctx.sessions.flush(agent.session)
      } catch (error) {
        ctx.logger.warn(
          `dsh-session-fork: branch notice to session "${sessionId}" failed: ${String(error)}`,
        )
      }
    }
    // Shared `/branch` execution deps: one construction for the command
    // handler, the RPC create endpoint, and the tool surface (src/tools.ts).
    const commandDeps = (
      sessionId: string,
      workspaceKey: string,
    ): BranchCommandDeps => ({
      currentSessionId: sessionId,
      store: openStore(workspaceKey),
      ports: makePorts(ctx),
      sessionExists: (id: string) => sessionExists(ctx, id),
      archiveSession: makeArchiveSession(ctx),
      notifySession,
    })

    // Shared squash executor deps minus the per-call source/signal/commandId
    // (src/tools.ts BranchToolPorts.squashBase shape).
    const squashBase = (
      workspaceKey: string,
    ): Omit<SquashHandoffDeps, 'childAgent' | 'signal' | 'commandId'> => ({
      store: openStore(workspaceKey),
      compact: (agent, signal, request) =>
        compactNow({ meter: ctx.tokenMeter, llm: ctx.llm }, agent, signal, request),
      resolveTargetAgent: (sessionId) =>
        getOrResumeAgent(getOrResumeDeps(ctx), sessionId as Session['id']) as Promise<Agent>,
      flush: (agent) => ctx.sessions.flush(agent.session),
    })

    // Shared rebased-into executor deps minus the source agent
    // (src/tools.ts BranchToolPorts.rebasedBase shape).
    const rebasedBase = (
      workspaceKey: string,
    ): Omit<RebasedIntoCommandDeps, 'sourceAgent'> => ({
      store: openStore(workspaceKey),
      resolveTargetAgent: (sessionId) =>
        getOrResumeAgent(getOrResumeDeps(ctx), sessionId as Session['id']) as Promise<RebasedIntoAgent>,
      flush: (agent) => ctx.sessions.flush(agent.session),
    })

    yield ctx.commands.register({
      ...branchCommandDefinition,
      handler: (invocation: CommandInvocation): Promise<CommandResult> => {
        const workspaceKey = invocation.agent.session.header.cwd ?? ''
        const operation = Promise.resolve(
          executeBranchAction(
            parseBranchAction(invocation.rawInput),
            commandDeps(invocation.agent.session.id, workspaceKey),
          ),
        ) as Promise<CommandResult>
        active.add(operation)
        const retire = (): void => { active.delete(operation) }
        void operation.then(retire, retire)
        return operation
      },
    })

    if (connection !== undefined) {
      const rpcPorts: BranchRpcPorts = {
        // Live-first workspace resolution, the same order makePorts uses.
        resolveWorkspaceKey: (sessionId) => resolveWorkspaceKey(ctx, sessionId),
        // One domain record per workspace, exactly like the /branch path.
        async loadRegistry(workspaceKey) {
          return loadRegistry(openStore(workspaceKey))
        },
        // The `removeBranch` endpoint's write path: the same domain store
        // as the load above, so load-modify-save lands in one record.
        async saveRegistry(workspaceKey, state) {
          await saveRegistry(openStore(workspaceKey), state)
        },
        // Graph assembly reads whole logs: live store first, persistence
        // inspect as the cold fallback — the same order makePorts.readSession
        // uses, but returning the header lineage facts (seedLength /
        // parentSession) instead of a fork view.
        async readSession(sessionId) {
          const live = ctx.sessions.get(sessionId as Session['id'])
          if (live !== undefined) {
            return {
              header: {
                ...(live.header.seedLength === undefined ? {} : { seedLength: live.header.seedLength }),
                ...(live.header.parentSession === undefined
                  ? {}
                  : { parentSession: live.header.parentSession as string }),
              },
              events: [...live.events],
            }
          }
          try {
            const inspected = await ctx.sessionPersistence.inspect(sessionId as Session['id'])
            return {
              header: {
                ...(inspected.meta.seedLength === undefined ? {} : { seedLength: inspected.meta.seedLength }),
                ...(inspected.meta.parentSession === undefined
                  ? {}
                  : { parentSession: inspected.meta.parentSession as string }),
              },
              events: [...inspected.events],
            }
          } catch {
            return null
          }
        },
        sessionExists: (id) => sessionExists(ctx, id),
        archiveSession: makeArchiveSession(ctx),
        // The hijacked fork button's write path: the exact /branch create
        // pipeline, with the source session's workspace registry as the
        // authority. A missing source fails before any store selection.
        async createBranch({ name, sourceSessionId, atSeq }) {
          const workspaceKey = await resolveWorkspaceKey(ctx, sourceSessionId)
          if (workspaceKey === null) {
            throw new BranchForkError(
              'source-not-found',
              `no session named '${sourceSessionId}' exists`,
            )
          }
          return createNamedBranch(
            name,
            commandDeps(sourceSessionId, workspaceKey),
            atSeq === undefined ? {} : { atSeq },
          )
        },
        // The right-click squash action (issue #8): the same execution
        // capabilities the /squash command handler injects. Child-agent
        // resolution is live-first; a cold session resumes through the
        // vendored ensureSession kernel — resume, never create (2026-08-21
        // squash 定案), and the resumed agent is flushed after the write
        // but never destroyed here (it stays registered for later reads).
        squash: {
          async resolveChildAgent(sessionId) {
            const live = ctx.agents.get(sessionId as Session['id'])
            if (live !== undefined) return live as SquashChildAgent
            // `null` is reserved for a session that does not exist at all;
            // an existing-but-unresolvable session (a resume I/O failure,
            // for instance) propagates its real error instead of being
            // misreported as "no session exists" downstream.
            if (!(await sessionExists(ctx, sessionId))) return null
            return getOrResumeAgent(
              getOrResumeDeps(ctx), sessionId as Session['id'],
            ) as Promise<SquashChildAgent>
          },
          openStore,
          compact: (agent, signal, request) =>
            compactNow({ meter: ctx.tokenMeter, llm: ctx.llm }, agent, signal, request),
          resolveTargetAgent: (sessionId) =>
            getOrResumeAgent(getOrResumeDeps(ctx), sessionId as Session['id']) as Promise<Agent>,
          flush: (agent) => ctx.sessions.flush(agent.session),
          trackDetached,
        },
      }
      yield registerRpcChannel(connection, createBranchRpcHandler(rpcPorts))
    }

    // Track one detached mid-turn handoff continuation: see trackDetached
    // above.

    yield ctx.commands.register({
      ...squashCommandDefinition,
      handler: (invocation: CommandInvocation): Promise<CommandResult> => {
        const workspaceKey = invocation.agent.session.header.cwd ?? ''
        // Mid-turn sources (the agent still running its turn) take the
        // squash handoff: official turn cancellation, deferred idle
        // execution, follow-up report (src/squash-midturn.ts). The deps
        // carry the dispatching request's identity and cancellation.
        const squashDeps: SquashHandoffDeps = {
          childAgent: invocation.agent as SquashChildAgent,
          signal: invocation.signal,
          ...invocation.commandId === undefined ? {} : { commandId: invocation.commandId },
          ...squashBase(workspaceKey),
        }
        const operation = Promise.resolve(
          dispatchSquashAction(parseSquashAction(invocation.rawInput), squashDeps, trackDetached),
        ) as Promise<CommandResult>
        active.add(operation)
        const retire = (): void => { active.delete(operation) }
        void operation.then(retire, retire)
        return operation
      },
    })

    // /rebased into (issue #4, docs/design/rebased-into.md): verbatim transcript of this
    // branch's own conversation into an ARBITRARY target branch's inbox —
    // target resolution is the same vendored ensureSession kernel as squash
    // (resume, never create), but there is no busy gate and no compaction:
    // the transport is `agent.inject` (next-step, no wake), so a running
    // target claims the transcript at its nearest step boundary.
    yield ctx.commands.register({
      ...rebasedIntoCommandDefinition,
      handler: (invocation: CommandInvocation): Promise<CommandResult> => {
        const workspaceKey = invocation.agent.session.header.cwd ?? ''
        const operation = Promise.resolve(
          executeRebasedIntoAction(parseRebasedIntoAction(invocation.rawInput), {
            sourceAgent: invocation.agent as RebasedIntoAgent,
            ...rebasedBase(workspaceKey),
          }),
        ) as Promise<CommandResult>
        active.add(operation)
        const retire = (): void => { active.delete(operation) }
        void operation.then(retire, retire)
        return operation
      },
    })
    // The agent-facing tool surface (issue #5): the same executor cores the
    // three command handlers run, exposed to the model through the official
    // tools service. Registered host-wide — every session (main or future
    // subagent) sees the same branch vocabulary.
    const toolPorts: BranchToolPorts = {
      command: commandDeps,
      async branchSessionId(workspaceKey, name) {
        const state = await loadRegistry(openStore(workspaceKey))
        return state.branches[name]?.sessionId ?? null
      },
      // Live-first source resolution; cold sources resume through the
      // vendored kernel (resume, never create) — the RPC squash endpoint's
      // resolveChildAgent contract, generalized to plain agents.
      async resolveSourceAgent(sessionId) {
        const live = ctx.agents.get(sessionId as Session['id'])
        if (live !== undefined) return live
        if (!(await sessionExists(ctx, sessionId))) return null
        return getOrResumeAgent(getOrResumeDeps(ctx), sessionId as Session['id'])
      },
      squashBase,
      rebasedBase,
      trackDetached,
    }
    yield registerBranchTools((tool) => ctx.tools.register(tool), toolPorts)

    // The ambient branch worldview (issue #28): one static section in
    // every prompt assembly of this host. Registered as an effect so the
    // section disappears with the plugin fiber — same lifecycle contract
    // as the tool surface above.
    yield ctx.systemPrompt.section({
      name: BRANCH_VOCABULARY_SECTION,
      order: BRANCH_VOCABULARY_ORDER,
      text: BRANCH_VOCABULARY,
    })

    // The ambient identity line (issue #28 phase 2): which branch THIS
    // session is on, re-resolved at every assembly from the identity cache
    // (sync provider contract; refresh points in branch-identity.ts).
    // Empty text contributes nothing — a branch-less session (subagent,
    // un-adopted conversation) simply gets no line.
    yield ctx.systemPrompt.section({
      name: BRANCH_IDENTITY_SECTION,
      order: BRANCH_IDENTITY_ORDER,
      text: branchIdentityProvider(identity),
    })

    yield async () => { await Promise.allSettled(active) }
    yield async () => { await domain.close() }
  }, 'dsh-session-fork lifecycle')
}
