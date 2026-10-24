# ADR：子代理取消归因与验收证据边界

- 日期：2026-10-24
- 状态：契约冻结，实施与验证结果单独记录。新进程端到端验收不由编译结果替代。
- 范围：取消来源可观测性、真实补测记录和工具语义澄清；不改调度、权限或业务验收算法。

## 背景

E2E A7 及后续只读补测在父代理 cancel 到达前已经 cancelled，返回 already_terminal。中断文案和终态无法证明首次取消来自工具、父停止、子会话停止、UI 或删除；不能根据这些旧记录倒推发起者。运行正常结束、验收清单满足和业务事实正确是三个不同结论。

## 冻结契约

1. outcome version 保持 1。SubAgentRunRecord、SubAgentOutcome、SubAgentCancelReceipt 兼容增加可选 cancellation：`{ source, requestedAt }`。source 枚举为 `cancel_tool | parent_stop | conversation_stop | ui_cancel | deletion | runtime_abort | unspecified`。requestedAt 是 Rust 持久层首次受理取消时记录的 UTC epoch milliseconds，不是 UI 点击时间；调用者不能提供它。缺失字段表示未记录，不能补造。
2. 内部 cancel command 可传可选 source，缺省为 unspecified；公共模型工具 cancel 仍只接受 runId，来源由宿主调用分支提供。主进程与 Rust 拒绝非法来源，不以任意字符串记录来源，不将它作为授权凭据。
3. 第一次成功受理取消的来源胜出。queued 直接终结与 running/waiting_input 改为 cancelling 时，状态与来源同事务写入；已 cancelling 的重试不更新来源或时间，旧 cancelling 缺少字段也不由迟到请求认领。finalizing 的 too_late 与任意终态的 already_terminal 不新增或改写 cancellation。
4. 删除入口直接改变状态，必须单独记录 deletion。资源停止和取消 observer 只执行既有取消，不成为新来源。父停止与子会话自身停止按实际目标身份分类；UI resolver 标 ui_cancel；工具执行分支标 cancel_tool；finalizer 仅观察到未归因 abort 时标 runtime_abort，不声称它一定来自用户。
5. 原生 run 记录是权威事实；finish/settle/generated outcome 统一使用持久 cancellation，不允许 renderer 提供的 outcome 覆盖或凭空添加来源。恢复仍为 interrupted，不伪装取消；历史没有字段时保持缺失。get/wait、同步最终结果和自动事件携带同一元数据。
6. 宿主取消处理日志记录 disposition、runStatus 和权威 cancellation；renderer runSettled 显式投影安全来源与时间。不得写入完整 prompt、原始工具内容或凭据。UI 不增加新卡片或列表，本轮可观测入口为工具结果和日志。
7. 不迁移数据库、不改状态边、不新增依赖、不操作真实数据库、不重启/安装、不执行 Git、不创建测试文件；用隔离内存探针和现有检查验证。重启、跨窗口和删除实测需用户配合。

## 验收与摘要边界

- acceptance 当前只校验证据 ID 是否出自该子会话记录，不独立判断自然语言条目与工具内容的语义相关性，也不保证成功业务操作。主代理必须核对工具状态和直接相关内容；同一真实证据支持多个相关条目是合法的。
- 本轮不以关键词、文件名或额外模型猜测替代确定性业务验收，不擅自引入语义验收服务。隔离负向探针可暴露此限制，但不能作为真实任务通过记录。
- summary 是末轮最终文本，不是完整会话逐轮转录；中间工具/报告应在子会话查看，不能把缺失的前几轮直接判为存储截断。分页使用 Unicode 字符 offset，不代表分轮历史。
- wait(any/all) 都返回所有请求 run 的快照。any 的成功条件是至少一个终态，all 为全部终态；timedOut 不取消任务。不能用 results 数量推断 any/all 是否正确。
- message_queued 只证明补充消息入队；运行事件的 deliveryStatus=received 只证明结果持久合入父输入，均不证明模型已理解消息。
- 两个不同 activate 创建两个独立子会话，不构成 RUN_BUSY 测试。RUN_BUSY 是同一目标已有运行时的冲突边界，忙碌 continue 应返回 message_queued。

## 验证与剩余边界

实施后检查首次来源保留、queued/running/删除取消、late cancel 不归因、旧记录、权威 outcome、非法来源、日志脱敏；复用已有 TypeScript/Rust 构建、格式和文档守卫。受控在线探针与隔离源码探针必须分别标注。现有运行实例不会因文件修改自动加载新 Rust/renderer；新字段真实 UI/IPC 验收需重新加载后另行执行。
