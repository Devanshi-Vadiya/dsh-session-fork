# dsh-session-fork

[English](../README.md) | 简体中文

Agent 应用普遍以 session 管理对话:对话彼此割裂,记忆难以延续。`dsh-session-fork` 以 **branch** 作为 AI 对话管理的基石,提供并行工作流和连续、可合并的对话记忆,支撑 AI 团队协作与 AI 秘书等形态。长期方向是解决 Sub Agent 协作,以及基于 branch 的长期记忆管理。

本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)的插件,无法独立运行。

![branch_tab](media/branch_tab.png)

## 解决痛点

**对比 session 式管理**:对话变长之后,用户只剩两个选择——

- 另开一个 session:项目背景和工作记忆丢失;
- 继续聊下去:上下文被污染。

**对比传统 compact**:compact 没有任务边界,压缩时 AI 可能过度保留那些重要、却与当前任务无关的信息;而且对话一长,反复 compact 依然逃不开上下文的污染与丢失。

**branch 模式的优雅**:

- fork 让任务可以并行推进(建议配合 git worktree 使用);
- 分支各持独立记忆,再通过 branch 间操作彼此交换:工作分支保持专精的上下文,主分支摆脱污染的烦恼,又能统帅全局记忆。

## 核心功能

- **强化原生 fork**:接管 dsh 官方的 fork 操作,让每一次 fork 都成为被管理的 branch;
- **branch 间操作**:把分支上**独有**的对话与结论 squash 回主分支或其他分支;
- **branch 可视化**:vendor 了 VS Code 的 Source Control Graph,原汁原味的 VS Code 风格分支图。

## 一分钟体验

安装(需要基于 web 应用的 dsh profile):

```sh
dsh plugin --profile web add dsh-session-fork
```

然后在任意会话里:

```
/branch adopt main          # 把当前会话命名为 main 分支
/branch review              # 从最后一个完整回合 fork 出 review 分支
/squash into main           # (在 review 分支上)把新对话压缩回 main
```

或者切到「分支」页签,直接在图形化界面里完成同样的操作。

分支页签里:悬停查看完整 prompt,右键即可 **fork from here** 或 **squash 到指定分支**;官方 fork 按钮也接入了同一管线,每次 fork 都会落入分支图。

## 加入我们

我们想继续提供的功能:

1. **Sub Agent 天生契合 branch 模型**。引入 rebase、merge 等源语,让 AI 自主进行 branch 操作、把 Sub Agent 派发到分支上;它们通过 branch 间操作通信,取代传统的邮箱模式。
2. **基于 branch 的项目记忆管理**。现有的长期记忆模型都以项目为粒度,对 branch 模型是灾难——记忆跨 branch 泄漏,直接污染上下文。branch 粒度的记忆管理是让模型更健壮的必经之路。

我们对 AI 协作持开放态度:欢迎自由地用 AI 贡献代码、撰写 commit message 和 PR。但我们希望您对自己的代码负责,亲自 review,并在沟通中把 AI 当作您的工具,而不是让 AI 直接代表您与我们对话。

## License

[MIT](../LICENSE)
