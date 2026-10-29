# README 视觉素材

本目录存放 README 使用的图片素材。所有素材都由 `source/` 下的脚本生成，可随时重建。

## 目录结构

| 路径                                | 用途                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- |
| `zh/hero.png`、`en/hero.png`        | 顶部横幅：像素字标、一句话定位与平台信息（SVG 排版 + 应用真实图标） |
| `zh/features-workspace.svg`         | 功能板一：工作区面板（对话、终端、SSH、Git、浏览器、文件、检索、任务管理器） |
| `zh/features-agent.svg`             | 功能板二：Agent 与协作（Skills、MCP、子代理、Hooks、Goal、定时任务与工作流、项目记忆、团队协作） |
| `zh/features-extend.svg`            | 功能板三：扩展与内容（插件与市场、用户脚本、自定义命令、请求代理层、仓库 Wiki、绘图工作台、图像库、LSP） |
| `zh/features-security.svg`          | 功能板四：安全与体验（应用锁、工具授权、隐私脱敏、检查点与回滚、用量与日志、主题、手机远控、桌面宠物） |
| `zh/before-after.svg`               | 从分散工具到一个工作区的概念对比图                                   |
| `en/…`                              | 以上素材的英文版本（文件名一致）                                     |
| `screenshots/desktop-annotated.png` | 主界面截图与中文三栏标注                                             |
| `screenshots/desktop-annotated.en.png` | 同一张主界面截图的英文三栏标注                                    |
| `screenshots/mobile-pair.png`       | 手机远控截图并排（中英文 README 共用）                               |
| `source/`                           | 生成脚本、Lucide 图标与调色板定义                                    |

## 功能文案的依据

功能板上的名称与描述不是凭印象写的，逐项对得上仓库里的实现与文档：

- 能力清单与源码锚点：`docs/FEATURE_COVERAGE.md`（功能文档覆盖审计矩阵）。
- 设置页清单（25 个）：`src/renderer/components/sidebar/settingsItems.ts`。
- 面板与组件入口：`src/renderer/components/`（`sidebar/`、`rightPanel/`、`mainContent/`、`TopBar/`、`repoWiki/`）。
- 界面用词：`src/renderer/i18n/lang/zh-CN.ts`（例如「绘图工作台」「应用锁」「个性化与规则」）。
- 使用指南（26 篇）：`docs/zh-CN/2-使用指南/` 与 `docs/en/2-guides/`。

## 设计规范

- 调色板取自应用自身的设计令牌：`src/renderer/themes/tokens.css`（浅色主题）与应用图标 `resources/icon.png`
  （品牌雪蓝 `#73AFD1`、主文字 `#0B1220`、分隔线 `#E5E7EB`、面板底 `#F5F7F9`、强调蓝 `#3B82F6`）。
- 字体使用系统字体栈（`-apple-system` / `Segoe UI` / `PingFang SC` / `Microsoft YaHei`）与等宽字体栈，
  与 `tokens.css` 中的 `--font-sans`、`--font-mono` 一致。
- 卡片圆角 14、板面圆角 18，与应用 `--radius-sm/md/lg` 体系同一手感。
- 图标统一使用 [Lucide](https://lucide.dev)（`source/icons/`），与项目依赖 `lucide-react` 同源；Lucide 采用 ISC 许可。
- 所有 SVG 自带浅色底，在 GitHub 亮色与暗色主题下均可读；图中的关键信息同时出现在 README 正文与 `alt` 中。
- 卡片标题按名称长度自适应字号（25 / 22 / 20），避免英文长名称压到卡片边缘。

## 版本号

`hero.png` 上的版本号在生成时从 `package.json` 的 `version` 字段读取，不写死在脚本或图片里；
README 顶部的 release 徽章由 shields.io 实时拉取 GitHub Release，因此日常不需要重建素材。
发版后如果想刷新横幅上的版本，重跑 `build_hero.py` 即可。

## 重新生成

```bash
cd assets/readme/source

python build_features.py zh        # 四张功能板 + 前后对比图（中文）
python build_features.py en        # 英文版本
python build_hero.py zh en         # 顶部横幅（需要本机 Chrome 渲染）
python build_screenshots.py <主界面截图路径>          # 中英标注图 + 手机并排图
python build_screenshots.py <主界面截图路径> zh        # 只生成中文标注图
```

说明：

- 需要 Python 3 与 Pillow；`build_hero.py` 通过无头 Chrome 把布局 SVG 渲染为 2 倍图 PNG
  （SVG 内的位图引用在 GitHub 上不可靠，因此只发布 PNG）。每次渲染使用独立的 Chrome profile，
  避免连续渲染时出现半张未绘制的截图。
- `build_screenshots.py` 需要传入主界面截图：仓库不保存该源图，可由作者自行截屏，
  或使用 README 中链接的 GitHub 附件原图。手机截图从 `docs/images/` 读取。
- `screenshots/desktop-annotated*.png` 的三栏标注坐标基于 3050×2116 的参考截图，
  更换截图尺寸时需同步调整 `build_screenshots.py` 中的 `LANES` 常量。
