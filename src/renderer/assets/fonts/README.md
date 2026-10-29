# 内置字体

随应用打包的字体，离线可用，供「设置 > 主题 > 字体」里的内置字体预设使用。
`src/renderer/themes/bundled-fonts.css` 负责声明 `@font-face`。

| 文件                          | 字体族          | 说明                                         | 授权                                   |
| ----------------------------- | --------------- | -------------------------------------------- | -------------------------------------- |
| `ZCOOLXiaoWei-Regular.ttf`    | `ZCOOL XiaoWei` | 站酷小薇体，纤细清秀的宋楷风格中文（含西文） | SIL OFL 1.1，见 `OFL-ZCOOLXiaoWei.txt` |
| `jost-latin-300-normal.woff2` | `Jost Light`    | Jost Light，纤细的几何无衬线西文             | SIL OFL 1.1，见 `OFL-Jost.txt`         |

## 来源

- ZCOOL XiaoWei：<https://github.com/googlefonts/zcool-xiaowei>（Google Fonts `ofl/zcoolxiaowei`）
- Jost：<https://github.com/indestructible-type/Jost>（`@fontsource/jost` 的 latin 300 woff2）

两者均为 SIL Open Font License 1.1 授权，允许随软件打包与再分发，许可证原文见同目录的两个 `OFL-*.txt`。

## 注意

- 字体族名（`ZCOOL XiaoWei` / `Jost Light`）是预设里引用的名字，改名需同步修改 `bundled-fonts.css` 与字体预设。
- 内置字体只在用户显式选择对应预设时生效，不改变默认字体栈。
