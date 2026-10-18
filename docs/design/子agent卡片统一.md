# 子 agent 卡片统一

> 状态：已实施（2026-10-18）
> 分支：`feat/subagent-cards`（工作树 `.worktrees/subagent-cards`）
> 目标：六家引擎派出的子 agent 都画成同一种卡片（运行中 / 完成 / 失败 / 无结果 + 子时间线），历史重载和实时直播画出同一张卡，并且每张卡都有结算的那一刻，不会永远转圈。

## 为什么要改

前端只在工具名等于 `Task` 时渲染子 agent 面板（`src/modules/chat/hooks/useChatMessages.ts` 的 `isSubagentContainer`），实时状态靠 `task_status` 事件按 `toolUseId` 折回卡片。这个判定已经和各引擎的实际情况脱节，下面四条都在本机真实数据上核实过：

- **Claude**：本机 Claude 记录里派 agent 的调用共 234 次，全部叫 `Agent`，叫 `Task` 的 0 次，因为上游早已改名。`claude-sessions.provider.ts` 会按调用结果里的 `agentId` 把状态和子时间线（`subagentTools`）挂到这一行上，但前端认不出 `Agent`，于是 Claude 的子 agent 全部退化成默认工具卡，后端备好的数据被丢掉了。
- **OpenCode**：真正派 agent 的是一个叫 `subagent` 的工具（`session_message` 的 assistant 内容里，`type: "tool", name: "subagent"`），它带 `state.status`（`completed` 等）和子会话 id `state.metadata.sessionID`。`opencode-sessions.provider.ts` 把 `type: "agent"` 的 part 画成 `Agent` 工具卡，但这个 part 不是派 agent，属于标错。
- **Codex**：每轮结束时，`queryCodex` 的 `finally` 调 `connection.close()`，这一步会 `child.kill()` 掉 app-server 进程。所以 agent 活不过派它的那一轮，它的完成事件永远到不了。本机 rollout 里 196 个 agent 有 19 个只有 `started` 记录、没有结束记录，这些 agent 在刷新后的历史里一直显示运行中。
- **Antigravity**：`invoke_subagent` 一次调用可以派出多个 agent。前端给它单独配了一套 `invoke_subagent` 卡片配置（`toolConfigs.ts`），运行时也自己维护一张 `activeSessionBackgroundTasks` 表，这是同一件事的第三份实现。

另外，`Task` 这个词同时指子 agent 和任务清单类工具（`manage_task`、`TaskCreate`、`TaskUpdate`，见 `ToolGroupContainer.tsx`）。用一个两义的名字当类型判据，正是 Claude 这次出问题的原因。

## 核心约定：子 agent 在协议里只叫 `Agent`

一条 `tool_use` 只有在工具名等于 `Agent` 时，才是子 agent 卡片。前端只认这一个名字，不按引擎分支。从此 `Task` 只指任务清单类工具。

各引擎的适配层负责把自家派 agent 的形态翻译成两样东西：

1. 一条工具名为 `Agent` 的 `tool_use` 行，历史读取和实时流用同一个构造函数生成，保证刷新后重建的就是直播画出的那张卡。
2. 状态信息：历史行上挂 `subagent`（`SubagentInfo`），实时用 `task_status` 事件按 `toolUseId` 折回。每张卡都必须有一个结算点。如果引擎给不出结束信号，适配层就必须在能确定"不会再有消息"的时刻（轮次结束、进程退出、会话丢失）把它结算成 `stopped`，前端显示为「no result」。

`Agent` 这个名字定义成常量，前后端各一份（前后端不共享运行时代码）。前端那份要有测试钉住它和后端那份的值一致，比如共用一个 fixture，或者写一个对照断言。

权限请求不改名。Claude 的「总是允许」会按原工具名写进设置（`buildClaudeToolPermissionEntry`），改名会让规则对不上。

## 各引擎怎么接

