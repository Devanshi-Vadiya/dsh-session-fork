/**
 * VENDORED FROM: deepseek-harness@99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
 * (copied 2026-08-21)
 *
 * - packages/host/apiproxy/src/api-proxy.ts:2303-2398 — the `session.fork`
 *   RPC handler: readSessionState, anchoredBoundary + cut-tail extension,
 *   forkWorkspace, composeAgent, agents.create, workspace.attachSession.
 * - packages/host/apiproxy/src/api-proxy.ts:1481-1492 — `forkWorkspace`
 *   helper (direct workspace, else nearest owning ancestor for a subagent
 *   source).
 * - packages/host/apiproxy/src/api-proxy.ts:1196-1217 — `composeAgent`
 *   helper (resolve the preset before creation; mount it in setup).
 *
 * The handler's `resolveSessionPreset` helper is deliberately NOT vendored:
 * it is publicly exported by @deepseek-ai/dsh-agent-presets and imported
 * directly (optional peer dependency) — direct import beats copying.
 *
 * Vendor policy (dsh-fork vendor-replication standard): every deviation
 * from upstream carries exactly one marker —
 * - `[fork:adapt]`   mechanical adaptation, no semantic change (injected
 *   dependencies instead of closure capture, structural type slices, type
 *   import paths, plain Result returns instead of RPC envelopes);
 * - `[fork:surgery]` a semantic operation, with its reason inline.
 * `tests/vendor.test.ts` pins the marker counts.
 * @module dsh-fork/src/vendor/fork
 */

import type { SourceEvent } from '../branch.js'

/**
 * The event fields the vendored fork helpers need beyond `{ seq, type }`:
 * command lifecycle pairing lives in event data.
 */
// [fork:adapt] upstream reads the closed `SessionEvent` union; the vendor
// copy stays decoupled from dsh-session by reading these fields
// structurally (absent data = not that event kind).
export interface VendoredSourceEvent extends SourceEvent {
  readonly data?: unknown
}

/** Header fields the vendored helpers consume. */
export interface VendoredSourceHeader {
  readonly cwd?: string
  readonly origin?: string
  readonly agentPreset?: string
}

// ---------------------------------------------------------------------------
// composeAgent — packages/host/apiproxy/src/api-proxy.ts:1196-1217
// ---------------------------------------------------------------------------

/** Structural slice of `ctx.get('agentPresets')` relied on. */
export interface AgentPresetsLike {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: unknown, id?: string): Promise<unknown>
}

/** The composition an `agents.create` call inherits. */
export interface AgentComposition {
  readonly agentPreset?: string
  readonly setup: (agentCtx: unknown) => Promise<void>
}

/** Dependencies `composeAgent` closes over upstream. */
export interface ComposeAgentDeps {
  /** `ctx.get('agentPresets')`, or `undefined` with no preset roster. */
  readonly presets: AgentPresetsLike | undefined
  /** Upstream `installSelection`: composes the default model selection. */
  readonly installSelection: (agentCtx: unknown) => void
}

/**
 * Resolve the preset an agent will be composed from, and the setup that
 * installs it.
 *
 * The id is resolved BEFORE the session exists because the session boundary
 * snapshots `meta` before asynchronous setup begins — a preset discovered
 * during setup could never reach the header. Mounting still happens in
 * setup, where a failure rolls the whole creation back rather than leaving a
 * published session whose capabilities are half-installed.
 *
 * A deployment with no preset roster composes nothing and every session
 * shares the host composition, which is the behavior before presets existed.
 * @param deps - injected closure environment.
 * @param presetId - the requested preset, or `undefined` for the default.
 * @returns the id to record on the header (absent without a roster) and the setup callback.
 * @throws when the roster supplies no such preset.
 */
export async function composeAgent(
  deps: ComposeAgentDeps,
  presetId: string | undefined,
): Promise<AgentComposition> {
  // [fork:adapt] upstream closes over `ctx.get('agentPresets')` and
  // `installSelection`; the vendor copy receives them as dependencies.
  const presets = deps.presets
  if (presets === undefined) {
    return {
      setup: (agentCtx) => {
        deps.installSelection(agentCtx)
        return Promise.resolve()
      },
    }
  }
  const resolvedId = (await presets.resolve(presetId)).id
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx) => {
      deps.installSelection(agentCtx)
      await presets.mount(agentCtx, resolvedId)
    },
  }
}

// ---------------------------------------------------------------------------
// forkWorkspace — packages/host/apiproxy/src/api-proxy.ts:1481-1492
// ---------------------------------------------------------------------------

/** Structural slice of `ctx.get('workspaceRegistry')` workspaces relied on. */
export interface WorkspaceLike {
  readonly id: string
  readonly sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<unknown>
}

/** Structural slice of `ctx.get('sessionQuery')` relied on. */
export interface SessionQueryLike {
  traceSession(sessionId: string): Promise<{ ancestors: ReadonlyArray<{ header: { id: string } }> }>
}

