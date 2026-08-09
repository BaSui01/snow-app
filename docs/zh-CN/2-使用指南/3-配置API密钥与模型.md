# 3-配置API密钥与模型

Snow App 通过 **API 档案（Profile）** 管理模型服务商的接入信息，
支持多档案并存与一键切换。本文介绍如何在图形界面配置 API 密钥与模型，
以及对应的配置文件位置。

## 1. 认识配置入口

| 入口 | 说明 |
| --- | --- |
| 设置 → API 设置（设置页 id：`api-settings`） | 图形界面：新建/编辑/切换 API 档案 |
| 应用数据库 `api_configs` 表 | **多档案的权威存储**，每行一个档案（`profile_name` 唯一标识） |
| `~/.snow/active-profile.json` 的 `activeProfile` 字段 | 记录**当前生效的档案名**；生效配置 = `api_configs` 中该档案 |
| `~/.snow/config.json` 的 `snowcfg` 字段 | 与 Snow CLI 共享的兼容层/快照，**不是**档案的权威来源 |

> **存储机制速记**：多档案列表存在应用数据库 `api_configs` 表，当前生效档案由
> `activeProfile` 指定。`config` 工具与 UI 读写的是**当前生效档案**；
> `config.json` 中的 `snowcfg` 只是当前档案的 CLI 兼容镜像。

## 2. 图形界面配置（多档案）

打开 **设置 → API 设置**，可以新建多个档案。新建档案需填写：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| 档案名（Profile name） | 是 | 档案的唯一标识，如 `openai` |
| 显示名（Display name） | 否 | 界面中展示的名称，缺省取档案名 |
| Base URL | 是 | 服务端点地址 |
| Base URL 模式 | 是 | `auto` 自动 / `custom` 手动 |
| API Key | 是 | 服务商密钥，如 `sk-...` |
| 请求方法（Request method） | 是 | 如 `chat` |
| 高级模型（Advanced model） | 是 | 复杂任务使用的模型 |
| 基础模型（Basic model） | 是 | 轻量任务使用的模型 |
| 视觉模型（Vision model） | 否 | 图像理解模型，可单独配置 |

模型输入框聚焦时会自动从当前 Base URL 拉取可用模型列表，也可手动填写。

### 视觉模型独立配置

当主模型不支持视觉时，关闭 **Supports vision** 开关，可单独配置
`visionBaseUrl`、`visionApiKey`、`visionRequestMethod`、`visionModel`，
使图像理解请求走独立的服务端点与密钥。
图片会被文本化为文字描述供主模型理解；同时每条**用户消息**中的图片会
附带 `[Reference image #N ...]` 引用（仅含 upload 目录相对路径），
**图生图时仍使用原始图片**，不会被降级为文生图（见
[9-图像生成](9-图像生成.md)）。

### 可选配置

- **系统提示词**：从已保存的系统提示词中选择，也可继承全局档案设置；
- **自定义请求头方案**：选择 `custom-headers.json` 中定义的 scheme，
  可选"继承全局"或"不使用"；
- **自动压缩**：开启 `enableAutoCompress` 后，当上下文用量达到阈值
  `autoCompressThreshold`（百分比）时自动压缩历史消息；
- **Google 搜索（Gemini）**：开启 `googleSearch` 后，Gemini 聊天请求会注入
  Google Search 工具实现实时联网接地（Grounding with Google Search）；
  视觉模型独立配置区另有 `visionGoogleSearch` 开关，可单独控制视觉请求；
- **Responses Fast Mode**：当请求方法为 `responses` 时，可开启
  `responsesFastMode` 快速模式，让服务端以快速模式处理响应式请求。

表单会按请求方法校验字段：切换请求方法时，不适用于该方法的字段会被
重置或跳过（如思考强度、Responses 专属选项），避免提交无效组合。

以上字段保存为该档案在应用数据库 `api_configs` 表中的一条记录；
当前生效档案的副本同步到 `~/.snow/config.json` 的 `snowcfg` 字段，与 Snow CLI 共享。

## 3. 多档案切换