| 引擎 | 原生形态 | 适配层做什么 | 结束信号 |
| --- | --- | --- | --- |
| Claude | `Agent` 工具；老记录里叫 `Task` | 老名字 `Task` 一律翻译成 `Agent`。历史（`claude-sessions.provider.ts` 约 150、1696 行）和实时共用同一个翻译点。`claude-background-work.ts` 识别后台 agent 时要能认出两个原名 | 同步 agent 用调用结果；后台 agent 用 SDK 的任务通知；进程没了就 `stopped`（现有逻辑） |
| ZCode | `Agent` 工具 | 撤掉本分支先前加的 `Agent`→`Task` 改名（`normalizeZCodeToolName`、`zcode-sessions.provider.ts` 按 `'Task'` 过滤的地方），改为按常量识别 | `subagent_stopped`（引擎包已核实，会发 `completed` / `failed` / `stopped`）；引擎崩溃时由适配层补发 `stopped` |
| Codex | 只有 `SubAgentActivity` 记录 | `buildCodexSubagentTaskRow` 合成 `Agent` 行，函数名也一并改掉 | `completed` / `interrupted` 活动；轮次结束时还登记着的一律 `stopped` |
| OpenCode | `subagent` 工具 | 翻译成 `Agent`。状态取工具的 `state.status`；有 `metadata.sessionID` 时读子会话作为子时间线（参照 Claude/Codex 的 `subagentTools` 形状）。`type: "agent"` 的 part 不再画成 `Agent`，按它的真实含义处理；如果查不出含义，就不画 | 工具自身的状态 |
| Antigravity | `invoke_subagent`，一次调用派 N 个 | 在适配层把一次调用拆成 N 条 `Agent` 行，`toolId` 用 `<调用 id>:<conversation_id>`，每个 agent 一张卡。`activeSessionBackgroundTasks` 并入共用的 `BackgroundWorkRegistry`。前端删掉 `invoke_subagent` 专用配置 | 引擎在所有 agent 都汇报完之后才给出轮次结果，结果到达时一起结算；进程退出时一律 `stopped` |
| Cursor | 存储里有子 agent 目录，派 agent 的工具不明 | 用户不用 Cursor，只做最小核查：如果转录里有派 agent 的工具，就照上面的方式接进来；没有就只在架构文档里写一句 | — |

Antigravity 拆成多张卡是选定方案，原因是 `SubagentPanel` 一次只画一个 `SubagentInfo`，而 Antigravity 的每个 agent 都有自己的 `conversation_id`（也就是自己的子会话）。将来要改成"一张卡列出多个 agent"，只需要改 Antigravity 的适配层。

## 前端随之要改的地方

- `useChatMessages.ts`：判定 `isSubagentContainer` 改成用常量 `Agent`。
- `toolConfigs.ts`：`Task` 那段子 agent 配置改挂到 `Agent` 上；`invoke_subagent` 的配置删掉。`Task` 只保留给任务清单类工具，如果没有任何引擎再发 `Task`，就把对应配置删掉。
- `toolTaxonomy.ts`：`agent` 分类里的 `Task`、`invoke_subagent` 换成 `Agent`。
- 历史遗留的 `Task`（`claude-runtime.provider.js` 的 `planModeTools`，`PermissionsContent.tsx` 的预设列表）：先核实 Claude 当前版本是否还接受 `Task` 这个名字，再改成 `Agent`，或者两个都保留。核实结果要写进提交信息。

## 本分支已有实现的修复

这些是本轮评审发现、并且已经核实属实的问题。

