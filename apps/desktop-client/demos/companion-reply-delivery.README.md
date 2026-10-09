# 伴星交付纸验收

用现役 `CompanionReplyAttachments`、`CompanionAgentRail`、`CompanionChatRecordArticle`、浮层避让 hook 和统一 `styles.ts` 验证一轮回复的交付。消息和路由结果是合成数据，不请求模型、不访问账号、不写笔记。

在 `apps/desktop-client` 运行：

```sh
node node_modules/vite/bin/vite.js --config demos/companion-reply-delivery.config.ts
```

打开 `http://127.0.0.1:4189/companion-reply-delivery.html`，也可在独立 Electron 宿主中加载这个地址。

验证：默认只见交付入口；展开材料与片段；快速切换两份材料；用 Tab、Enter 阅读；下一轮替换旧内容；打开失败后重试；完成后整张纸收起；关闭后手记仍可读；放大和缩窄窗口下独立滚动；完整、轻量与 Off 动效。

「播放实时过程」模拟先说话、再查阅和保存，同时更新上方工具气泡与下方消息；可就地停止、展开过程、切到无工具回复或结果待核对。它使用现役节点 reducer 和过程组件，合成事件不代表真实模型任务完成。

「图片与其他内容」用现有本机 SVG 示意图预热图片缓存，直接验证现役预览与全屏阅读；前后按钮切换步骤图、题面和代码。「长内容」包含 8 步流程、长题面和 85 行代码，用于窄窗口、缩放、键盘滚动与复制入口的检查。图片的对象身份也是合成的，不请求真实资产。
