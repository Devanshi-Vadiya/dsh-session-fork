# Workspace governance — dsh-session-fork × git worktree

> This file is the governance baseline for every session in this workspace. It applies to all branches, including conversation history inherited from other branches.
>
> If you are not running on DeepSeek Harness, or the dsh-session-fork plugin is not enabled, ignore this governance.

## Definitions

- **session branch**: a branch-shaped session created and managed by the dsh-session-fork plugin.
- **root branch**: the branch where the user's first conversation lives; usually maps to git main.
- **sub branch**: any branch that is not the root branch; usually forked from the root branch and doing the hands-on work.
- **parent branch**: in a relation between two branches, the one that was forked from.
- **child branch**: in a relation between two branches, the one produced by the fork.

**Distinction**: the root branch is the parent of every sub branch — but a sub branch can itself be a parent branch relative to other branches.

## Core principles

Stated or not, every rule in this file serves three ideas:

1. Reduce context pollution.
2. Enable efficient parallel development.
3. Mirror human office collaboration: branches develop in parallel without collisions, and an integrator merges.

## Branches and worktrees

- One session branch ⇔ one same-named git branch ⇔ one same-named worktree under the container directory (`/` → `-`).
- The root branch always remains the developer's secretary: any activity that could pollute its context (writing code, deep research) is handed to a freshly forked branch.
- A sub branch that hits a side quest — loosely related to the current task, yet large enough to block it (e.g. mid-feat you discover a fix must land first, or later code reuse or style suffers) — forks a new sub branch based on itself.

## Permissions

- Only the root branch holds gh write access. Every sub branch has gh read access, plus unlimited power on its own git branch (push, rebase, force-push).
- A parent branch holds cross-branch git authority over its child branch (merge, rebase, squash). A child branch holds no cross-branch git authority over its parent.

## Creation

- When a fork happens, the sub branch proactively checks that the worktree exists, creates it if missing, and updates the `.code-workspace` file so the new worktree joins the VS Code workspace.

## Merge and closing

- A PR is opened only when the user asks; before opening it, rebase the sub branch onto the root branch. The PR merge itself must be performed manually by the user.
- When its work is done, a child branch proactively runs the session-level squash (`squash_into` <parent_branch>); git-level branch operations are performed by the parent branch.
- When the developer confirms closing: the child branch cleans up its own worktree and git branch, and removes the matching worktree entry from the `.code-workspace` file; the parent branch recycles (rm) the child's session branch.

## Collaboration cadence

- Discuss before acting: the user takes a few turns to settle the plan; read-only experiments are fine during discussion, but no file changes.
