/**
 * dsh-fork: git-style conversation branching for DeepSeek Harness.
 * @module dsh-fork
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
import type { BranchPorts, SourceSessionView } from './branch.js'
import { executeBranchAction, parseBranchAction } from './command.js'
import { createDomainStore, dshForkDomainSpec } from './store.js'
import type { DomainLike } from './store.js'

export type * from './types.js'
export {
  BranchRegistryError,
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
  forkBoundaryOf,
} from './branch.js'
export type {
  BranchPorts,
  CreateBranchOptions,
  SourceEvent,
  SourceSessionView,
} from './branch.js'
export {
  BRANCH_USAGE,
  executeBranchAction,
  parseBranchAction,
} from './command.js'
export type { BranchAction, BranchCommandResult } from './command.js'
export { createDomainStore, dshForkDomainSpec } from './store.js'
export type { DomainLike } from './store.js'

export const name = 'dsh-fork'

/** Host services this plugin needs; the web-app bundle provides all. */
export const inject = ['commands', 'storageDomain', 'sessions', 'sessionPersistence', 'agents']

/**
 * Full log (header + events) of each view handed out by {@link makePorts},
 * retained so the seeded cold-fork path can slice the real `SessionEvent`
 * objects and resolve the source's recorded preset. (The view itself only
 * promises `{ seq, type }` + cwd to keep boundary logic testable.)
 */
interface SourceLog {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

const sourceLogs = new WeakMap<SourceSessionView, SourceLog>()

/**
 * The preset a session actually runs, newest selection winning (upstream:
 * `resolveSessionPreset` from @deepseek-ai/dsh-agent-presets, mirrored here
 * so the plugin's runtime dependency set stays `zod`-only). The header
 * supplies the creation-time value; every later selection is a logged
 * `agent-preset/selected` event, so the last one is the answer.
 */
function resolveSessionPreset(log: SourceLog): string | undefined {
  for (let index = log.events.length - 1; index >= 0; index -= 1) {
    const event = log.events[index]
    // The preset-selection event is an open-vocabulary type dsh-session's
    // closed union does not name, hence the narrow structural cast.
    if (event !== undefined && (event.type as string) === 'agent-preset/selected') {
      return (event as unknown as { data: { agentPreset?: string } }).data.agentPreset
    }
  }
  return log.header.agentPreset
}

/** Structural slice of `ctx.get('agentPresets')` this plugin relies on. */
interface AgentPresetsLike {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** Structural slice of `ctx.get('workspaceRegistry')` workspaces relied on. */
interface WorkspaceLike {
  readonly id: string
  readonly sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<unknown>
}

/** Structural slice of `ctx.get('sessionQuery')` relied on. */
interface SessionQueryLike {
  traceSession(sessionId: string): Promise<{ ancestors: ReadonlyArray<{ header: { id: string } }> }>
}

/**
 * Resolve the Workspace a fork's child should join — api-proxy's
 * `forkWorkspace`: the source's direct Workspace, or for a subagent source
 * (not listed directly) the nearest owning ancestor. `undefined` when no
 * workspace registry is mounted or nothing owns the lineage.
 */
async function forkWorkspaceOf(
  ctx: Context,
  source: SourceSessionView,
  log: SourceLog | undefined,
): Promise<WorkspaceLike | undefined> {
  const registry = ctx.get('workspaceRegistry') as
    | { list(): WorkspaceLike[] }
    | undefined
  if (registry === undefined) return undefined
  const workspaces = registry.list()
  const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
  if (direct !== undefined || log?.header.origin !== 'subagent') return direct
  const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
  if (query === undefined) return undefined
  const lineage = await query.traceSession(source.id)
  for (const ancestor of lineage.ancestors) {
    const workspace = workspaces.find(candidate =>
      candidate.sessionIds.includes(ancestor.header.id),
    )
    if (workspace !== undefined) return workspace
  }
  return undefined
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
          `dsh-fork: inspect of session "${sessionId}" failed: ${String(error)}`,
        )
        return null
      }
    },
    forkLive(sourceId, boundarySeq, childId) {
      // Only the kernel store can fork a live source; anything else falls
      // through to the seeded creation path.
      if (ctx.sessions.get(sourceId as Session['id']) === undefined) return false
      ctx.sessions.fork(sourceId as Session['id'], boundarySeq, childId as Session['id'])
      return true
    },
    async createChildFromSeed(childId, source, cut) {
      const log = sourceLogs.get(source)
      const events = log?.events ?? []
      // Mirror api-proxy's session.fork composition: the child inherits the
      // source's recorded preset (its seeded history was produced under that
      // composition) and joins the source's workspace. Without the preset the
      // child would carry tool calls it can no longer compose.
      const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
      const presetId = log === undefined ? undefined : resolveSessionPreset(log)
      let agentPreset: string | undefined
      let setup: ((agentCtx: Context) => Promise<void>) | undefined
      if (presets !== undefined && presetId !== undefined) {
        agentPreset = (await presets.resolve(presetId)).id
        const resolvedId = agentPreset
        setup = async (agentCtx: Context) => {
          await presets.mount(agentCtx, resolvedId)
        }
      }
      // Seed the same default model selection the host's entry points use.
      const defaultModel = ctx.get('agentDefaultModel') as
        | { currentSelection(): { provider: string; model: string } }
        | undefined
      await ctx.agents.create({
        sessionId: childId as Session['id'],
        seed: events.slice(0, cut),
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.id as Session['id'],
          seedLength: cut,
          ...(agentPreset === undefined ? {} : { agentPreset }),
        },
        ...(defaultModel === undefined ? {} : { agentOptions: defaultModel.currentSelection() }),
        ...(setup === undefined ? {} : { setup }),
      })
      // Best-effort workspace attach, like api-proxy: the child is already
      // published, an attach failure must not lose it.
      try {
        const workspace = await forkWorkspaceOf(ctx, source, log)
        await workspace?.attachSession(childId)
      } catch (error) {
        ctx.logger.warn(
          `dsh-fork: forked session "${childId}" could not attach to its workspace: ${String(error)}`,
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
 * Register `/branch` and own the storage-domain lifecycle. Follows the
 * command-compact lifecycle shape: the registration disposer runs first and
 * the in-flight drain last (composite teardown is LIFO), so a drained
 * handler set cannot receive new invocations afterwards.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(dshForkDomainSpec)
  const active = new Set<Promise<CommandResult>>()

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'branch',
      description: 'Git-style conversation branches: create, list, rm, rename',
      handler: (invocation: CommandInvocation): Promise<CommandResult> => {
        const workspaceKey = invocation.agent.session.header.cwd ?? ''
        const operation = Promise.resolve(
          executeBranchAction(parseBranchAction(invocation.rawInput), {
            currentSessionId: invocation.agent.session.id,
            store: createDomainStore(domain as unknown as DomainLike, workspaceKey),
            ports: makePorts(ctx),
            sessionExists: (id) => sessionExists(ctx, id),
          }),
        ) as Promise<CommandResult>
        active.add(operation)
        const retire = (): void => { active.delete(operation) }
        void operation.then(retire, retire)
        return operation
      },
    })
    yield async () => { await Promise.allSettled(active) }
    yield async () => { await domain.close() }
  }, 'dsh-fork lifecycle')
}
