/**
 * Host-side branch-graph assembly: registry records + session logs in, a
 * vscode-SCM-history-shaped node list out.
 * @module dsh-session-fork/src/graph
 *
 * The 'graph' RPC endpoint (src/rpc.ts) feeds one workspace's branch
 * registry and the sessions it references through {@link assembleBranchGraph};
 * the browser tab (P1's vendored renderer) maps the nodes onto
 * `ISCMHistoryItem` rows. Everything here is pure over injected reads, so
 * tests run without cordis.
 *
 * Event vocabulary relied on (node_modules/@deepseek-ai/dsh-session
 * lib/types/types.d.ts @ 0.1.0-rc.7, `SessionEventMap`):
 * - `turn/start` `{ turn: number }` opens a turn; `turn/end` `{ turn, reason }`
 *   closes it. `data.turn` is the durable turn handle used in node ids.
 * - `user/message` carries a `UserMessage` (`{ role, content, source }`);
 *   `content` blocks of `type: 'text'` carry the prompt text, and
 *   `source.kind === 'user'` marks a direct human prompt (vs synthetic
 *   injections with `source.kind === 'plugin'`), per the dsh-llm
 *   `MessageSourceMap`.
 * - Fork lineage: a seeded child's log starts with the parent's prefix, so
 *   `header.seedLength` splits inherited events from the child's own work,
 *   and `header.parentSession` names the seed source (SessionHeader).
 */

/** Structural slice of one session event the graph consumes. */
export interface GraphEvent {
  readonly seq: number
  readonly type: string
  readonly time?: number
  readonly data?: unknown
}

/** Header facts a forked child carries; absent on root sessions. */
export interface GraphSessionHeader {
  /** Leading events inherited from {@link parentSession} through a seed. */
  readonly seedLength?: number
  /** Session the seed was taken from. */
  readonly parentSession?: string
}

/** One session's log as the graph needs it. */
export interface GraphSessionLog {
  readonly header: GraphSessionHeader
  readonly events: readonly GraphEvent[]
}

/** One extracted turn of one session. */
export interface TurnSlice {
  /** `data.turn` of the `turn/start`/`turn/end` pair. */
  readonly turn: number
  /** Seq of the `turn/start` event (log coordinates). */
  readonly startSeq: number
  /** Seq of the `turn/end` event; null while the turn is still open. */
  readonly endSeq: number | null
  /** `time` of the `turn/start` event, when recorded. */
  readonly startTime?: number
  /** First human prompt text in the turn; '' when the turn has none. */
  readonly subject: string
}

