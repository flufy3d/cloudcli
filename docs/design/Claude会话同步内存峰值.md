# Claude 会话同步内存峰值

> 状态：已完成代码、定向测试、typecheck、lint 与 server 构建；未部署
> 基准：2.21.0 / 2026-11-16

## 现场

2026-11-16 11:23:47，PM2 以 `current_memory=1,446,461,440 > max_memory_limit=1,073,741,824` 重启 cloudcli。目标会话 `7aab0903-a500-41e2-9f6d-be2d06bf7419` 的转录最后一条是 11:23:32 的 `Bash` tool_use（`timeout: 600000`），之后没有 tool_result；重启把引擎进程树一起杀死，页面只能停在等待状态。这不是模型没返回，而是宿主进程在回合中被内存上限杀掉。

## 原因

Claude 的三个回读入口都把整份 JSONL 读成字符串再 `split` / `JSON.parse`：

- `claude-session-synchronizer.provider.ts` 的 `scanTranscript`：每次 watcher 触发同步都要扫描整份转录。
- `claude-sessions.provider.ts` 的 `/token-usage`：`parseClaudeTranscriptEntries` 读取整份文件。
- `claude-models.provider.ts` 的当前模型回读：同样先读整份文件再从后往前匹配。

目标转录为 133 MB。实测整份读取一次峰值 452 MB，连续 5 次在 452 / 936 MB 之间摆动；watcher 以 6 秒间隔轮询，转录每次追加都会触发一次全量扫描。打开会话时 `/token-usage` 与 watcher 扫描可能同时发生，峰值超过 1 GB，PM2 随即终止进程。

## 方案

三个读取点统一改为 `readJsonlRecords` 流式逐行读取，只保留所需字段：

- 标题与最近活动时间：保留最后一个 `custom-title` / `ai-title` / `last-prompt` 和最新记录时间。
- token usage：只收集 `assistant` 行的 usage/model 与 `system` / `compact_boundary` 行，再交给现有 `summarizeClaudeTokenUsage`。
- 当前模型：流式读取并保留最后一个匹配的模型事件。

解析结果、接口和数据库结构均不变。

## 验证

- 复用 `server/modules/providers/tests/claude-sessions.test.ts` 中标题、活动时间与 usage 的回归用例。
- 增加大体积转录用例：尾部包含大 tool result 时仍能同步标题与最近活动时间，token usage 仍取最后一条 assistant 或压缩边界。
- 运行 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-sessions.test.ts`、`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-models.test.ts`、`npx tsc --noEmit -p server/tsconfig.json`、`npx oxlint <改动文件>`、`npm run build:server`。
- 现场 133 MB 文件只读探针（同一进程）：整份读取每次峰值 452 MB，连续 5 次在 452 / 936 MB 之间摆动；改后 `synchronizeFile` 峰值 218 MB、`/token-usage` 峰值 298 MB，基线 130 MB，均只读同一份转录。
- 定向结果：`claude-sessions.test.ts` 67 项、`claude-models.test.ts` 17 项全部通过；typecheck、lint 和 server 构建通过。

## 风险与边界

- 流式解析顺序与原先相同，坏行仍被跳过。
- 不调整 PM2 内存上限；部署与重启仍由用户执行。
- 历史读取本身仍会加载转录中的消息，属于另一条既有边界，本次不改。
