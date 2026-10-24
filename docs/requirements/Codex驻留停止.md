# Codex 驻留停止

> 基准：2.10.0 / 2026-10-20

用户停止尚未开始的排队消息时，只有引擎明确确认删除，页面才把这条输入视为已撤销。输入已经开始时，停止针对这条输入所属的回合，不能中断后来开始的回合。

如果宿主无法确认排队输入是否已经执行，宿主强制结束所属会话进程。已开始回合的中断请求被拒绝，或确认期限内没有收到真实终态时，同样强制结束所属进程。重复停止共用一次操作，已经确认的终态会取消本轮的强退计时器，不能影响下一轮。结果保持状态不明，不能改报已中断或成功撤销。错误提示说明无法确认执行情况、所属进程和后台子代理已经停止，用户应先检查执行结果再重试。独立异步任务可能仍在运行，不能把会话进程结束说成所有任务已经取消。

运行时的对应提示是：`Codex could not confirm whether the queued message ran. Its conversation process and background agents were force-stopped. Check the results before retrying; independent tasks may still be running.`

已开始回合的中断无法确认时，提示是：`Codex could not confirm that this turn stopped. Its conversation process and background agents were force-stopped. Check the results before retrying; independent tasks may still be running.`

强制退出不能撤回已经写入的文件或外部副作用。是否允许会话归档与资源回收，以[驻留架构](../core/providers.md)中的完整活动判断为准。
