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
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
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
 * Full log events of each view handed out by {@link makePorts}, retained so
 * the seeded cold-fork path can slice the real `SessionEvent` objects.
 * (The view itself only promises `{ seq, type }` to keep boundary logic
 * testable.)
 */
const seedEvents = new WeakMap<SourceSessionView, readonly SessionEvent[]>()

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
        seedEvents.set(view, events)
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
        seedEvents.set(view, inspected.events)
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
      const events = seedEvents.get(source) ?? []
      await ctx.agents.create({
        sessionId: childId as Session['id'],
        seed: events.slice(0, cut),
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.id as Session['id'],
          seedLength: cut,
        },
      })
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
