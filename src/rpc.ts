/**
 * Host-side custom RPC channel for the branch-graph GUI tab.
 * @module dsh-session-fork/src/rpc
 *
 * dsh exposes a generic unary RPC transport per logical channel
 * (`HostConnectionRpc.handle(channel, handler, options)` in
 * packages/client/connection/src/rpc.ts of the harness checkout, wired
 * through the HTTP route in packages/client/connection/src/rpc-host.ts).
 * This plugin owns one channel, `/dsh-session-fork`, and serves a single
 * `registry` endpoint: the branch-registry snapshot of the workspace a
 * given session belongs to.
 *
 * The channel name complies with the host's CHANNEL_PATTERN
 * (`/^\/[A-Za-z0-9._~-]+$/`, rpc-host.ts) and is not the reserved `/api`.
 * Trust is `loopback`: only the browser served by this very host may call
 * the endpoint — the GUI tab is rendered by the same web app, and a plugin
 * channel should never be reachable from other origins.
 *
 * Every dsh touchpoint here is a *structural* declaration (no host package
 * import), mirroring the pattern already used for `ctx.get('workspaceRegistry')`
 * etc. in index.ts: `RpcResult`/`RpcHandler` are declared to be
 * shape-compatible with the host's
 * `RpcResult<T>` (packages/host/apiproxy/src/api/rpc.ts:110) and
 * `ConnectionRpcHandler` (packages/client/connection/src/rpc.ts), so the
 * handler stays unit-testable without cordis and the plugin keeps its
 * no-host-imports dependency policy.
 */

import { z } from 'zod'
import { branchErrorMessage } from './command.js'
import { assembleBranchGraph } from './graph.js'
import type { BranchGraph, BranchLike, GraphNode, GraphNodeRef, GraphSessionLog } from './graph.js'
import { listBranches } from './registry.js'
import type { ForkOrigin, RegistryState, SessionExists } from './types.js'

/** Channel path this plugin owns on the host connection registry. */
export const RPC_CHANNEL = '/dsh-session-fork'

/**
 * Error branch of {@link RpcResult} as emitted by this plugin.
 *
 * dsh's `RpcError` is a closed union of codes (the keys of
 * `RpcErrorDetailsMap`); a plugin has no business inventing codes, so every
 * business failure folds into `internal` with `details: {}` — the same shape
 * the host's `transportError` produces (api/rpc.ts). Declared structurally:
 * `{ code: 'internal' }` is assignable to the host's closed union member for
 * `internal`, keeping the whole result assignable to the host's
 * `RpcResult<unknown>`.
 */
export interface RpcInternalError {
  readonly code: 'internal'
  readonly message: string
  readonly details: Record<string, never>
}

/** Structural mirror of the host's `RpcResult<T>`: methods never throw business errors. */
export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcInternalError }

/** Structural mirror of the host's `ConnectionRpcHandler`. */
export type RpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>

/** Structural slice of the host's `ConnectionRpcHandlerOptions`. */
export interface RpcChannelOptions {
  readonly authority: 'trusted-host' | 'loopback'
}

/**
 * Structural slice of the host's `HostConnectionHandle`: the handle nests the
 * channel registry under `rpc` (`HostConnectionService` implements
 * `HostConnectionHandle` = `{ rpc: HostConnectionRpc }`, rpc-host.ts), so the
 * slice must too — a flat slice compiles but finds `handle` undefined on the
 * real service.
 */
export interface ConnectionRpcLike {
  readonly rpc: {
    handle(
      channel: string,
      handler: RpcHandler,
      options: RpcChannelOptions,
    ): () => Promise<void>
  }
}

/**
 * Register this plugin's channel through the host connection registry.
 *
 * Pure with respect to dsh: takes a structural handle, hardcodes the channel
 * name and loopback trust, and returns the disposer produced by `handle`
 * (removing the channel and its physical route) for the caller's effect
 * layer to yield.
 */
export function registerRpcChannel(
  connection: ConnectionRpcLike,
  handler: RpcHandler,
): () => Promise<void> {
  return connection.rpc.handle(RPC_CHANNEL, handler, { authority: 'loopback' })
}

/** One branch as served by the `registry` endpoint: record fields + liveness flag. */
export interface BranchSnapshot {
  readonly name: string
  readonly sessionId: string
  readonly forkOrigin: ForkOrigin | null
  readonly createdAt?: string
  readonly dangling: boolean
}

/** Success value of the `registry` endpoint. */
export interface RegistrySnapshot {
  readonly branches: readonly BranchSnapshot[]
}

export type { BranchGraph, GraphNode, GraphNodeRef, GraphSessionLog }

/** Payload contract shared by the read endpoints. */
const registryPayloadSchema = z.object({
  sessionId: z.string().min(1),
})

/**
 * Payload contract of the `fork` endpoint (the hijacked official fork
 * button's wire shape): which session, optional in-log turn anchor, and
 * the mandatory branch name the dialog collected.
 */
const forkPayloadSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string(),
  atSeq: z.number().int().nonnegative().optional(),
})

/** Success value of the `fork` endpoint: the created child session id. */
export interface ForkValue {
  readonly sessionId: string
}

/**
 * Capabilities the RPC handler needs. Production wires live ctx reads in
 * index.ts (live-first cwd resolution, domain-store-backed registry loads,
 * and the shared session liveness check); tests inject in-memory fakes.
 */
