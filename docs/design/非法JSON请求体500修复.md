# 非法 JSON 请求体 500 修复

状态：已实施（本文件为唯一进度记录处）

## 目标

请求体不是合法 JSON 时，API 返回 400 并说明原因，而不是 500 `INTERNAL_ERROR`。典型触发场景：手写 `POST /api/agent` 请求体把 Windows 路径写成 `"E:\Projects\SRU"`——`\P`、`\S` 不是合法 JSON 转义；同一个路径写成 `"E:/Projects/SRU"` 则正常。

## 根因

`express.json()` 的 body-parser 解析失败时抛出 `SyntaxError`，并带有 `statusCode: 400` 与 `type: 'entity.parse.failed'`。`server/index.ts` 的全局错误中间件只识别 `AppError`，其余错误一律映射为 500，于是把客户端输入错误报成服务端故障，并把解析堆栈写进错误日志。

## 方案

新增 `server/error-response.ts` 的 `createErrorResponse(error)`，统一生成全局错误中间件使用的状态码与响应体：

- `AppError` 保留原有 status/code/details。
- 其它自带 4xx `statusCode` 的错误保留该状态；其中 `entity.parse.failed` 映射为 400 `INVALID_JSON_BODY`，message 提示 Windows 路径应写成 `E:\\Projects\\SRU` 或改用正斜杠，解析器的位置信息放入 details。
- 其余错误仍为 500 `INTERNAL_ERROR`，不泄露内部信息。
- `server/index.ts` 改用该函数，并只在 5xx 时输出错误日志。

不尝试“修复”非法 JSON：容忍裸反斜杠会引入不确定的转义语义，合法 JSON 客户端（`JSON.stringify`）本来就应发送双反斜杠。

## 验证

- `server/error-response.test.ts`：`AppError` 原样映射；非法 JSON → 400 且带转义提示；413/aborted 保留自身状态；未知错误 → 500 且不泄露消息。
- `npx tsx --tsconfig server/tsconfig.json --test server/error-response.test.ts`
- `npx tsc --noEmit -p server/tsconfig.json`
- `npx oxlint server/error-response.ts server/error-response.test.ts server/index.ts`

## 风险

- 只改变错误响应映射，不影响成功路径；4xx 不再写 error 日志，避免客户端输入污染日志。
- 合法的 Windows 路径（`"E:\\Projects\\SRU"`）行为不变，仍能正常注册项目和启动会话。
- 其它带 4xx `statusCode` 的非 `AppError` 错误此前也被误报为 500，现在按真实状态返回；错误 message 来自已有错误对象，不新增内部细节暴露。

## 关联

- 现象来自手写 HTTP 请求；cloudcli 的 UI 与 SDK 通过 `JSON.stringify` 发送，不受影响。
