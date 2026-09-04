# 工作区治理 — dsh-session-fork × git worktree

> 本文件是本工作区所有 session 的治理基线，对所有 branch 生效，包括从其他 branch 继承的对话历史。
>
> 如果当前没有在使用 Deepseek Harness 或者未启用 dsh-session-fork 插件，请忽略本治理。


## 定义

- session branch: 由 dsh-session-fork 插件产生并管理的 branch 形态 session。
- root branch: 用户第一个产生对话的 branch，通常对应 git main。
- sub branch: 所有非 root branch，通常由 root branch fork 产生，负责具体工作。
- parent branch: 两条 branch 间关系中，被 fork 的一方。
- child branch: 两条 branch 间关系中，由 fork 产生的一方。

**辨析**：root branch 总是任意 sub branch 的 parent branch。但是 sub branch 依然可以作为 parent branch，相对其他 branch。

## 治理核心

无论规则定义与否，本治理的核心思想：

1. 降低上下文污染
2. 高效并行开发
3. 模拟人类协作办公模式：各自 branch 不撞车开发 + 管理员合并

## 分支与 worktree

- 一个 session branch ⇔ 一个同名 git branch ⇔ 容器目录下同名 worktree（`/` → `-`）。
- root branch 应始终保持开发者的秘书的身份，任何可能污染上下文的行为（如写代码、深度调研），都应主动 fork 新 branch，交由它处理。
- 当 sub branch 遇到支线开发任务，与当前任务相关性不高，任务却足够大，并且对当前任务有阻塞作用（比方说，写 feat 时发现必须先进行 fix，否则会影响后续的代码复用或风格）也应当开启新的基于自己的 child branch。

## 权限

- 只有 root branch 有 gh 写操作权。sub branch 均有 gh 读操作权；同时在各自 git branch 上拥有无限权力 (push, rebase, force-push)
- parent branch 有处理 child branch 的 git 跨分支操作权 (merge, rebase, squash)。child branch 没有处理和 parent branch 跨分支操作权。

## 创建

- fork 发生时，应由 sub branch 主动检查 worktree 是否存在，缺失即创建，同时补写 `.code-workspace` 文件，将新创建的 worktree 加入 vscode 的 workspace。
- 总是可以放心地将需要 dsh 原生 sub agent 的场景迁移到使用 child branch。

## 合并与收尾

- 工作完成后，child branch 分支主动执行 session 层 squash（`squash_into` <parent_branch>）,如果因为无法 compact 出有效信息，可以改用 rebase，确认 squash 到位后，通过 `send_message_by_branch` 要求 parent branch 处理交付；git 层 branch 操作应由 parent branch 执行。
- 当开发者确认进行收尾工作时，child branch 负责自己的 worktree 和本地 git branch 清理，同时清理 `.code-workspace` 文件对应的 worktree；parent branch 负责对 child branch 的 session branch 进行回收（rm）。

## 消息与沟通

`send_message_by_branch` 工具推荐用于以下场景：

1. child branch 工作交付，紧接着 squash 操作，要求 parent banch 处理分之间操作。
2. 由 sub branch 创建的 child branch，用于处理支线任务时，用最简短的语言描述需求。（牢记 child branch 会**完全**继承你的上下文，你知道的 child branch 也能知道，不需要交代任何 context）
3. 被 sub branch 创建出的 child branch，遇到需要 parent branch 决策时，先 squash 自己，然后用最简短的语言提问；遇到需要用户决策时，建议直接用 `send_message_by_branch` 发给 parent branch 提醒用户，不需要 squash，让用户直接在 child branch 上处理。