export interface BranchRpcPorts {
  /**
   * Resolve the workspace key (the session's `cwd`, `''` when unset) of a
   * session — live session store first, persistence inspect as fallback.
   * `null` when the session does not exist at all.
   */
  resolveWorkspaceKey(sessionId: string): Promise<string | null>
  /** Load the branch registry of one workspace key (never-written → empty state). */
  loadRegistry(workspaceKey: string): Promise<RegistryState>
  /**
   * Read one session's log (header lineage facts + events) for graph
   * assembly — live session store first, persistence inspect as fallback.
   * `null` when the session does not exist (its branch degrades by omission).
   */
  readSession(sessionId: string): Promise<GraphSessionLog | null>
  /** Liveness check used for dangling marking. */
  readonly sessionExists: SessionExists
  /**
   * Create a named branch fork — the `/branch create` pipeline
   * ({@link createNamedBranch}) with the source session's workspace
   * registry as the authority. Serves the `fork` endpoint the hijacked
   * official fork button calls.
   * @throws with a user-facing message (see `branchErrorMessage`) on an
   *   invalid/duplicate name (before any fork side effect), a missing
   *   source session, or a fork/rename failure.
   */
  createBranch(request: {
    readonly name: string
    readonly sourceSessionId: string
    readonly atSeq?: number
  }): Promise<ForkValue>
}

/**
 * Build the channel handler. Cordis-free: everything dsh-shaped arrives
 * through {@link BranchRpcPorts}. Endpoints:
 *
 * - `registry` — payload `{ sessionId }`; resolves the session's workspace
 *   key, loads that workspace's registry, and returns
 *   `{ branches: [{ name, sessionId, forkOrigin, createdAt, dangling }] }`
 *   (sorted by name, dangling refs marked through `sessionExists`).
 * - `graph` — payload `{ sessionId }`; assembles the workspace's branch
 *   graph ({@link BranchGraph}: newest-first turn nodes with lineage and
 *   branch-name refs, plus the payload session's head node id) from the
 *   registry plus the branch sessions' logs.
 * - `fork` — payload `{ sessionId, name, atSeq? }`; runs the full
 *   `/branch create` pipeline host-side (name gate against the registry
 *   BEFORE forking, official agent-path fork, official rename, record
 *   write) and returns `{ sessionId }` of the created child. Serves the
 *   hijacked official fork button.
 *
 * Anything else — unknown endpoints, malformed payloads, missing sessions,
 * thrown port failures — folds into `{ ok: false, error: { code: 'internal',
 * message, details: {} } }`. A handler must never throw: the host would turn
 * a thrown error into an opaque HTTP 500 instead of a business result.
 */
export function createBranchRpcHandler(ports: BranchRpcPorts): RpcHandler {
  return async (endpoint, payload) => {
    if (endpoint === 'fork') {
      // The write endpoint: the hijacked fork button's single round trip.
      // Everything that can reject a bad request (payload shape, name
      // validity/uniqueness, source existence) happens before any fork
      // side effect, and every failure renders through the shared
      // command-layer message mapping so dialog and /branch read alike.
      try {
        const parsed = forkPayloadSchema.safeParse(payload)
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')
          return internalError(`invalid "fork" payload: ${issues}`)
        }
        const value = await ports.createBranch({
          name: parsed.data.name,
          sourceSessionId: parsed.data.sessionId,
          ...(parsed.data.atSeq === undefined ? {} : { atSeq: parsed.data.atSeq }),
        })
        return { ok: true, value }
      } catch (error) {
        return internalError(branchErrorMessage(error))
      }
    }
    if (endpoint !== 'registry' && endpoint !== 'graph') {
      return internalError(
        `unknown endpoint ${JSON.stringify(endpoint)} on channel ${JSON.stringify(RPC_CHANNEL)}`,
      )
    }
    try {
      const parsed = registryPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')
        return internalError(`invalid "${endpoint}" payload: ${issues}`)
      }
      const workspaceKey = await ports.resolveWorkspaceKey(parsed.data.sessionId)
      if (workspaceKey === null) {
        return internalError(`no session named ${JSON.stringify(parsed.data.sessionId)} exists`)
      }
      const state = await ports.loadRegistry(workspaceKey)
      if (endpoint === 'graph') {
        const branches: BranchLike[] = Object.values(state.branches).map(record => ({
          name: record.name,
          sessionId: record.sessionId,
          forkOrigin: record.forkOrigin === null ? null : { ...record.forkOrigin },
        }))
        const value: BranchGraph = await assembleBranchGraph(
          branches,
          parsed.data.sessionId,
          ports.readSession,
        )
        return { ok: true, value }
      }
      const listings = await listBranches(state, ports.sessionExists)
      const value: RegistrySnapshot = {
        branches: listings.map(({ record, dangling }) => ({
          name: record.name,
          sessionId: record.sessionId,
          forkOrigin: record.forkOrigin === null ? null : { ...record.forkOrigin },
          ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
          dangling,
        })),
      }
      return { ok: true, value }
    } catch (error) {
      return internalError(error)
    }
  }
}

/** Fold any failure into the host's `transportError` shape for the closed `internal` code. */
function internalError(error: unknown): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}
