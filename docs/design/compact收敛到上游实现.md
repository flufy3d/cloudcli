# `/compact` 收敛到上游实现

## 状态

已实施（2026-11-13）。依据：`main`（7495a21d，已合入 `upstream/main` 030d320f）与 `upstream/main` 的代码对读，2026-11-13。

实施结果：
- 与上游的差异（`server` `src` `shared`，不含 json）从 23623 行降到 22544 行。`codex-app-server.client.ts`、`useSlashCommands.ts`、`chatStorage.ts` 与上游一致；zcode `run()` 与上游逐字一致。
- 验证：typecheck 通过；lint 无新增（warning 283 → 279）；服务端 2465 个用例 0 失败；前端 231 个文件 / 1724 个用例全部通过；构建通过，vendor chunk 无循环。
- 未手测：没有在 dev 实例里逐引擎手测 `/compact`。zcode 本机未安装，文本路径的等价性依据上游文档。

### 实施决定

- **zcode 完全采用上游写法**：`run()` 恢复成上游的内联形状（与上游逐字一致），删除 `driveSessionTurn`、`compact` 切面、`requestCompaction` 和 `COMPACT_REQUEST_TIMEOUT_MS`；`/compact` 作为普通文本经 `session/send`/`sendText` 交给引擎解析。
  - 理由：11-10 引入的轮次归属判断 `classifyTurnEvent` 只认 prompt 的 inputId。`session/compact` 起的压缩轮次不带这个 inputId，会被判成"未定"或"别人的轮次"，所以 fork 的压缩通道很可能从那以后就结束不了 run，只是没有测试覆盖。文本路径带 inputId，归属判断天然正确。
  - 未验证：本机没装 zcode，文本 `/compact` 与 `session/compact` 是否等价只能依据上游文档（上游称引擎的 `session/compact` 内部就是 `submitPrompt("/compact")`）。以后用 zcode 手测时，如果发现文本被当成普通 prompt 发给模型，再回头在 `run()` 内处理。
- **antigravity 不动**：目录值保持上游的 `true`，菜单路径本来就是文本透传；本次删掉兜底通道后，`COMPACTION_UNSUPPORTED` 的不一致随之消失。agy 实际行为的实测不阻塞本次删除。
- **opencode 保留 1 行 `purpose`**：`run()` 里用 `compactCommand ? 'compact' : 'chat'`，压缩失败仍计为本轮失败。

## 目标

删除 fork 自己的按需压缩通道（`chat.compact` 帧 + runtime 可选切面 `compact()` + composer 端 `queued_compact_*` 停放），
改用上游的"`/compact` 作为普通消息文本、runtime 在 `run()` 里认出并改调引擎原语"的实现，
从而消掉每次上游合并在这些文件上的固定冲突。上下文占用（context usage）相关的 fork 增强**不在删除范围**，单独保留。

## 范围

- 在范围：压缩的**触发与执行路径**（前端菜单项/发送、websocket 帧、runtime 切面、各引擎客户端的压缩调用、回合中排队）。
- 不在范围：压缩后的占用读数（`compacted`/`summaryBytes`/`cumulative`/`percentage`、claude `postTokens`、`sessions.context_window` 持久化）、压缩行渲染（`createCompactionMessage`/`foldCompactionRows`，两边已一致，来自上游）。

## 关键发现：fork 的通道在合并后已基本是死代码

