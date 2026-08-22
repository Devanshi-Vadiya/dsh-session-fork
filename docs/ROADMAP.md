# ROADMAP — dsh-session-fork

Git-style conversation branching for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

This file is the source of truth for **scope and milestone boundaries**. Per-feature
acceptance criteria live on the GitHub issues (Context / Proposal / Acceptance); this
roadmap links to them instead of duplicating.

## Vision

Agent apps manage conversations as sessions: chats are silos, and memory doesn't
carry over. Once a conversation grows long, you're left with two bad choices —
start a new session: the project context and working memory are lost; keep
chatting: the context gets polluted. dsh already forks sessions *anonymously* —
this plugin makes the branch the building block of AI conversation management:

> **Branches are named refs pointing at sessions.** Forking creates a child branch;
> a branch's unique turns and conclusions are squashed back into the parent as a
> compact summary.

### Git → dsh mapping

| Git | dsh-session-fork |
|---|---|
| commit | session event (append-only log) |
| commit chain | one session log |
| parent pointer | session header `parentSession` + `seedLength` (persisted by dsh) |
| branch | named entry in the branch registry → session id |
| fork | dsh `fork` at a turn boundary |
| `merge --squash` | compact the child's post-fork region, append summary to the parent |
| merge / rebase / tag | v0.1.0+ (see milestones) |

### Non-goals

- No true two-parent merge (session logs are single-chain; merges are modeled as
  merge events, not log grafting).
- No mid-turn forking (dsh restricts fork boundaries to turn ends).
- No changes to dsh core — everything ships as a plugin.

## Status

Shipped (tags on `main`):

| Release | Scope | Issues / PRs |
|---|---|---|
| v0.0.1 | Branch registry: `/branch` command family, per-workspace persistent refs, dangling policy | #9 |
| v0.0.2 | Branch tab GUI: vendored VS Code graph, fork origins, lane rendering | #1 (PR #9) |
| v0.0.2+ | Graph interactions: hover tooltip, right-click fork-from-here & squash-into-branch | #8 (PR #14, #13) |
| v0.0.3 | `/squash into` via vendored compaction engine | #2 (PR #10) |
| v0.0.4 | GUI fork button wired onto the branch pipeline | #3 (PR #11) |

Post-v0.0.4 fixes: dual-face build chain (PR #12), squash merge-join rendering
(PR #18), click-expansion taken offline pending trajectory-fold alignment (PR #19).

## Milestones

Versions are decided at release time; milestone = sprint. Patch releases have no
milestone of their own.

### v0.1.0 — Enhanced features (first publishable minor)

Inter-branch options plus release chores. Closes when the plugin is npm-installable.

- merge & rebase between branches — #4 (design note required before implementation)
- squash between any two branches — #21, with TOOL-message research #22
- remove branch from the GUI — #23
- README #16 and npm pack #17

### v0.2.0 — Sub agents in parallel

The core-creativity milestone: agents become branches.

- agents create branches backed by sub agents — #5
- parallel sub agents communicating via `{merge, rebase, squash}` — #6

### v0.3.0 — Branch-scoped memory (placeholder)

Memory isolated per branch, against flat cross-project/cross-branch pollution.
Needs its own design note before scope is locked.

### v1.0.0 — Long-term enhancement

- trajectory-aligned turn expansion — #15
- official-style naming prompt — #20

## Engineering notes (cross-cutting)

- **Vendor discipline:** replicated dsh code lives in separate vendor files with a
  `VENDORED FROM` header (upstream SHA + file:line); changes use `[fork:adapt]`
  (mechanical) / `[fork:surgery]` (semantic, with reason) markers, pinned by tests.
- **Coordinates:** fork anchors are log seqs; compaction ranges are surface
  positions. All conversions live in one tested helper.
- **Boundaries:** every fork/squash boundary is a closed turn end; open turns are
  never touched — wait for idle instead.
- **Packaging:** npm package or local `file:` dependency only; git dependencies
  conflict with the profile's pnpm `onlyBuiltDependencies` whitelist.
- **Testing:** acceptance items map 1:1 to test cases; every milestone ships replay
  tests (seed → rebuild → compare).

## History

Design-phase research is archived in Mnemon documents (`dsh-fork-fbe60543`,
`ca95142e`, `87f88aa7`); source-level evidence lives there, not here. Vendored
against deepseek-harness@`528c682e`.
