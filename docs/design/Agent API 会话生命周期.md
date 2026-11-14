# Agent API 会话生命周期

> 状态：已完成。abort、状态查询、`sessionId` 单独续聊；不做回合中插话
> 基准：2.21.0 / 2026-11-14

## 目标与范围

`POST /api/agent` 目前只能启动一轮 run：调用方拿不到停止入口，也不能只凭 `sessionId` 继续会话，断线后无法查询 run 是否还在跑。本方案补齐运维所需的三个能力：

- `POST /api/agent/:sessionId/abort`：停止正在跑的 run；没有活动 run 时幂等返回。
- `GET /api/agent/:sessionId`：查询会话所在的 provider、项目、run 状态和最近事件序号。
- `POST /api/agent` 允许只传 `sessionId`：项目路径和 provider 从会话行推断，不再强制重复传 `projectPath`。

不在范围内：回合进行中插话（所有 provider 都没有 `injectInput` 实现，产品本身也是排队）、断线后的完整事件重放、后台子任务逐个停止。

## 方案

### abort

路由复用聊天网关已有的停止路径，不新造运行时能力：

1. 用应用会话 id 或 provider 原生 id 解析会话行，未知会话返回 404。
2. `chatRunRegistry.getRun()` 命中 running run 时调用 `runtime.abort(provider, sessionId)`，成功后用 `completeRunIfCurrent(run, { aborted: true, reason: 'client_abort' })` 发出终止帧。
3. 没有 running run 但 `runtime.hasBackgroundWork(sessionId)` 为真时，同样转给 `runtime.abort`，与 UI 的 `chat.abort` 一致。
4. 两者都没有时返回 `200 { success: true, aborted: false }`，让重试安全；provider 拒绝停止返回 409。

原本还在等待的 `POST /api/agent` 会照常收到终止帧：流式响应发 `status: Run aborted`，非流式响应返回 `{ success: false, aborted: true }`，分支/PR 不会执行。

### 状态查询

`GET /api/agent/:sessionId` 返回：

```json
{
  "success": true,
  "sessionId": "app-...",
  "provider": "claude",
  "providerSessionId": "native-...",
  "projectPath": "/path/to/project",
  "name": "会话名",
  "archived": false,
  "status": "running | background | idle",
  "run": { "startedAt": "2026-11-14T...Z", "lastSeq": 12 },
  "createdAt": "2026-11-14T...Z",
  "updatedAt": "2026-11-14T...Z"
}
```

`run` 仅在 `status: running` 时有值。查询同样接受 provider 原生 id。

### sessionId 单独续聊

`sessionId` 与 `githubUrl`/`projectPath` 都不传时返回 400。只传 `sessionId` 时用会话行的 `project_path` 作为工作目录；会话没有项目路径则返回 400。传了 `projectPath` 时仍按原逻辑校验它与会话行一致。

## 验证

- `server/modules/agent/tests/agent-run-registration.test.ts` 增加：abort 终止 held run 且原响应报告 aborted；无活动 run 幂等；未知会话 404；状态查询 running/idle；`sessionId` 单独续聊。
- 运行 `npx tsx --tsconfig server/tsconfig.json --test server/modules/agent/tests/agent-run-registration.test.ts`。
- 运行 `npx tsc --noEmit -p server/tsconfig.json` 和 `npx oxlint server/modules/agent`。

实施后结果：agent 两个测试文件 30 项全部通过；server typecheck 通过；`npm run build:server` 通过；`oxlint` 只剩既有的 `no-async-promise-executor` 警告。

## 风险与边界

- abort 与 run 自然结束存在竞态：`completeRunIfCurrent` 只终止当前 run，不会误杀同会话的后继 run；provider 已自行发终止帧时该调用为 no-op。
- 断开的 SSE 连接不会阻止 run 继续；本次只补状态查询和主动 abort，不承诺断线续传。
- 现有会话表没有用户归属，API key 的权限边界与当前续聊接口一致（单用户/自托管假设）。
