# ADR：异步生图任务生命周期与交付闭环

- 日期：2026-10-15
- 状态：已实施；真实渠道与 UI 验收需同时加载本次新产物。
- 范围：Rust 生图任务、SQLite 持久化、Electron IPC/preload、聊天画廊与批次通知。

## 背景

工具调用返回 pending 是受理确认，不是任务终态。现有 preload 在 invoke.finally 删除回调，导致晚到 completed/failed 被丢弃；React updater 内的唤醒副作用、仅内存结果及提交级限流进一步破坏幂等、历史恢复和真实并发。图库记录只证明图片资源存在，不证明聊天完成交付。

## 决策

1. SQLite 新增独立的 image_generation_batches 与 image_generation_tasks，原图库索引不充当任务状态。新字段时间统一 UTC RFC3339 带 Z；不迁移既有日志时间契约。
2. 任务 ID 使用现有 UUID 依赖；任务状态为 registered、queued、running、completed、failed、cancelled。异步标志 asynchronous 区分提交回执与同步结果。
3. 主会话执行器在本批调用前注册获准且参数合法的生图成员，成员用 interactionId 与 callId 双重锚定。batchId 由运行时生成，不接受模型控制。执行器 finally 封口批次：尚未提交的 registered 成员取消，queued/running 不取消。全部成员终态且批次封口后才产生汇总通知资格。
4. runtime 元数据由主进程覆盖注入到保留的 __snowImageGeneration 字段：conversationId、interactionId；Rust 分发层再次以真正的 conversation_id 覆盖会话归属。模型不得选取任务归属。未注册的直调创建独立任务，空会话不触发主会话通知。
5. 完整终态 resultJson 是持久事实来源。终态先落库，再发 chunk。结果不写 API Key、请求头或渠道凭据；错误统一脱敏，默认日志不记录 prompt。对模型可见文本复用工具隐私遮罩，路由 ID 与图片引用不可被自由文本遮罩破坏。
6. 保留现有 stream=imagegen 的 partial_image 以及 completed/failed 事件；增加任务归属字段。preload 以实际返回 pending 判定后台订阅，保留到终态；处理终态早于 invoke 回执的竞态；失败/同步返回即时清理。回调资源有实际任务预算截止和窗口卸载回收，不伪造进度。
7. 回调不是唯一恢复通道。提供按会话列出批次以及按 taskId 精确查询接口；刷新、切回会话和历史加载时关联 pending taskId 或 interactionId/callId 恢复最终结果，不凭临时 assistantMessageId 决定任务是否可消费。新进程启动时未结束的旧进程任务转明确失败，不自动重复付费生成。
8. React updater 必须纯计算。任务消费、去重、持久通知声明和消息调度在 updater 外执行；每图终态立即替换原格子，成功和失败均计数。批次通知不使用首图延时窗口；全部终态后只生成一条本地化汇总。
9. 通知声明使用 SQLite 原子 claim，按 conversationId+batchId 隔离；发送被拒绝时释放声明。正常运行防重复消费、重复唤醒；通知的队列接收与真正发出须分别留痕，不把仅入队称为用户已收到。跨进程崩溃恢复不承诺对外模型调用严格 exactly-once。
10. maxConcurrentImages 在 Rust 实际上游生成请求处统一执行，许可持有到请求终态（含流式/下载/结果收尾），async pending 不释放。单调用 legacy 多图也逐实际图片请求计数。前端仅限制提交调度并修复补位循环排空队列问题。
11. 日志区分受理、开始、生成终态、回调入队、IPC 转发、前端消费与批次通知。context 必须包含 conversation_id、taskId、batchId 等标识，不记录提示词正文与凭据。日志失败不得覆盖图片结果，但状态持久化失败必须以失败终态显式处理。
12. 使用现有依赖与共享 TypeScript 契约，不新增业务 CSS、内联样式、Hex 色值、测试文件或 Mock 服务。手写模块必须低于 120KB。

## 共享 API（JSON 为 NAPI 边界编码）

- registerImageGenerationBatch(registrationJson: string): Promise<string> -> ImageGenerationBatchSnapshot
- sealImageGenerationBatch(conversationId: string, batchId: string): Promise<string> -> ImageGenerationBatchSnapshot
- listImageGenerationBatches(conversationId: string): Promise<string> -> ImageGenerationBatchSnapshot[]
- getImageGenerationTask(conversationId: string, taskId: string): Promise<string> -> ImageGenerationTaskSnapshot | null
- claimImageGenerationBatchNotification(conversationId: string, batchId: string): Promise<boolean>
- releaseImageGenerationBatchNotification(conversationId: string, batchId: string): Promise<void>

注册对象：{ conversationId, batchId, members: [{ interactionId, callId }] }。批次快照：{ batchId, conversationId, sealed, notified, tasks }。任务快照：{ taskId, conversationId, batchId, interactionId, callId, status, asynchronous, resultJson, createdAt, updatedAt, durationMs }。resultJson 为完整标准生图结果 JSON（无结果时空字符串）。

## 验收

编译 cargo check、TypeScript 与 Electron 生产构建；代码守卫验证唯一共享契约、无测试/Mock/凭据新增及模块大小。运行验证必须区分：pending 后会话可结束；每格完成独立更新；批次全终态只汇总一次；历史恢复不再永久 loading；失败有终态；限流覆盖后台真实请求。若当前运行实例尚未加载新 native/preload/renderer，不能以该旧实例结果宣称通过。