/** Dependencies `forkWorkspace` closes over upstream. */
export interface ForkWorkspaceDeps {
  listWorkspaces(): WorkspaceLike[]
  traceSession(sessionId: string): Promise<{ ancestors: ReadonlyArray<{ header: { id: string } }> }>
}

/**
 * Resolve the Workspace inherited by a fork without making ordinary loose
 * lineage grouped.
 */
// [fork:adapt] upstream reads `ctx.workspaceRegistry.list()` /
// `ctx.sessionQuery.traceSession()`; the vendor copy receives a structural
// `deps` slice, and the source is the vendor header shape instead of
// `Pick<Session, 'id' | 'header'>`.
export async function forkWorkspace(
  deps: ForkWorkspaceDeps,
  source: { id: string; header: VendoredSourceHeader },
): Promise<WorkspaceLike | undefined> {
  const workspaces = deps.listWorkspaces()
  const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
  if (direct !== undefined || source.header.origin !== 'subagent') return direct

  const lineage = await deps.traceSession(source.id)
  for (const ancestor of lineage.ancestors) {
    const workspace = workspaces.find(candidate =>
      candidate.sessionIds.includes(ancestor.header.id),
    )
    if (workspace !== undefined) return workspace
  }
  return undefined
}

// ---------------------------------------------------------------------------
// anchoredBoundary + cut extension — packages/host/apiproxy/src/api-proxy.ts:2318-2344
// (the inlined boundary half of the session.fork handler)
// ---------------------------------------------------------------------------

/** Result of {@link anchoredBoundaryOf}: the anchoring turn end and the seed cut. */
export interface AnchoredBoundary {
  /** Seq of the anchoring `turn/end` event. */
  readonly boundarySeq: number
  /** Exclusive end of the seed slice (index into the event array). */
  readonly cut: number
}

/**
 * Locate the fork boundary and seed cut in a source log, replicating the
 * api-proxy `session.fork` anchor semantics:
 *
 * - With `atSeq`: the first `turn/end` at or after that seq (an in-log
 *   anchor belongs to its whole turn). `null` means the containing turn has
 *   not completed yet.
 * - Without `atSeq` (or past the last event): the last completed `turn/end`;
 *   `null` means the session has no completed turn to fork from.
 *
 * The returned `cut` additionally extends through trailing standalone events
 * (`session/title`, injections) up to the next `turn/start`, so the seed
 * stays balanced.
 *
 * @returns `null` when no completed turn anchors the fork.
 */
export function anchoredBoundaryOf(
  events: readonly VendoredSourceEvent[],
  atSeq?: number,
): AnchoredBoundary | null {
  // An in-log anchor belongs to the turn containing it and must never clip
  // backward to an earlier completed turn. Omitted and past-end anchors
  // retain the last-completed-turn shortcut.
  const lastSeq = events.at(-1)?.seq ?? -1
  const anchoredBoundary = atSeq === undefined
    ? undefined
    : events.find(e => e.type === 'turn/end' && e.seq >= atSeq)
  const boundary = anchoredBoundary
    ?? (atSeq === undefined || atSeq > lastSeq
      ? events.findLast(e => e.type === 'turn/end')
      : undefined)
  if (boundary === undefined) return null
  // Extend the cut through trailing out-of-band appends (session/title,
  // injections) up to the next turn/start: they are standalone events, so
  // the seed stays balanced, and the child inherits a title generated right
  // after the boundary turn.
  let cut = boundary.seq + 1
  while (cut < events.length && events[cut]?.type !== 'turn/start') cut++
  // [fork:surgery] seed-balance invariant. Upstream the fork handler runs
  // between turns (web GUI button, RPC from an idle client), so any
  // `command/run` in the sliced log already has its `command/done`. Our
  // entry point runs INSIDE a command handler: the host appends
  // `command/run` before invoking the handler and `command/done` only after
  // it returns, so at slicing time the tail legitimately contains an
  // unpaired `command/run`. Seeding it would give the child an orphan run,
  // which the client renders as a command still executing forever (a run
  // without done is "in flight" in conversation rendering). Therefore: if
  // the seed slice contains a `command/run` whose `commandId` has no
  // matching `command/done`, back the cut up to before the earliest such
  // orphan. (Orphans can only trail the anchoring turn/end — a completed
  // turn pairs all runs inside it — so in practice this trims the tail
  // extension, never completed turns.)
  const pairedDone = new Set(
    events
      .slice(0, cut)
      .filter(e => e.type === 'command/done')
      .map(e => (e.data as { commandId?: string } | undefined)?.commandId),
  )
  for (let index = 0; index < cut; index += 1) {
    const event = events[index]
    if (event?.type === 'command/run') {
      const commandId = (event.data as { commandId?: string } | undefined)?.commandId
      if (commandId !== undefined && !pairedDone.has(commandId)) {
        cut = index
        break
      }
    }
  }
  return { boundarySeq: boundary.seq, cut }
}
