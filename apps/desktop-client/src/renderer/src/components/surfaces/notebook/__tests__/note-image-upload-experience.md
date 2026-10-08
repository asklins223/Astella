# 图片插入等待反馈 · 2026-10-08

用户要求参照正文 AI 调整时的柔和扫光与右上状态签，替换图片上传时的破图占位。

## 当前实现

- `uploading:` 留在图片节点属性中，不交给浏览器图片元素。节点视图用圆角扫光区域和右上状态签显示排队、上传及图片载入。
- 文件名、状态标签和失败说明属于节点视图，不写入 Markdown 或共享文档。成功后保留同一节点，等图片真实加载完成才显示图片。
- 失败停止扫光并保留列表中的重试、移出正文。移出通过图片地址删除对应节点，避免整体替换正文时留下占位；删除可以撤销。重开或撤销恢复的失去本机上传任务的占位显示「上传已中断，请重新插入」。
- 轻量、关闭动效和系统减少动态使用静态底色，上传状态仍可阅读。

## 验证

`npm run typecheck`（desktop-client）通过。

以下六个测试文件共 59 项通过：

- `note-document-editor.test.tsx`
- `note-source-annotation-marks.test.tsx`
- `notebook-surface.paper-image-drop.test.tsx`
- `renderer-style-closure-guard.test.ts`
- `renderer-style-order-guard.test.ts`
- `renderer-style-dead-guard.test.ts`

在浏览器窗口挂载真实 `NoteDocumentEditor`、图片上传 hook、工具栏与全套渲染样式，用本地上传回执替身观察持续等待、失败、重试、成功与移出；未写入用户实际笔记。检查了 390px 窄纸面、Off、系统减少动态、源码切换、点击灯箱及 Esc 后键盘删除。渲染占位时图片元素没有 src，成功图片的 naturalWidth 为 900，失败移出后节点数为 0。源码只保留图片地址，不包含显示的文件名或状态签。

截图保存于仓库 `outputs/note-image-upload-2026-10-08/` 的 `uploading.jpg`、`ready.jpg`、`off-narrow.jpg`、`failed.jpg`。临时页面与服务已清理。

验证范围：当前 Electron 开发窗口停在登录页，本轮窗口检查在独立本地页面中复用产品编辑器与样式；没有复测服务端上传或完整 Electron 登录后页面。
