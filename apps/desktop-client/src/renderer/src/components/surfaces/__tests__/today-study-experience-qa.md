# 今日学习体验重构验收

日期：2026-10-03。对应今日学习 → 续学 / 笔记 / 复习 → 作答与结果 → 返回的调用链。

## 改动与行为

- 今日学习改为浅薄荷封面、奶油纸页与三枚柔软入口。足迹、学习轮次和各个空间通过页签切换，纸内负责滚动，入口保持稳定。长标题正常换行，伴星保留独立空间。
- 续学、正式作答、结果及其弹层沿用这套纸面、圆角与按钮触感；正式学习提交、评价和恢复契约保持原有调用关系。
- 按压、页签垫和页内到达由 `useTactileSurface` 驱动。Full 使用保留当前位置和速度的弹簧，快速反向切换可打断；Lite、Off、系统减少动态各自降级。键盘焦点和操作即时生效。
- 从今日学习进入笔记、笔记库、复习和续学，明确保留返回入口。回看某轮使用它的轮次 ID；同一篇笔记存在更新的进行中轮次时，旧轮次仍打开学习记录。
- 返回手账恢复所选页签、已加载的历史深度和滚动位置；切换工作区重置。历史翻页防重复请求、去重，离开页面后的旧响应不会污染新页面。
- 需要用户处理的事项与系统异常分别表达，后台失败默认折叠。调整今日安排失败会说明未保存并保留原安排，连续点击不会重复提交。

## 自动验证

执行目录：`apps/desktop-client`。

- `npm run test --` 后指定 StudySurface、HomeSuggestionCard、resumable-surface、TodayBatchSurface、learning-run-surface.actions / boundary / result、notebook-surface.reading-shape、study-tactile，以及四项样式守卫，`--maxWorkers=2`：首次 13 个文件、164 项，163 通过。唯一失败是并行笔记改动中的 `making-feedback` 死样式，不属于今日学习实现。
- 上述死样式被清理后，重跑四项样式守卫和 notebook-surface.reading-shape（含新增旧轮次跳转用例）：5 个文件、56 项全部通过。没有把两次重复运行的项目累加为单次通过数。
- 动效用例覆盖首帧反馈、反向切换保留速度、重渲染、键盘重复与失焦释放、Full → Lite → Off、减少动态、异步出现的按钮、禁用/隐藏目标及卸载清理。
- `npm exec electron-vite -- build --outDir <独立验收目录>/out`：main、preload、renderer 构建成功。
- `npm run typecheck`：本次相关文件没有诊断；整体被 `space/__tests__/star-map-camera.test.tsx` 第 33、41、53、56 行缺少必填 `selectedId` 的四处诊断阻断。未将整体类型检查写为通过。
- 本次相关差异的 `git diff --check` 通过。

日志保存在仓库忽略目录 `outputs/today-study-experience-2026-10-03/`：`tests-final.log`、`final-integration.log`、`build-final.log`、`typecheck-final.log`。

## 真实窗口

使用独立 Electron 验收窗口和隔离的本地测试工作区，不依赖用户的学习数据。通过真实 API 建立四篇长标题笔记、十二轮已关闭记录和一轮暂停记录；没有调用模型生成学习内容。

已实际查看：今日足迹空态与四条记录、历史首批十轮与继续加载后的十三轮、长问题换行、纸页滚动时入口固定、回看旧轮次进入学习记录、今日学习与续学之间返回。最终构建通过原生 View → Force Reload 载入。默认窗口为 1440 × 810 逻辑像素，截图为 2880 × 1620。

续学在隔离工作区显示无未完成练习；今日复习批次读取出现失败时显示重试入口。未把这项服务失败记为正式复习正常完成。作答和结果的行为由相关自动回归覆盖，本次未在真实窗口完成一套由模型生成的正式练习。

Off、Lite 和系统减少动态已做自动行为验证；本轮未额外改变系统动效设置，也未补做多个缩放比例的窗口验收。

最终今日学习截图：`outputs/today-study-experience-2026-10-03/today-final.png`。
