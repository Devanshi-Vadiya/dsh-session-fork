# ROADMAP — dsh-fork: Git-style conversation branching for DeepSeek Harness

Status: **planning** (no code yet) · Upstream: source checkout of dsh at `/Users/skd/Documents/deepseek-harness` · Delivery form: standalone dsh plugin package

This document is the single source of truth for scope, milestones, and acceptance
boundaries. Agents and humans should treat each milestone's **Acceptance** section as
the definition of done. Update this file (not chat history) whenever scope changes.

---

## 1. Problem & Vision

Long-running coding projects advance in phases. During review of a completed phase,
questions arise ("why is this code written this way?"). Two bad options exist today:

- **Open a new session** — loses all conversation context.
- **Ask inside the working session** — pollutes the context that later phases depend on.

dsh already supports *anonymous* session forking (kernel primitive
`ctx.sessions.fork()`, a Web GUI branch button, and persisted parent lineage). What is
missing is the **git layer on top**:

> **Branches are named refs pointing at sessions.** Forking creates a child branch;
> the child's conclusions are compressed and *squashed* back into the parent branch so
> later phases see a clean summary instead of the whole review.

### Git → dsh concept mapping

| Git concept | dsh-fork realization |
|---|---|
| commit | session event (immutable, append-only log) |
| commit chain | one session log |
| parent pointer | session header `parentSession` + `seedLength` (already persisted by dsh) |
| branch (ref) | named entry in the plugin's branch registry → session id |
| fork | dsh `fork` at a turn boundary (already exists) |
| `merge --squash` | compact the child's post-fork region, append summary into the parent |
| tag / rebase / true merge | later milestones |

### Non-goals (for now)

- No true two-parent merge (dsh session logs are single-chain; merges will be modeled
  as merge events, not log grafting).
- No mid-turn forking (dsh restricts fork boundaries to turn ends; accepted).
- No automatic interception of review-style questions (candidate for v0.1.0+, not core).
- No changes to dsh core — everything ships as a plugin.

---

## 2. Milestones

### v0.0.1 — Branch registry (ref layer)

**Goal:** named branches exist, persist across restarts, and never corrupt or crash.

Deliverables:

- Plugin package skeleton (cordis plugin; installs into the web profile).
- Branch registry storage (via `ctx.storage`; one JSON file per workspace).
  Record shape: `{ name, sessionId, forkOrigin: { parentSessionId, atSeq } | null }`.
  The root branch has `forkOrigin: null`.
- Slash commands: `/branch create <name>` (adopt current or forked session),
  `/branch fork <name>` (one-step named fork at the current turn end),
  `/branch list`, `/branch switch <name>` (open the referenced session).
- Dangling-ref policy: a branch whose session was deleted/archived is listed as
  dangling; deletion of the branch is explicit.

Acceptance:

1. Registry content survives a dsh restart.
2. Duplicate names, unknown branches, and dangling refs produce clear errors — no crashes.
3. `forkOrigin.atSeq` locates the exact fork message in the parent session.
4. Branches are scoped per workspace (cwd), matching dsh session storage scoping.
5. Host-side only; zero client-code changes in this milestone.

### v0.0.2 — Branch visibility (UI layer)

**Goal:** a human can see the branch tree and where each fork happened.

Deliverables:

- Spike (time-boxed, first): client-plugin packaging path — how plugin UI code reaches
  the Web GUI bundle, including rebuild/refresh workflow on a source checkout.
- Session list: branch name labels; child branches stay nested under their parent
  (dsh already nests by `parentSessionId`).
- Fork origin indicator: "forked from `<parent>` @ message N" (anchor from the
  registry; cross-checkable against the child session's seed boundary).
- Parent-side indicator: which branches were forked from the current session.

Acceptance:

1. Names, nesting, and fork origins render correctly after page reload and host restart.
2. Clicking a branch opens its session.
3. Dangling branches render distinctly (not hidden, not crashing).
4. All UI states degrade gracefully when the registry is missing or partial.

### v0.0.3 — Squash merge

**Goal:** merge a child branch's outcome back into the parent as a compact, durable
summary — the workhorse merge method.

Deliverables:

- `/squash into <branch>` command, run from the child branch.
- Pipeline: wait for the child agent to go idle → compact the child's **post-fork
  region** using the native compaction seam (`ctx.compaction.compactRegion`) → read
  the compacted child surface → append into the parent: one plugin merge event
  (log-only provenance: child id, anchor, compacted range) plus the summary
  checkpoint and conclusion messages.
- Parent-side write path: reuse the live agent if one exists in this process, else
  cold-resume it (`ctx.agents.resume`), append, flush; do not dispose afterward.
- Short-region fallback: if compaction is rejected (summary would not shrink),
  carry the original messages over verbatim and report "not compacted".

Acceptance:

1. Compaction covers exactly the post-fork region; the inherited prefix is untouched
   (verifiable by token counts before/after).
2. Parent context growth is bounded by the summary + conclusion, independent of child
   conversation length.
3. Squash succeeds when the child contains manually interrupted turns; the summary
   reflects the interruption honestly.
4. Squash succeeds when the parent is cold (host restarted) or live.
5. The parent log replays to a complete, valid request (model-visible means logged).
6. After squash, the child branch remains independently usable.

### v0.1.0+ — Ref hygiene & advanced merging (exploratory)

Candidate scope, deliberately unordered; each requires its own design note before work:

- Ref hygiene: move/rename/delete branch, dangling cleanup, optional fixed pointers
  (git-tag semantics).
- Auto-review routing: intercept review-style follow-ups at `agent/pre-step` and
  redirect them into a fork, so the main branch's model never sees the question.
- Rebase: replay a child onto a parent's advanced head; requires stale-prefix
  detection and a conflict-resolution policy.
- Eventized registry: record branch mutations as session events for full replay
  consistency (audit-grade).

---

## 3. Engineering notes (cross-cutting)

- **Packaging:** npm package (or local `file:` dependency) added to the web profile's
  `dependencies` + `dsh.profile.bundles`. Avoid git dependencies (known to conflict
  with the profile's pnpm `onlyBuiltDependencies` whitelist).
- **Coordinates discipline:** dsh has two coordinate systems — event `seq` (log) and
  surface position (model-visible projection). Fork anchors are seqs; compaction
  ranges are surface positions. All conversions live in one helper, unit-tested.
- **Boundary discipline:** every fork/squash boundary is a closed turn end. Any closed
  turn — including manually interrupted ones — is a valid, balanced anchor (dsh
  guarantees pairing via synthetic closers). Open turns are never touched; wait for
  idle instead.
- **Compatibility:** declare the dsh session-event vocabulary version the plugin is
  built against; fail with a clear diagnostic on mismatch.
- **Testing:** every milestone ships replay tests (seed → rebuild → compare) using
  dsh's existing test-support fixtures; acceptance items above map 1:1 to test cases.

---

## 4. Changelog

- 2026-08-19 — Initial roadmap from design phase (research notes archived separately
  in Mnemon document `dsh-fork-fbe60543`; source-level evidence lives there, not here).