1. **Codex 子 agent 随进程死掉。** 在 `queryCodex` 的 `finally` 里，对本会话还登记着的 agent 逐个发 `task_status`（`status: 'stopped'`），然后注销。历史读取时（`codex-sessions.provider.ts` 约 697 行），没有结束记录的 agent 只有在登记簿里还有它时才算 `running`，否则算 `stopped`，和 ZCode 的旁车规则一致。为此要把 Codex 的登记簿实例单独放进一个模块（参照 `zcode-background-work.ts`），让 sessions provider 也能读到。代码注释和文档里"Codex 引擎活得比一轮久"的说法要删掉。
2. **ZCode 引擎崩溃时卡片永远转圈。** 运行中监听器和窄监听器（`subagentWatchers`）收到 `SESSION_LOST_METHOD` 时，现在只清登记簿。改成抽一个共用函数：先对每个还登记着的 agent 发 `stopped`，再清空。两处都调它。
3. **ZCode 交接窗口。** `zcode-runtime.provider.ts` 在新一轮开始后，要先经过 `subscribeToSessionEvents`、`configureSessionMode`、`resolveSendModelParams` 三次异步等待，才撤掉旧的窄监听器。这段时间里，迟到的 stop 会用旧轮次的 writer 发出，导致序号回退或撞号。改成在三次等待之前就撤掉窄监听器、挂上本轮监听器。
4. **被取代的旧轮次多转发。** 旧轮次的监听器要等轮询（约 100ms 一拍）才知道自己被取代了。这段时间里所有事件都会多发一份。改成：`runLifecycle.isNewestRunForEngineSession(handle)` 为假时，监听器只处理会话丢失，其余事件一律不转发。
5. **重复代码收口。** 两份 `task_status` 构造函数（`createCodexTaskStatus` 和 ZCode normalizer 里的 `build`）合成一个共用工厂，放在 `shared/background-work/` 下。给 `Array<{ sessionId; tasks: BackgroundTaskSummary[] }>` 起一个类型名，替换 4 处裸写。窄监听器改走 `context.normalizeMessage`，和运行中监听器同一个出口。
6. **失败结算的用量。** 引擎的失败 stop 不带 `totalTokens`、`totalToolUseCount`（引擎包已核实）。没上报的字段留空，不要填 0。`TaskUsage` 的字段如果是必填，就把它改成可选。
7. **旁车目录读取的错误。** `readZCodeAgentSidecars` 遇到 `ENOENT` 以外的错误时，要用 `console.error` 记一行日志再返回空表。

## 核实过、不修的

- Codex 的 `started` 记录缺线程 id 导致配不上结束：本机 1942 条记录中有 0 条缺线程 id。而且修复 1 之后，没配上的 agent 会在轮次结束时被结算。
- ZCode 停止后登记项永远不清：引擎的 `finalizeBackgroundStopped` 会对被杀的后台 agent 发 `status: "stopped"`。
- 旁车写文件和发事件之间的毫秒级窗口、刷新后用量行丢失：前端子 agent 面板不渲染用量，这个窗口只会让卡片在刷新后短暂显示 `stopped`。

## 测试要求

先写测试，再改实现。每条都用公开入口断言（跑一轮对话、读历史、查 `listBackgroundWork`），不要翻内部状态。

- 每家引擎各一组：历史和实时都产出工具名为 `Agent` 的行，并且能被结算（完成 / 失败 / `stopped` 三态中至少覆盖正常完成和异常结算）。
- Claude：老记录的 `Task` 翻译成 `Agent`；后台 agent 识别对两个原名都成立；权限请求保留原名。
- Codex：用一个真实时序的测试替换现有"两个假 server"的绕法，即一轮结束、进程被关闭，断言页面收到 `stopped`，登记簿为空。
- ZCode：引擎崩溃时页面收到 `stopped`；交接窗口内迟到的 stop 只被转发一次；被取代的轮次不转发。
- OpenCode：`subagent` 工具变成 `Agent` 卡；`agent` part 不再画成 `Agent`。
- Antigravity：一次调用派 2 个 agent，得到 2 张 `Agent` 卡，结果到达时两张都结算。
- 前端（vitest）：`Agent` 走子 agent 面板；`Task`、`TaskCreate` 不走。

## 验收标准

