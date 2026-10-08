# Markdown 与源码编辑实测（2026-10-07）

本次沿 Markdown 导入 → shared 结构 → Y.Doc → 正文编辑 → 阅读投影检查，补齐 CommonMark/GFM 结构、允许的 HTML、数学公式、Mermaid 和库内笔记链接。源码模式收紧标题和元信息，使用完整宽度、语法颜色、活动行、可切换行号/换行、查找替换及光标位置。

## 自动验证

- shared：`note-markdown`、`note-doc-schema`、`note-annotation-anchor`，31 项通过。覆盖嵌套任务、标题级别、代码语言、HTML 清理、引用式徽章、Wiki 别名与转义、批注文本。
- API：`markdown-parser`、`doc-fragment`，34 项通过。覆盖原文区间、真实 CRDT 快照与来源属性。简单无序列表的投影仍存项目文本，Markdown 标记在解析时消费；相关断言同步这一口径。
- desktop：笔记域、阅读结构、正文状态、样式及 HTML sink 守卫，37 个文件、258 项通过。覆盖真实 Milkdown/CodeMirror/Y.Doc 切换、撤销、重开、链接图片与库内导航失败。
- shared、api、desktop-client、ai-worker 各自 `npm run typecheck` 通过；desktop `npm run build` 通过。

## 窗口交互

使用 Codex 内置浏览器运行正式 `NotebookDesk`、`NoteDocumentEditor`、`ReadingBlock` 和项目样式的本地预览，数据为内存 Y.Doc 与示例 IPC，没有修改真实笔记。

确认了源码连续输入、编辑/源码快速往返、撤销、查找定位与单次替换、库内笔记选择并插入、标题锚点定位、Wiki 链接打开，以及默认视口与 1040 × 700 视口布局。

真实 Mermaid 渲染曾暴露 SVG 图片解码与放大尺寸问题，已改为顶层 `htmlLabels: false`，并从 viewBox 提供图片固有尺寸，复核中文多行节点、内联图及灯箱。顶层配置行为依据 [Mermaid 官方说明](https://mermaid.js.org/config/schema-docs/config-properties-htmllabels.html)。

截图：[源码界面](/Users/asklins/.codex/visualizations/2026/10/07/01a11698-acb5-7250-97a1-81c504c086b2/note-source-after.jpg)、[Mermaid 放大](/Users/asklins/.codex/visualizations/2026/10/07/01a11698-acb5-7250-97a1-81c504c086b2/note-mermaid-after.jpg)。

## 未确认范围

尚未在真实账号的 Electron 窗口复核服务器同步、应用缩放与 Live2D 位置。预览中的 HTML 图片使用可访问地址；独立 Markdown 中的相对图片文件仍需相应附件，不能从缺失的源目录猜出图片。HTML 和 Mermaid 的最终呈现位于阅读模式。