1. 上游 94aab0ef（"offer /compact for every engine that can compact"）在 `src/shared/hooks/useProjectSlashCommands.ts` 注入 `COMPACT_COMMAND`，`type: 'engine'`；fork 文件与上游一致。
2. fork 的 `src/modules/chat/hooks/useSlashCommands.ts:142-147`（115d917c）只在 `projectCommands` **没有** `/compact` 时才加自己的 `type: 'built-in'` 项；而上游注入条件是 `supportsCompaction && result.length > 0`。
3. `isEnginePromptCommand`（`src/shared/utils.ts:250`）对 `type: 'engine'` 返回 true：菜单选择只把文本插入输入框，提交时 `useChatComposerState.ts:1338-1343` 跳过 `executeCommand`，按普通 `chat.send` 发出。
4. 所以只有命令列表**为空**（`/api/commands` 拉取失败或尚未返回）时，fork 的 `executeCommand` 中 `/compact` 分支（`useChatComposerState.ts:682-722`）→ `chat.compact` → `handleChatCompact` 才会走到。日常使用中，用户实际跑的已经是上游路径。
5. 副作用（现存缺陷）：antigravity 的目录 `supportsCompaction: true`（上游值），但 fork 的 `providerRuntimeService.supportsCompaction`（`provider-runtime.service.ts:229`）看的是 `runtime.compact` 切面，antigravity 没有。走到兜底项时网关回 `COMPACTION_UNSUPPORTED`。
6. 文档已和代码对不上：`docs/core/chat.md:17` 写"composer 不落用户气泡"，`:125` 写回合中压缩写 `queued_compact_*`；`providers.md:185` 写 antigravity 不支持。现实中这三条都不成立。

## 现状对比（逐引擎）

| 引擎 | fork 通道（`chat.compact` → `runtime.compact`） | 上游通道（`chat.send` 文本 `/compact` → `runtime.run`） |
| --- | --- | --- |
| claude | `claude-runtime.provider.ts:3239` `compact: (o,w,c) => queryClaudeSDK('/compact', o, w, c)`，与 run 文本完全等价 | run 收到 `/compact` 文本，SDK 当 local slash command 执行。CLI 的 `status: compacting` / `compact_boundary` 经 `claude-sessions.provider.ts:1380+` 变成压缩行 |
| codex | `codex-runtime.provider.ts:2024` → `codexAppServer.compactThread`（`codex-app-server.client.ts:598`）：**另起一个 app-server 进程**，`thread/resume` + `thread/compact/start`，等 `contextCompaction`/`turn/completed`（最长 10 分钟）。实时只发一条 `status: Compacting context…`，没有压缩行；`complete` 后靠刷新历史看到结果 | `codex-runtime.provider.ts:1750` `readCompactCommand`：驻留会话走 `codex-session-manager.ts:1206`（`compact: true`，线程忙于上报时拒绝），否则在本轮连接上调 `thread/compact/start`。`contextCompaction` 项实时出"进行中→完成"的压缩行（`codex-runtime.provider.ts:660`）。`/compact <说明>` 直接报错 |
| opencode | `opencode-runtime.provider.ts:628` `compact`：`runs.create(..., 'compact')` + `compactSession()`；`session.compaction.failed` 结算为**本 run 失败**（`opencode-run-registry.ts:884`） | `run()` 418-448 行：`readCompactCommand` 后调同一个 POST，run 的 purpose 是 `'chat'`。压缩失败时 run 照样报成功，失败只在压缩行里显示（上游 providers.md 有明文） |
| zcode | `zcode-runtime.provider.ts:408` `compact` → `driveSessionTurn`（fork 把 `run` 重构成共用骨架）+ `requestCompaction`（`session/compact`）。引擎回 `already_running` 时显式报错 | `/compact` 文本经 `session/send` 交给引擎自己解析。上游文档称引擎的 `session/compact` 内部也是 `submitPrompt("/compact")`，落盘一致（**未本地复核**） |
| antigravity | 无切面：兜底路径回 `COMPACTION_UNSUPPORTED`，菜单路径实际走上游 | 文本透传给 agy。上游称 `-p` 模式"先回一轮再生成 checkpoint"；fork 0d684114 实测为"当普通 prompt 透传"。**结论冲突，未复核**（可能是 agy 版本差异） |
| cursor | 不支持 | 不支持（目录 `false`） |

**回合中 / 后台任务期间发送：**