- `pnpm run typecheck`、`pnpm run lint`、`pnpm test`、`pnpm run test:client` 全部通过，不新增 lint 警告。
- `grep` 全仓：除了"老名字翻译"那一处，以及 Claude 权限 / 计划模式的兼容名单（必须附注释说明原因），不再有任何把 `Task` 当子 agent 判据的代码。
- 拿本机真实数据各跑一次历史读取探针：Claude、Codex、ZCode、OpenCode 各取一个含子 agent 的会话，确认产出 `Agent` 行，状态没有永久 `running`。
- `docs/core/providers.md` 子 agent 一节重写成六家对照（写机制，不抄字段表）；`docs/core/chat.md` 写明前端只认 `Agent`。文档和代码在同一个提交里。
- 设计稿状态行改为「已实施（日期）」。

## 子 agent 的过程送达与子会话归属

前面几节解决的是"认出卡片、按时结算"。下面三个问题都发生在卡片认出来之后，即子 agent 的过程和请求有没有送到用户面前。三者都在本机核实过。

**前端断了子 agent 的状态与时间线。** `useChatMessages.ts` 的 `normalizedToChatMessages` 生成工具卡时，不复制后端给的 `subagent` 和 `subagentTools`，所以 `SubagentPanel` 收到的 `subagent`、`activity` 永远为空。这一步在提交 `32c8648e`（transcript 视图模型改类型）时被删掉，之后再没恢复。修法：把 `msg.subagent` 原样交给 `subagent`，把 `msg.subagentTools` 交给 `subagentActivity`，并用转换测试钉住。

**OpenCode 子会话的请求和事件找不到主人。** 下面是用真实 OpenCode 2.0.31 跑一遍看到的过程。父会话调用 `subagent` 工具后，引擎新建一个子会话，`session.created` 里带 `parentID` 和继承来的 `permissions`。父会话上的 `session.tool.progress` 事件里，`id` 是派 agent 的调用，`metadata.sessionID` 是子会话。子 agent 执行 shell 时，`permission.asked` 带的是子会话 id。cloudcli 的权限桥（`opencode-interaction-bridge.ts` 的 `onPermissionAsked`）和事件分发（`opencode-run-registry.ts` 的 `dispatch`）都只按父会话 id 精确匹配，于是：
- 在"询问"或"计划"模式下，子 agent 的批准卡片不出现，子 agent 和父对话一起挂住；
- 直播时，子 agent 的每一步都被丢掉，卡片里看不到过程。

修法：从 `session.created.parentID` 和 `tool.progress.metadata.sessionID` 建立"子会话 → 根会话 + 派它的调用"的归属表，嵌套多层的子会话归到同一个根会话。
- 权限请求和提问卡片按根会话显示，回复仍发给子会话。
- 子会话的事件翻译成这张 `Agent` 卡的实时时间线。
- 子会话的结束事件不结算父会话这一轮。
- 归属表在父会话这一轮结束、或引擎退出时清理。

直播时间线的呈现方式先查清 Claude 现在怎么做（实时流里子工具调用带 `parentToolUseId`），五家统一用一种方式，不为 OpenCode 另造一套。

**其他引擎的同类问题。** "子 agent 发出的请求只认父会话 id"是同一类缺陷。ZCode 的 `requestPermission` 按 `runsByEngineSession` 找当前轮次，找不到就自动拒绝（`zcode-run-lifecycle.ts` 约 455 行）。Claude、Codex、Antigravity 同样要逐家拿证据核实：子 agent 的权限请求和提问能不能送到页面、能不能被回复。核实有问题的按同一个机制修，没有问题的写明证据。

验收在前文标准之外，再加两条：
- 前端转换测试和面板渲染测试证明时间线能显示；
- 用真实 OpenCode 引擎做一次端到端验证：在"询问"模式下派子 agent 执行 shell，批准卡片出现，批准后跑完，直播时卡片里能看到子 agent 的步骤。


## 第四轮：嵌套、归属时序、请求来源与直播补全

验收后的评审补出下面几条，全部已核实。

**嵌套的 Agent 被吞。** 折叠目标原先包含自己也带 `parentToolUseId` 的 `Agent` 行，里层 agent 连同它名下的所有行一起消失。规则改为：行沿父链走到最外层的 `Agent` 调用，折进那张卡；里层 agent 是外层时间线里的一步。父链上的调用本页还没有时，这行先不进主线程，等卡片到了再折入；父调用是已知的非 agent 调用时，行照常留在主线程。

