# dsh-fork

Git-style conversation branching for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). dsh already has an anonymous session-fork primitive; dsh-fork adds the *git layer* on top: **named branch refs pointing at sessions**. Forking creates a child branch; later milestones will squash a child's conclusions back into the parent so ongoing phases see a clean summary instead of a full review transcript. Scope, milestones, and acceptance boundaries live in [docs/ROADMAP.md](docs/ROADMAP.md).

## Features (v0.0.1 — ref layer)

- Named branches that persist across dsh restarts (storage-domain backed, one registry per workspace cwd).
- `/branch <name>` — fork the current session at its last completed turn and record the ref, including the exact fork anchor in the parent log. Cold (non-live) sources are forked too, with the same agent preset composition and workspace attachment the Web GUI's fork applies.
- `/branch adopt <name>` — adopt the current session as the workspace's root branch (no fork).
- `/branch list` — list this workspace's branches; refs whose session was deleted are marked `[dangling]`.
- `/branch rm <name> --yes` — remove a branch ref (session data is never deleted).
- `/branch rename <old> <new>` — rename a ref, with duplicate-name guards.
- Host-side only; zero GUI changes in this milestone.

## Install into a dsh profile

Requires the `web` (or another web-app-based) profile — the plugin needs the `storageDomain`, `sessions`, `sessionPersistence`, `agents`, and `commands` services.

```sh
dsh plugin --profile web add <path-or-npm-package>
```

Prefer a local path (`file:/path/to/dsh-session-fork`) or the npm package. Git dependencies can trip pnpm's `onlyBuiltDependencies` whitelist in profile installs, so `file:` / npm forms are the reliable route. After installing, restart the profile; `/branch help` in any session confirms the plugin loaded.

## Usage

Arguments are typed after the command in the same message — e.g. `/branch review` forks immediately; there is no separate argument prompt. (The command registers an input hint so the Web GUI treats `/branch <args>` as a command, not a normal chat message.)

```
/branch review
```

```
Branch 'review' → session session-3f9c…a1 (forked from session-8b2d…77 at event 42 (turn end)).
```

The anchor `atSeq` is the parent log's anchoring `turn/end` event seq — it locates the exact fork message in the parent session.

```
/branch adopt main
```

```
Branch 'main' → session session-8b2d…77 (root branch, adopted the current session).
```

```
/branch list
```

```
Branches:
  main     session-8b2d…77  (root)
  review   session-3f9c…a1  (← session-8b2d…77@42)
  old      session-c4aa…90  (root) [dangling: session missing]
```

```
/branch rename review phase2-review
/branch rm old --yes
```

Errors (duplicate name, unknown branch, missing source session, no completed turn to fork from) surface as readable messages; nothing crashes the host.

## Status

**v0.0.1 — no GUI yet.** Branch visibility in the Web UI lands in v0.0.2, squash-in v0.0.3 (see [docs/ROADMAP.md](docs/ROADMAP.md)).