- fork（仅兜底路径）：`isLoading` 时写 `localStorage` 的 `queued_compact_<id>`，composer 显示"压缩已排队"横幅，可以取消。回合与 `queuesInput` 的后台工作都结束后，由**当前打开的页面**发 `chat.compact`（`useChatComposerState.ts:1661-1701`）。关掉页面，或换一台设备，这条请求就不会发出。
- 上游（实际路径）：斜杠命令一律进服务端队列（`session_drafts`）。`session-drafts.db.ts` 的 `isSlashCommand` 不让它和其它排队消息合并。`scheduled-message-dispatcher.service.ts` 的 `dispatchQueuedMessages` 等 `isSessionBusy` 为假后才发，后台工作的规则沿用 `backgroundWorkQueuesInput`。整个过程不依赖页面在线，队列卡片就是现成的"已排队"提示，也能取消。
- claude 的 `inputWhileBusy: 'background'`：主回合已经结束、只剩后台工作时，上游路径把 `/compact` 直接写进驻留进程 stdin，后台任务不受影响（按 `providers.md` 的驻留设计）。fork 兜底路径则要等后台工作结束。CLI 在后台 shell 还活着时做压缩是否有副作用，**未实测**。

**压缩后的占用读数**：与触发路径无关，两种路径产生同样的读数。

- claude 的 `extractCompactionTokenBudget` 在流循环里（`claude-runtime.provider.ts:2457`），run 和 compact 共用。
- opencode 的 run 路径在 461 行发 `sendFinalTokenBudget`，同样带 `compacted` / `summaryBytes`。
- zcode 的 `zcode-context-usage.ts` 由 `/token-usage` 与回合末读数共用。
- codex 压缩后 `thread/tokenUsage/updated` 的 `last` 是否就是压缩后占用，**未核实**。
- 上游没有 `compacted` / `summaryBytes` / `cumulative` / `percentage` 字段（`ProviderTokenUsageResult` 只有 used/total/breakdown），徽章要到下一回合才会更新；但上游的压缩行文字里写有 `pre → post tokens`。

## 行为差异与取舍

改用上游后，**失去**的：

1. 不再"不落用户气泡"：`/compact` 会作为一条用户消息出现在时间线上。这本来就是现状，影响很小。
2. opencode 压缩失败不再让 run 以失败结束，只能靠压缩行的 `failed` 阶段提示。
3. zcode 的 `already_running` 不再有专门的报错。上游路径下引擎面对重复 `/compact` 会怎样，未验证。
4. 命令列表拉取失败时，菜单里没有 `/compact`。不过手动敲 `/compact` 仍然会作为文本发出，并被 runtime 认出，功能没有丢。

**得到**的：

1. codex 不再为一次压缩另起 app-server 进程，避免它和驻留会话（`codex-session-manager`）同时操作同一 thread。双进程并发是否真会出错，未复现，但上游方案没有这个隐患。codex 压缩还能实时显示压缩行。
2. 回合中排队由服务端持久保存，跨页面、跨设备都能发出，也不再和服务端 2 秒一轮的队列轮询抢跑（fork 在 1657-1660 行专门写了绕过逻辑）。
3. antigravity 不再出现"菜单里有、网关却拒绝"的不一致。
4. 前后端都去掉了一个协议帧（`chat.compact`）和一个 runtime 切面，`supportsCompaction` 重新成为纯目录能力，与上游一致。

## 方案

### 删除 / 回退为上游（按文件）