**OpenCode 归属表的三个时序问题。** 孙会话比它的祖先更早被登记时，卡片曾被拷成里层的调用，改为分发时顺祖先链现算；同一个子会话被后一次调用再派时，卡片跟随最新的调用；卡片未知期间存着的帧超过 500 条被悄悄丢弃，改为每个子会话记一次警告。

**ZCode 的批准卡片没人撤回。** 后台 agent 在用户回答前停止，卡片留在页面上。agent 停止或引擎死亡时先撤回它名下的卡片再释放临时目标；两种顺序（先回答后停止、先停止后回答）都有测试。

**服务端偶发失败。** 全量 `pnpm test` 连续运行取失败用例名，修的是原因，不靠重试或加长超时。

**产品决定。**
- 运行中的卡片在折叠标题下显示步数和最新一步，展开时看最新的步骤，更早的收在“显示更早”后；默认仍折叠。
- 批准和提问卡片上方写“来自子 agent：<描述>”。来源由各 provider 在边界填进 `context.subagent`：Claude 用 `canUseTool` 的 `toolUseID` 配合流上的 `parent_tool_use_id`（`agentID` 不能直接对应到 `Agent` 调用，因为同步 agent 的 `agentId` 要到调用结束才出现），OpenCode 用归属表，ZCode 读引擎写在请求上的 `origin`（`parentToolCallId`、`description`），Codex 用审批请求的 `threadId` 查登记簿。Antigravity 没有批准流程。
- ZCode 继续等人，不自动拒绝，但不能无声地等：推送通知挪到网关，对任何引擎的批准卡片发一次；一轮成功结束时保留仍属于后台 agent 的卡片，其余随这一轮清掉；没有前台回复时到达的卡片只把会话记成后台工作。
- 侧栏没有单独的“等待批准”文案：卡片到达会让会话作为后台工作出现在侧栏，输入框上方的批准卡片本身是主要提示（有待批准卡片时活动条本来就隐藏）。

**直播时间线补全。** 真实 ZCode 引擎会把 agent 的工具调用镜像在父会话的流里（`tool.updated`，载荷带 `source: "subagent"` 和 `parentToolCallId`），此前这些行以主线程工具行的样子出现；现在带上 `parentToolUseId`，不需要订阅子会话。Antigravity 的 agent 过程只写在它自己的 transcript，登记期间用 `fs.watch` 加轮询重读，与历史同一个读取器，结算时再读一次。两家都用真实引擎端到端验证过。不转发 Codex 的 `collab_spawn` 形状（真实引擎从不发）。

## 第五轮：小修

- Antigravity 实时流除了 `Agent` 卡片，还会发 `invoke_subagent` 的原始工具行和结果行；历史不画它。实时分支跳过这次调用，实时与历史一致。真实 `agy` 运行已确认帧里不再有 `invoke_subagent`。
- 折叠规则的三个边角：父链上有非 agent 祖先时仍取最外层 `Agent`；成环时在闭合处截断；找不到父卡的行只有“直播行且会话仍在运行”才被扣住，历史行和已结算会话的行照常显示。
- Claude 批准卡片的来源：真实运行里流领先请求约 1ms，但两者顺序没有保证，请求先到时最多等 1.5 秒。真实 Claude 运行（默认模式，子 agent 执行 `touch`）确认卡片带 `context.subagent`。一轮的进程结束时撤回这一轮没回答的卡片，不依赖 SDK 在进程退出时中止信号。
- 推送通知的标题带会话名：网关把客户端发来的会话标题（没有就用库里的名字）交给写入器。
- Antigravity 的 agent 跟踪：结算前等最后一次读取发完；非法的 `conversationId` 只警告一次。

不做：ZCode 在 20 秒去重窗口过后重新推送（影响小）；Antigravity 增量读取 transcript（性能取舍，影响小）。