在 API 设置中切换 **Enable profile** 开关即可切换当前生效档案；
当前档案名记录在 `~/.snow/active-profile.json` 的 `activeProfile` 字段。
Agent 也可用 config 工具直接切换（见 [5.1 ④](#51-常用操作速查agent-照着做)）。

## 4. 高级选项

部分高级参数可在 UI 的 Runtime 区域配置（如最大上下文、最大生成
token、流式空闲超时、重试次数与延迟），其余参数可直接编辑
`~/.snow/config.json` 的 `snowcfg` 字段：

| 字段 | 说明 |
| --- | --- |
| `maxContextTokens` | 最大上下文 token 数 |
| `maxTokens` | 单次生成最大 token 数 |
| `streamIdleTimeoutSec` | 流式响应空闲超时（秒） |
| `maxRetries` | 请求最大重试次数 |
| `retryDelayMs` | 重试间隔（毫秒） |
| `showThinking` | 是否展示思考过程 |
| `chatThinking.reasoning_effort` | 思考强度（如 `max`） |
| `toolResultTokenLimit` | 工具结果写入上下文的 token 上限 |

> **提示**：直接编辑 `config.json` 后需重启应用使改动生效。

## 5. AI / 命令行配置（config 工具）

Snow App 内置 `config` 工具，AI Agent 可读写与 UI 同源的配置——
**`snowcfg` 域操作的就是当前生效档案**：

| 工具 | 用途 |
| --- | --- |
| `config-list scope=snowcfg` | 查看当前生效档案的全部配置与键 |
| `config-get scope=snowcfg key=baseUrl` | 读取单个键（`apiKey` 自动脱敏，如 `sk-****abcd`） |
| `config-set scope=snowcfg key=baseUrl value="..."` | 写入单个键（白名单 + 类型校验 + 自动备份 + 原子写） |
| `config-set scope=app key=activeProfile value="档案名"` | 切换当前生效档案（写 `active-profile.json`） |

### 5.1 常用操作速查（Agent 照着做）

#### ① 查看当前生效档案

```
config-list scope=snowcfg   # 当前档案的完整配置（apiKey 脱敏）
config-list scope=app       # 查看 activeProfile = 当前档案名
```

#### ② 修改密钥

```
config-set scope=snowcfg key=apiKey value="sk-新密钥"
```

注意：`apiKey`/`visionApiKey` 读取时一律脱敏，**不要向用户索要或展示明文密钥**；
密钥由用户提供后写入，写入自动备份到 `~/.snow/.config-backups/`。

#### ③ 修改模型

```
config-set scope=snowcfg key=advancedModel value="新模型"   # 高级模型
config-set scope=snowcfg key=basicModel value="新模型"      # 基础模型
config-set scope=snowcfg key=visionModel value="新模型"     # 视觉模型（单独配置时）
```

也可一次更新多个字段（不传 key 时按对象写入）：

```jsonc
config-set scope=snowcfg value={
  "advancedModel": "gpt-4o",
  "maxTokens": 8192,
  "showThinking": true
}
```

#### ④ 切换档案

```
config-set scope=app key=activeProfile value="档案名"
```

- 档案名必须是已存在的 profile（应用数据库 `api_configs.profile_name`）；
- Agent 无法枚举档案列表时，先 `config-list scope=app` 查看当前值，
  再让用户在 **设置 → API 设置** 里确认可用的档案名；
- 切换后为文件型配置，**重启应用或 UI 重存**后完全生效。

#### ⑤ 新建档案（仅 UI，Agent 引导）

config 工具目前**不能**直接新建档案；Agent 应帮用户打开设置页：

```
app-control-openSettings page=api-settings
```

引导用户填写：档案名（唯一标识）、显示名、Base URL（+ 模式）、API Key、
请求方法、高级模型、基础模型、视觉模型（可选）等字段。保存后档案即出现在
`api_configs` 中，可在 API 设置里用 **Enable profile** 开关切换。

### 5.2 生效方式

`snowcfg`/`app` 为文件型配置，写入后**可能需要重启应用或重新保存
UI 设置**生效；`apiKey`/`visionApiKey` 读取一律脱敏，**不要向用户索要或
展示明文密钥**；每次写入自动备份到 `~/.snow/.config-backups/`。

## 6. 常见问题

| 症状 | 原因与处理 |
| --- | --- |
| 请求返回 401/403 | 检查 `apiKey` 与 `baseUrl` 是否正确、密钥是否过期 |
| 模型不支持思考 | 关闭 `showThinking` 或调整 `chatThinking.reasoning_effort` |
| 视觉模型不可用 | 单独配置 `visionBaseUrl`、`visionApiKey`、`visionModel` |
| 切换档案不生效 | 确认 `active-profile.json` 中 `activeProfile` 的值 |

## 6. 参考

- 字段完整说明：[3-参考手册/1-settings.json配置参考](../3-参考手册/1-settings.json配置参考.md)