后端：
- `server/shared/interfaces.ts`：删 `IProviderRuntime.compact?`（约 14 行）。
- `server/modules/providers/services/provider-runtime.service.ts`：删 `compact`（128-140 行）、导出项、`supportsCompaction()`（229-235 行），约 25 行。
- `server/modules/providers/services/provider-capabilities.service.ts`：从 runtime 类型里删 `compact?: unknown` 和那行注释。
- `server/modules/websocket/services/chat-websocket.service.ts`：删 `handleChatCompact`（530-571 行）、`dispatchRun` 的 `execution` 参数及 785-786 行分支、网关接口里的 `compact` 和 `supportsCompaction`（94-99 行）、`case 'chat.compact'`、协议注释 1208 行，约 60 行。
- `claude-runtime.provider.ts`：删 `compact` 切面（3236-3243 行）。
- `codex-runtime.provider.ts`：删 `compact`（2020-2044 行，25 行）。`codex-app-server.client.ts`：删 `compactThread` 与 `COMPACT_NOTIFICATION_TIMEOUT_MS`，**这个文件因此与上游零差异**（-68 行）。
- `opencode-runtime.provider.ts`：删 `compact`（614-680 行，约 70 行）和导出项。`opencode-api.client.ts`：`compactSession(): {messageId}` 改回上游的 `compact(): {inputId}`，同时改 run 路径 448 行的调用。`opencode-run-registry.ts` 的 `purpose`：见下方"保留项 2"。
- `zcode-runtime.provider.ts`：删 `compact`、`requestCompaction`（1295-1320 行）和压缩受理超时常量（约 99 行处）。把 `driveSessionTurn` 拆回上游的 `run` 内联写法（这一步差异最大，约 120 行，冲突主要来自这里）。

前端：
- `useChatComposerState.ts`：删 `executeCommand` 中的 `/compact` 分支（678-723 行）、`pendingCompactSession` 状态（541-552 行）、停放后发送的 effect（1652-1701 行）、随会话切换的 effect 与 `cancelPendingCompact`（1844-1857 行）、返回值，以及传给 `useSlashCommands` 的 `supportsCompaction`，约 130 行。
- `composer/ChatComposer.tsx`：删 `pendingCompact` / `onCancelPendingCompact` 两个 props 和横幅（467-486 行），约 25 行。`ChatInterface.tsx`：删 4 行透传。
- `hooks/useSlashCommands.ts`：删 `compactionCommand` 与合并逻辑（100-115、142-147 行），约 25 行。
- `utils/chatStorage.ts`：删 `StoredQueuedCompact` 及 read/write/clear 函数，约 40 行。
- i18n（en、zh-CN、zh-TW）：删 `input.compactQueued.*`、`misc.compactNoSession`、`misc.commandDescriptions.compact`。

测试：删 `server/modules/websocket/tests/chat-compact.test.ts`（115 行）、`src/modules/chat/tests/composerQueuedCompact.test.tsx`（153 行）、`src/modules/chat/tests/slashCommandCompactEntry.test.tsx`（57 行），以及 `opencode-runtime.test.ts` 里通过切面调用的三个 compact 用例（361-410 行）。`provider-capabilities.test.ts` 中把"能力来自切面"的注释改回目录语义；`opencode-api-client.test.ts` 跟着改名。

文档：
- `docs/core/chat.md`：删第 17 行的 `chat.compact` 入口行，改写第 125 行（`/compact` 与其它斜杠命令一样进服务端队列、不与其它消息合并）。
- `docs/core/providers.md`：137 行删除 `compact` 切面；156 行删"切面只是实现手段"一句；185 行用上游 providers.md 377-398 行的"会话压缩是静态能力"及引擎对照表替换。187 行"压缩刚结束的读数"保留。

**规模估算**：生产代码约 −430 行（后端约 280，其中 zcode 约 120；前端约 230）、测试约 −380 行。按上次合并的冲突文件统计，可消掉的易冲突差异：

| 文件 | 约减少的差异行 |
| --- | --- |
| `codex-app-server.client.ts` | 68（清零） |
| `codex-runtime.provider.ts` | 25 |
| `claude-runtime.provider.ts` | 9 |
| `ChatComposer.tsx` | 25 |
| `useChatComposerState.ts` | 130 |
| `provider-capabilities.service.ts` / `capabilities.ts` | 若干 |
| `chat-websocket.service.ts` | 60 |
| `zcode-runtime.provider.ts` | 120 |

合计约 **440 行**。剩余冲突主要来自上下文占用的 fork 增强（`claude-usage.ts`、`TokenUsageSummary`、`ContextUsageBar`、`readCodexTokenBudget`），不在本次范围。

### 值得保留的 fork 行为（最小面）

