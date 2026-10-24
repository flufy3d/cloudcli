# Claude 账号显示

> 基准：2.10.0 / 2026-10-19

设置中的 Claude 账号页在检测到订阅登录时显示「登录为」和账号邮箱。例如，凭证文件没有邮箱、`~/.claude.json` 的 `oauthAccount.emailAddress` 为 `reader@example.com` 时，账号页显示「登录为 reader@example.com」。凭证文件已有邮箱时优先使用凭证文件的邮箱。

邮箱元数据只补充显示信息，不能证明登录有效。没有订阅凭证时，即使配置里保留邮箱，账号页也不显示为已登录。配置缺失、损坏或邮箱不是非空字符串时，使用现有的已认证占位文字；读取失败与 JSON 损坏会记录不含配置内容的警告。

配置邮箱是本地账号标签，不是向 Claude 服务实时核验的身份。订阅凭证没有邮箱时，CloudCLI 无法核对配置邮箱是否属于当前凭证；切换账号后若配置仍保留旧邮箱，账号页也会显示旧邮箱。

API Key 和独立 OAuth Token 保留各自的认证方式标签，不使用本地订阅邮箱代替。API Key 覆盖订阅登录时，覆盖提示中的订阅账号使用同一套邮箱读取规则。

实现与验证以 `server/modules/providers/list/claude/claude-auth.provider.ts` 和 `server/modules/providers/tests/claude-auth.test.ts` 为准。