/** Text of one user message: its text blocks joined and trimmed. */
function userMessageText(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const content = (data as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const text = content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join(' ')
    .trim()
  return text
}

/** Whether a user message came from a direct human prompt. */
function isHumanPrompt(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false
  return (data as { source?: { kind?: unknown } }).source?.kind === 'user'
}

interface OpenTurn {
  readonly turn: number
  readonly startSeq: number
  readonly startTime?: number
  endSeq: number | null
  /** First human-prompt subject found in the turn, '' when none yet. */
  subject: string
  /** Any user message seen (human or synthetic), used as subject fallback. */
  fallbackSubject: string
}

/**
 * Extract the turns of one session log in log order.
 *
 * Only events at `seq >= fromSeq` are considered; production passes the
 * session's `header.seedLength` so a forked child contributes exactly its
 * own turns (the inherited parent prefix appears through the parent's own
 * branch). A turn without any user message yields `subject: ''`.
 */
export function extractTurns(events: readonly GraphEvent[], fromSeq = 0): TurnSlice[] {
  const turns: TurnSlice[] = []
  let open: OpenTurn | null = null
  for (const event of events) {
    if (event.seq < fromSeq) continue
    const data = event.data
    switch (event.type) {
      case 'turn/start': {
        // Kernel turns are numeric; `turn: null` markers (e.g. idle
        // compaction brackets) are not rows.
        if (data !== null && typeof data === 'object'
          && typeof (data as { turn?: unknown }).turn === 'number') {
          open = {
            turn: (data as { turn: number }).turn,
            startSeq: event.seq,
            ...(event.time === undefined ? {} : { startTime: event.time }),
            endSeq: null,
            subject: '',
            fallbackSubject: '',
          }
        }
        break
      }
      case 'turn/end': {
        if (open !== null && data !== null && typeof data === 'object'
          && (data as { turn?: unknown }).turn === open.turn) {
          turns.push({
            turn: open.turn,
            startSeq: open.startSeq,
            endSeq: event.seq,
            ...(open.startTime === undefined ? {} : { startTime: open.startTime }),
            subject: open.subject !== '' ? open.subject : open.fallbackSubject,
          })
          open = null
        }
        break
      }
      case 'user/message': {
        if (open !== null) {
          const text = userMessageText(data)
          if (text !== '') {
            if (open.subject === '' && isHumanPrompt(data)) open.subject = text
            if (open.fallbackSubject === '') open.fallbackSubject = text
          }
        }
        break
      }
      default:
        break
    }
  }
  return turns
}

/** A branch-name ref displayed on a graph row (vscode `references`). */
export interface GraphNodeRef {
  readonly id: string
  readonly name: string
}

/** One graph row: a session's turn with its lineage. */
export interface GraphNode {
  /** `${sessionId}:${turn}` — globally unique across the workspace. */
  readonly id: string
  readonly parentIds: string[]
  /** The turn's user message (commit-message analogue). */
  readonly subject: string
  /** Branch names whose head lands on this node. */
  readonly refs?: readonly GraphNodeRef[]
}

/** The registry-facing slice of one branch record. */
export interface BranchLike {
  readonly name: string
  readonly sessionId: string
  readonly forkOrigin: { readonly parentSessionId: string; readonly atSeq: number } | null
}

/** The assembled graph served by the 'graph' endpoint. */
export interface BranchGraph {
  /** Rows newest-first (the order the vscode layout consumes). */
  readonly nodes: readonly GraphNode[]
  /** Node id of the payload session's latest own turn; null when it has none. */
  readonly head: string | null
}

const nodeId = (sessionId: string, turn: number): string => `${sessionId}:${turn}`

/** The turn of `log` whose span contains `seq` (a turn/end seq anchors it). */
function turnContaining(turns: readonly TurnSlice[], seq: number): TurnSlice | null {
  let found: TurnSlice | null = null
  for (const turn of turns) {
    if (turn.startSeq > seq) break
    found = turn
  }
  return found
}

/**
 * Resolve the fork anchor node id for a child whose record cites
 * `forkOrigin = { parentSessionId, atSeq }`.
 *
 * `atSeq` is a seq in the parent's log coordinates, and a seeded child's
 * log repeats the parent's prefix with identical seqs — so the coordinates
 * stay valid while walking. When the anchor turn falls inside the parent's
 * OWN region, the parent session owns the node. When it falls inside the
 * parent's own inherited seed, ownership walks up `header.parentSession`
 * (seq unchanged) until a session owns the turn or lineage runs out.
 */
async function resolveForkAnchor(
  forkOrigin: { readonly parentSessionId: string; readonly atSeq: number },
  readSession: (sessionId: string) => Promise<GraphSessionLog | null>,
  knownSessions: ReadonlySet<string>,
  depth: number,
): Promise<string | null> {
  let sessionId: string | undefined = forkOrigin.parentSessionId
  const seq = forkOrigin.atSeq
  // One step per ancestor session; the cap only guards pathological logs.
  for (let step = 0; step < depth && sessionId !== undefined; step++) {
    const log = await readSession(sessionId)
    if (log === null) return null
    const turns = extractTurns(log.events)
    const anchor = turnContaining(turns, seq)
    if (anchor === null) return null
    if (anchor.startSeq >= (log.header.seedLength ?? 0)) {
      // The anchor turn is this session's own work: it owns the node — but
      // it only appears in the graph when this session is a branch target.
      return knownSessions.has(sessionId) ? nodeId(sessionId, anchor.turn) : null
    }
    sessionId = log.header.parentSession
  }
  return null
}

/**
 * Assemble the workspace branch graph.
 *
 * - Node set: the own turns of every registry branch target session
 *   (create and adopt records are equal citizens).
 * - Lineage: turns chain naturally inside a session; a forked child's
 *   first own turn additionally parents to the fork anchor turn (the
 *   right-jump lane in the vscode renderer). Unreadable sessions and
 *   anchors that resolve outside the branch set degrade by omission.
 * - Rows carry the branch names whose head lands on them; `head` marks the
 *   payload session's latest own turn (the HEAD double ring).
 */
export async function assembleBranchGraph(
  branches: readonly BranchLike[],
  headSessionId: string,
  readSession: (sessionId: string) => Promise<GraphSessionLog | null>,
): Promise<BranchGraph> {
  const sessionIds = [...new Set(branches.map(branch => branch.sessionId))]
  const knownSessions = new Set(sessionIds)

  // Session logs and own turns (unreadable sessions skip gracefully).
  const logs = new Map<string, GraphSessionLog | null>()
  const ownTurns = new Map<string, TurnSlice[]>()
  for (const sessionId of sessionIds) {
    const log = await readSession(sessionId)
    logs.set(sessionId, log)
    ownTurns.set(sessionId, log === null ? [] : extractTurns(log.events, log.header.seedLength ?? 0))
  }

  // Fork anchor per session, taken from the first record citing one.
  const forkOriginOf = new Map<string, { parentSessionId: string; atSeq: number }>()
  for (const branch of branches) {
    if (branch.forkOrigin !== null && !forkOriginOf.has(branch.sessionId)) {
      forkOriginOf.set(branch.sessionId, branch.forkOrigin)
    }
  }

  const mutableNodes: Array<GraphNode & { parentIds: string[]; refs: GraphNodeRef[] }> = []
  const sortKeys = new Map<string, { time: number; sessionIndex: number; seq: number }>()
  for (const [sessionIndex, sessionId] of sessionIds.entries()) {
    const turns = ownTurns.get(sessionId) ?? []
    const forkOrigin = forkOriginOf.get(sessionId) ?? null
    const anchorId = forkOrigin === null ? null
      : await resolveForkAnchor(forkOrigin, readSession, knownSessions, sessionIds.length + 1)
    turns.forEach((turn, index) => {
      const previous = index > 0 ? turns[index - 1] : undefined
      const parentIds: string[] = []
      if (previous !== undefined) parentIds.push(nodeId(sessionId, previous.turn))
      if (index === 0 && anchorId !== null) parentIds.push(anchorId)
      const id = nodeId(sessionId, turn.turn)
      mutableNodes.push({ id, parentIds, subject: turn.subject, refs: [] })
      sortKeys.set(id, { time: turn.startTime ?? 0, sessionIndex, seq: turn.startSeq })
    })
  }

  // Branch-name refs land on each session's latest own turn (branch head).
  for (const branch of branches) {
    const turns = ownTurns.get(branch.sessionId) ?? []
    const last = turns.at(-1)
    if (last === undefined) continue
    const node = mutableNodes.find(candidate => candidate.id === nodeId(branch.sessionId, last.turn))
    node?.refs.push({ id: branch.name, name: branch.name })
  }

  // Newest-first row order: the vscode layout consumes git-log order. Turn
  // start time is the primary key; session then seq break ties so the order
  // stays deterministic without timestamps.
  const ordered = [...mutableNodes]
    .sort((left, right) => {
      const leftKey = sortKeys.get(left.id)!
      const rightKey = sortKeys.get(right.id)!
      if (leftKey.time !== rightKey.time) return rightKey.time - leftKey.time
      if (leftKey.sessionIndex !== rightKey.sessionIndex) return rightKey.sessionIndex - leftKey.sessionIndex
      return rightKey.seq - leftKey.seq
    })
    .map(node => (node.refs.length === 0
      ? { id: node.id, parentIds: node.parentIds, subject: node.subject }
      : { id: node.id, parentIds: node.parentIds, subject: node.subject, refs: node.refs }))

  const headTurns = ownTurns.get(headSessionId) ?? []
  const headLast = headTurns.at(-1)
  return {
    nodes: ordered,
    head: headLast === undefined ? null : nodeId(headSessionId, headLast.turn),
  }
}
