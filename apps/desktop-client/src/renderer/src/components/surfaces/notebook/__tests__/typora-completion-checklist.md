# Typora 编辑能力补齐 · 2026-10-08

用户要求补齐上一轮列出的 8 组编辑差距和 3 组完整应用能力。以实际可操作、保存和重开不丢内容为验收，保留书房的纸面与伴星设计。

| 范围 | 实施状态 | 验证 |
| --- | --- | --- |
| 光标附近 Markdown 语法显隐与边界编辑 | 已实现：光标附近显示标题、文字格式等语法；装饰不写正文 | 编辑器回归覆盖跨视图、撤销、格式边界和重开 |
| 键盘连续编辑、嵌套列表、跨块操作、输入法 | 已实现：列表 Tab/Shift+Tab、块退出、共享撤销、组合输入保护 | 嵌套列表、远端更新与 IME 组合输入回归；macOS 实际连续操作 |
| 多行公式、独立公式块、编号和引用 | 已实现：原位源文/公式切换、KaTeX、标签和引用 | shared/阅读/编辑/导出测试；窗口与导出 PDF 核对编号 |
| 表格拖动、批量调整行列、复杂选区 | 已实现：行列拖动、行列及单元格选区、批量尺寸、表头删除与撤销 | 回归覆盖末格接续、表头提升、释放点定位；原生窗口两次换行、换列及撤销成功 |
| 图片相对路径、资源目录、批量管理与离线导出 | 已实现：批量并排、缩放/拆分、相对图片与本地资源目录、离线嵌入 | 编辑器回归覆盖分组和尺寸重开；本地文件含两图保存重开；文件/导出测试 |
| 脚注、正文目录、YAML、提示块、高亮、上下标、Emoji | 已实现：扩展语法、脚注排版/编号跳转、目录定位与 Emoji 补全 | shared 往返和编辑器回归；窗口检查脚注原位编辑与目录滚动 |
| 排版正文查找、定位和替换 | 已实现：跨文字格式查找、大小写选项、单次/全部替换、定位 | 跨格式匹配、替换独立撤销回归；源码沿用 CodeMirror 查找 |
| 混合图文/表格粘贴、Markdown/HTML 复制 | 已实现：混合 HTML 保留安全排版、表格和图片；两种复制 | 混合 HTML 粘贴和剪贴板 IPC 回归；危险 HTML 不进入正文 |
| 专注与打字机模式 | 已实现：光标段落聚焦、光标随写作位置滚动 | 正文/源码共用偏好；窗口检查纸面与设置交互 |
| PDF、HTML、Word 等多格式导出 | 已实现：Markdown、离线 HTML、PDF、可编辑 DOCX | 主进程导出测试；实际窗口生成 PDF 并渲染检查无重叠、截断 |
| 写作主题配置、本地文件夹与 Markdown 文件工作流 | 已实现：三种纸面、三类字体、尺寸/行距/宽度；文件夹导航、打开/新建/保存 | 窗口修改字体字号；本地文件修改→保存提示→保存→关闭→文件夹重开成功 |

## 排版工具与 UI

用户点名的缩进、行距、对齐、文字颜色、文本高亮、无序/有序列表、撤销/重做、格式刷、字体与字号已接入同一份正文和撤销栈。文字和段落样式以安全 HTML 写回 Markdown，可保存、同步、切换源码和重开。格式刷在排版视图操作；源码视图提示切回排版。

字体样张、字号网格、色盘与十六进制输入、段落对齐/行距、标题选择和写作设置采用自定义浮层，保留选区并支持键盘、Escape 和外部关闭。纸面拥有字体与版心配置，工具栏和弹层接入书房样式。系统文件选择/保存对话框保留用于本地文件访问。

## 验证记录

2026-10-08，桌面相关 8 个测试文件共 **72 项通过**：`note-document-editor`、`note-math-reading`、`note-markdown-reading`、`notebook-link-editor`、`note-writing-export`、`note-writing-files`、`desktop-ipc-clipboard`、`renderer-style-order-guard`。shared 全量 **884 项通过**；API 文档一致性与协作内核 **10 项通过**。shared、API、desktop-client、ai-worker 的 `npm run typecheck` 均通过。临时入口清理后的桌面生产构建与房间素材守卫通过，`git diff --check` 通过。

桌面回归从 `apps/desktop-client` 运行：

```sh
npx vitest run src/renderer/src/components/surfaces/notebook/__tests__/note-document-editor.test.tsx src/renderer/src/components/surfaces/notebook/__tests__/note-math-reading.test.tsx src/renderer/src/components/surfaces/notebook/__tests__/note-markdown-reading.test.tsx src/renderer/src/components/surfaces/notebook/__tests__/notebook-link-editor.test.tsx src/main/__tests__/note-writing-export.test.ts src/main/__tests__/note-writing-files.test.ts src/main/__tests__/desktop-ipc-clipboard.test.ts src/main/__tests__/renderer-style-order-guard.test.ts --no-file-parallelism
npm run typecheck
npm run build
```

真实窗口使用隔离的 Electron 检查应用加载生产编辑组件、样式与文件 IPC，未操作用户现有笔记。快速拖表格时发现 pointermove 合并导致目标位置滞后，修复为按 pointerup 的最终位置提交，并加入回归。检查应用和临时入口在交付前移除。

## 当前限制

- 这些范围已实现，不代表与 Typora 每个菜单和全部边界行为完全一致。Windows/Linux 原生输入法、各缩放档位与完整伴星窗口尚未逐项人工检查。
- DOCX 常见公式转换为 Office Math；复杂矩阵等公式的完整 Word 保真度尚未验证。Word 脚注当前以可编辑引用和文末说明表达，尚非 Word 原生脚注对象；未在 Microsoft Word 窗口核对成品。
- Markdown 原生语法没有字体、颜色、行距等属性，故这些排版使用安全 HTML 扩展；第三方纯 Markdown 渲染器可能忽略样式。