1. **压缩后占用读数**（claude `postTokens` 实时帧、opencode/zcode 的 `compacted` + `summaryBytes`）原样保留，因为它们不依赖触发路径。可以给上游提一个小的增量 PR：只提 claude 的 `extractCompactionTokenBudget`，在 `compact_boundary` 时发一帧 `token_budget`，再加上 `summarizeClaudeTokenUsage` 对边界的处理（约 60 行加测试，不新增类型字段）。`compacted` / `summaryBytes` 依赖 fork 的占用语义扩展，暂不提。
2. **opencode 压缩失败计为 run 失败**：可在 `run()` 里写 `runs.create(..., compactCommand ? 'compact' : 'chat', ...)`，复用已有的 `purpose`，只改 1 行。但 `opencode-run-registry.ts` 本身与上游差异很大（约 1385 行），`purpose` 不是那里的主要冲突源。建议先保留这 1 行，同时向上游提议（上游现在明确选择"报成功、行内显示失败"，可能不接受）；被拒就删掉，跟随上游。
3. 其余（不落气泡、composer 侧排队横幅、zcode `session/compact` 原语、codex 独立进程等待）都**不保留**。

## 验证

- `npm run typecheck`、`npm run lint`；`npm test`，重点跑 `codex-runtime`、`codex-session-manager`、`opencode-runtime`、`opencode-run-registry`、`opencode-api-client`、`zcode-runtime*`、`provider-capabilities`、`provider-catalog-parity`、websocket 相关套件；`npm run test:client`，重点跑 `useProjectSlashCommands`、`tokenUsageSummary`、`contextUsageBar` 及 composer 队列相关测试。
- 用 `grep -rn "chat.compact\|queued_compact\|compactThread\|runtime.compact\|pendingCompact" server src shared` 确认没有残留。
- 在独立 worktree 的 dev 实例（不碰 PM2）里手测：claude、codex、opencode、zcode 各自：
  - 空闲时发 `/compact`：压缩行从"进行中"变为"完成"；claude 的百分比立刻下降，opencode/zcode 显示"压缩摘要 · xKB"；
  - 回合中发 `/compact`：出现队列卡片，回合结束后执行，且不和其它排队消息合并；
  - claude 在后台 Bash 任务期间发 `/compact`：后台任务不被杀；
  - `/compact 说明`：codex/opencode 报错，claude/zcode 交给引擎处理。
- antigravity：用当前 agy 版本实测 `/compact`，以决定目录值，并统一 fork 与上游文档的说法。

## 风险

- **zcode**：`session/send "/compact"` 与 `session/compact` 是否真的等价（摘要落盘、`already_running`、压缩期间的模型），目前只有上游文档的说法，需要实测。不等价时，退路是只保留 `run()` 内部的 `readCompactCommand` → `requestCompaction` 分支（与 codex/opencode 同形，约 20 行），并提给上游。
- **antigravity**：两边实测结论相反，可能出现"菜单提供了，但 agy 把它当普通 prompt"的情况。这个问题与本次删除无关，现状已经如此。
- **codex**：改走驻留会话后，线程忙于上报时 `/compact` 会被拒（上游行为），用户需要重发。
- **删除 `driveSessionTurn`**：zcode 自己的后续修复如果依赖这个骨架，回退时需要逐处核对 diff。
- 回合中排队完全依赖服务端队列，跑完压缩后才轮到后续排队消息。按上游 `isSlashCommand` 规则推断如此，未单测覆盖压缩与后续消息的先后顺序。

## 结论与建议

建议实施。fork 的 `/compact` 触发通道在上次合并之后，只在命令列表为空时才生效；日常路径已经是上游实现。删掉它几乎没有功能损失，还能修掉 antigravity 的能力不一致和 codex 双进程隐患，并消掉约 440 行易冲突差异（`codex-app-server.client.ts` 与上游清零）。

实施顺序：
1. 先实测 zcode 文本 `/compact` 与 antigravity；
2. 一个 PR 删除触发通道、回退 zcode 骨架、改写文档；
3. 上下文占用增强原样保留，另向上游提 claude `compact_boundary` 实时读数的小 PR；opencode 的 `purpose` 那 1 行视上游态度去留。
