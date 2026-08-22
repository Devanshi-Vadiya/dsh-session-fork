# dsh-session-fork

English | [简体中文](docs/README.zh.md)

Agent apps manage conversations as sessions: chats are silos, and memory doesn't carry over. `dsh-session-fork` makes the **branch** the building block of AI conversation management — parallel workflows, continuous and mergeable conversation memory, the foundation for AI team collaboration and AI secretaries. The long-term direction is sub-agent collaboration and branch-scoped long-term memory.

This is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh); it cannot run standalone.

![branch tab](docs/media/branch_tab.png)

## Why branches

**Against session-only management**: once a conversation grows long, you're left with two bad choices —

- Start a new session: the project context and working memory are lost;
- Keep chatting: the context gets polluted.

**Against plain compaction**: compact has no task boundary, so the model tends to preserve what is important yet irrelevant to the task at hand; and as a conversation grows, repeated compaction still ends in pollution and loss.

**The elegance of branches**:

- fork lets tasks proceed in parallel (pair it with git worktree);
- each branch holds its own memory, and inter-branch operations move conclusions between them: the working branch keeps a focused context, while the main branch stays free of pollution yet still commands the full picture.

## What you get

- **Upgraded native fork** — the official dsh fork action is taken over, so every fork becomes a managed branch;
- **Inter-branch operations** — squash a branch's **unique** turns and conclusions back into the main branch or any other branch;
- **Branch visualization** — a vendored VS Code Source Control Graph, the authentic VS Code look.

## Quick start

Install (requires a web-app-based dsh profile):

```sh
dsh plugin --profile web add <npm-package-or-local-path>
```

Then, in any session:

```
/branch adopt main          # name the current session as branch 'main'
/branch review              # fork a 'review' branch at the last completed turn
/squash into main           # (on 'review') compress the new turns back into main
```

Or switch to the **branch** tab and do the same through the graphical interface.

In the branch tab: hover a row to see the full prompt; right-click to **fork from here** or **squash into a branch**. The official fork button is wired to the same pipeline, so every fork lands in the graph.

## Join us

What we want to build next:

1. **Sub agents are a natural fit for the branch model.** Introduce rebase, merge, and friends as primitives; let AI drive branch operations and dispatch sub agents onto branches that communicate through inter-branch operations — replacing the traditional mailbox pattern.
2. **Branch-scoped project memory.** Existing long-term memory models are project-grained, which is a disaster for the branch model: memory leaks across branches and pollutes context. Branch-grained memory management is the road to a more robust model.

We take an open stance on AI collaboration: feel free to use AI to contribute code, write commit messages, and draft PRs. But we expect you to own your code — review it yourself, and treat AI as your tool in communication rather than letting it talk to us on your behalf.

## License

[MIT](LICENSE)
