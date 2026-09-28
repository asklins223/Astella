# 39f：笔记开始学习链路、HUD 风格与 HTML 演示问题清单

> **状态：已废弃（2026-09-28）。** 39 主方案及全部 39 系列子文档的产品决策、实施顺序、待办和验收门槛均停止生效；以下原有“状态”只代表当时记录。本文仅作历史证据，不再派活。现行笔记学习方案见 [41](./41-note-companion-learning-experience-2026-09-28.md)；独立保留的统一 Agent 基础见 [41a](./41a-unified-agent-foundation-2026-09-28.md)。已实施代码需按现行产品合同重新核对。

> 检查日期：2026-09-28  
> 状态：只读审计；未修改产品代码、样式或学习数据  
> 范围：**笔记正文 → 开始／继续学习 → 讲解与 HTML 图形演示 → 练习 → 本轮结果 → 返回笔记**

## 1. 本次检查的依据与边界

- 用户指定的核心链路是**从笔记开始学习**。本清单不把首页、卡片、星图等其他入口当作本次主线。
- 视觉判断以 [AGENTS.md](../../../AGENTS.md) 和 [DESIGN.md §全项目视觉与陪伴裁决](../../../DESIGN.md#全项目视觉与陪伴裁决2026-09-27) 为准：现有 V3.1 动森式 HUD、可见伴星、书房物件、奶油纸面、薄荷牌、册页、便签、印章和有触感的按钮必须进入任务内容本身。[39 PRD](39-adaptive-note-learning-system-prd-2026-09-24.md)仅用于比对预期体验；它是参考材料，不是本次修改指令。
- 实际窗口走查了 `IndexTTS 2.5 让声音跨越语言 - 哔哩哔哩222` 的笔记详情和“继续学习”页面；此前同一链路还检查过讲解、历史和结束动作。真实窗口中伴星可见。此次进入的是**已暂停轮次**，因此“大面积空白”的直接观察只对应这一状态。
- HTML 演示检查使用了真实模型生成的样本 `/tmp/real-artifact.html`，并核对当前生成器、播放器、宿主和现有测试。**当前源码中新产物的运行错误属于源码确认，尚未在嵌入式真实演示窗口复现；已有旧产物可能是另一版 HTML。**
- 当前工作区有并行中的未提交改动。下列行号与判断对应本次检查时的文件状态，后续处理前应重新核对。

## 2. 一句话结论

用户想从一篇笔记弄懂一个具体问题，当前界面却主要展示“系统安排了哪些步骤、留下哪些记录”。学习内容的收获不够具体，流程在练习处换到另一套页面，图形演示画的是教学栏目。房间外围保留了 HUD 和伴星，**核心学习区没有按 V3.1 HUD 的物件语言组织**；演示播放器还存在会阻断新产物的运行错误。

## 3. 沿用户链路的问题

| 环节 | 当前观察 | 用户代价 | 证据 |
| --- | --- | --- | --- |
| 从笔记进入 | 笔记正文页有“继续学习”，但显示的是一个覆盖整篇 IndexTTS 的宽泛问题；学习内容和正文按 `leaf` 互斥。 | 进入后失去正在阅读的材料上下文，难以知道这次从哪一处开始学。 | [正文／学习切换](../../../apps/desktop-client/src/renderer/src/components/surfaces/notebook-surface.tsx#L2541)、[入口动作](../../../apps/desktop-client/src/renderer/src/components/surfaces/notebook-surface.tsx#L2982) |
| 首屏与暂停恢复 | 实窗中的暂停页是一张占据主要画面的纸，顶部显示“这轮先停在这里”和泛问题，中间大面积留白，主要按钮落在底部。页面同时出现“返回笔记库”和“回笔记正文”。 | 用户第一眼看不到已完成什么、将从哪一步继续，也难分辨两个返回动作。 | [学习页头部／暂停态](../../../apps/desktop-client/src/renderer/src/components/surfaces/notebook-surface.tsx#L2643) |
| 本轮问题 | “我完全不熟”预设把笔记标题塞进“从头到尾有个站得住的解释”；当前样本的标题本身很长。 | 把一篇长笔记包装成一个大问题，用户仍不知道该先弄懂哪一个机制、条件或边界。 | [问题预设](../../../apps/desktop-client/src/renderer/src/components/surfaces/notebook-surface.tsx#L448)、[PRD §3.3](39-adaptive-note-learning-system-prd-2026-09-24.md#33-无目标表单的轻量定向) |
| 讲解 | 一整段解释、例子、依据入口与演示纵向排列；曾看到整篇概述及“块 43、45、50”一类内部位置提示。 | 阅读负担增加；教学内容没有稳定围绕一个小问题逐步展开，依据也不像可直接理解的笔记位置。 | [讲解布局](../../../apps/desktop-client/src/renderer/src/components/surfaces/notebook-surface.tsx#L2713) |
| 去练习 | “用这个问题试一次”创建 `LearningRun`，调用 `invoke("validate")` 切到另一张作答页面。 | 从笔记学习中途切换页面与操作语言，用户需要自己维持“这道题属于刚才哪一轮”的上下文。 | [练习跳转](../../../apps/desktop-client/src/renderer/src/components/surfaces/notebook-surface.tsx#L1887) |
| 看结果与结束 | 结果文案主要按证据类别生成“完成作答／留下记录／还需补某类能力”等通用句；“先到这里”成功后直接回正文。 | 很难回答“今天具体弄懂了什么、哪里仍不懂”；结束动作未始终给出清楚的收获回执。 | [结果文案](../../../apps/desktop-client/src/renderer/src/components/surfaces/note-learning-flow.ts#L42)、[结束动作](../../../apps/desktop-client/src/renderer/src/components/surfaces/notebook-surface.tsx#L1735)、[PRD §5.6](39-adaptive-note-learning-system-prd-2026-09-24.md#56-结果页) |

## 4. UI 风格与信息层级

### UI-1｜核心学习区没有成为动森式 HUD（核心问题）

真实窗口里，暖木房间、薄荷页牌与伴星仍在；承载学习任务的区域则是一张巨大的浅色平面，主要靠标题、细分隔线、长文字和页面底部按钮组织。它给人的体验更接近普通文档或表单。**外围风格存在，不等于学习过程已经具有同一套 HUD 身份。**

当前样式直接将学习页标题区与内容区设为透明背景、零圆角、无阴影，依赖顶线分段；这解释了为什么“纸面很大，但里面没有册页、纸签和物件层次”。避免多层纸卡互相遮挡是合理问题，结果却把承载任务的物件感一起压掉了。[学习区样式](../../../apps/desktop-client/src/renderer/src/components/surfaces/note-hud.css#L221)与 [DESIGN.md §17–25](../../../DESIGN.md#全项目视觉与陪伴裁决2026-09-27)存在实际体验冲突。

### UI-2｜空间分配没有服务当前任务

暂停态用大量面积展示空纸面，已做过的讲解和尝试被一句概括带过；“继续这一轮”离问题很远。主标题、问题、状态、操作之间缺少一眼可见的联系。长问题又占据视觉中心，进一步降低了当前动作的辨识度。该项有**真实窗口观察**，但不能把暂停态直接推断为所有状态都一样空。

### UI-3｜演示视觉另起一套小工具样式

演示在独立 iframe 内使用 `system-ui`、固定的 11–14px 字号、规则圆角、细灰线、白底小按钮；模型生成版本和材料哈希也直接印在学习画面上。宿主虽然给 iframe 加了纸色边框，内部仍没有沿用 V3.1 的字体、`--hud-*` 色彩、粗奶油边与触感控件。技术溯源信息抢占了本应解释概念的位置。[演示内部样式与元信息](../../../apps/api/src/modules/note-learning-rounds/round-artifact-render.ts#L158)、[宿主边框](../../../apps/desktop-client/src/renderer/src/components/surfaces/note-hud.css#L655)。

### UI-4｜术语与入口数量抬高理解成本

“本轮”“小路线”“调整这一轮”“依据”“学习目标”“学习卡”等系统内部组织词在同一条链路里交替出现。用户需要先理解这些概念，才能判断现在要学、试、回看还是结束。此问题与 UI-2 叠加，使页面像在展示系统状态，而不是直接帮助用户完成一次学习。[问题页操作](../../../apps/desktop-client/src/renderer/src/components/surfaces/notebook-surface.tsx#L2678)、[底部动作](../../../apps/desktop-client/src/renderer/src/components/surfaces/notebook-surface.tsx#L3005)。

## 5. HTML 图形演示

### DEMO-1｜画面选错了对象（核心问题）

服务端固定生成“讲解 → 例子 → 计划第 N 步”这些节点；模型只可选择横向步骤、竖向流程或条形图，再给每个节点写一句说明。[节点生成](../../../apps/api/src/modules/note-learning-rounds/round-artifact-measure.ts#L65)、[模型输出范围](../../../apps/api/src/modules/note-learning-rounds/round-artifact-model.ts#L50)。真实生成样本《提取练习四步走》因此出现“讲解、例子、计划第 1–4 步”六格。

这六格描述的是**教学内容的包装顺序**，不是“合上材料 → 回想 → 核对缺口 → 再尝试”这样的知识过程。流程图把教学栏目连成因果箭头，会暗示不存在的因果关系；条形图量的是各段说明文字的字数，字数对理解提取练习没有教学价值。[三种固定画面](../../../apps/api/src/modules/note-learning-rounds/round-artifact-render.ts#L74)。

### DEMO-2｜切步和播放的运行缺陷（阻断）

浏览器 DOM 的 `isConnected` 是布尔属性。当前播放器写成 `stage.isConnected()` 与 `controls.isConnected()`，初始化调用 `render(0)` 时就会抛错，后面的控制条创建无法执行。[播放器](../../../apps/api/src/modules/note-learning-rounds/round-artifact-render.ts#L222)。这是**当前源码中新生成 HTML 的确定性错误推断**，不是已在真实嵌入窗口录到的错误画面。

即使修复上述错误，横向步骤仍有另一处问题：初始颜色由 `ailearn-seq__chip--active` 等 CSS 类决定，切步脚本只修改 `data-active`／`data-done`，类名不会变化。读数可以往前走，醒目的高亮仍停在初始步骤。[横向步骤样式](../../../apps/api/src/modules/note-learning-rounds/round-artifact-render.ts#L171)、[切步脚本](../../../apps/api/src/modules/note-learning-rounds/round-artifact-render.ts#L238)。

### DEMO-3｜只有播放控制，没有学习参与

控制条提供播放、暂停、上一步、下一步、重播；用户不能在图里预测下一变化、选择一个条件或解释关键变化。[控制条](../../../apps/api/src/modules/note-learning-rounds/round-artifact-render.ts#L274)。这与 [PRD §5.4／§6.1](39-adaptive-note-learning-system-prd-2026-09-24.md#6-教学表达与-ai-动态讲解)的教学意图有距离。给节点依次上色不能单独证明用户理解了内容。

## 6. 为什么现有测试给了错误信心

本次运行 `apps/api/src/modules/note-learning-rounds/round-artifact-generation.test.ts`，**34 项通过、0 项失败**。但测试自制的 DOM 替身将 `isConnected` 定义为函数，正好迎合了播放器的错误调用；它检查的是属性和标记变化，也没有验证横向步骤在浏览器中的实际高亮。[测试替身](../../../apps/api/src/modules/note-learning-rounds/round-artifact-generation.test.ts#L695)。因此这组绿色结果不能充当“演示已在真实窗口可播放、可理解、符合 HUD”的证据。

## 7. 合并后的问题优先级

1. **先确认可用性**：新演示播放器初始化错误；笔记到练习、结果和返回的实际路径需要真窗口逐步核对。
2. **重新明确教学对象**：每轮选一个可理解、可检验的笔记问题；演示画知识变化，不画“讲解／例子／计划”这些系统栏目。
3. **恢复完整的 V3.1 HUD 身份**：学习纸面、暂停态、讲解、演示、练习和结果都要呈现同一间书房的物件与伴星座位，同时让有效内容占据主视觉。
4. **减少用户自己拼接流程的负担**：始终明确当前问题、笔记依据、正在做的动作和具体收获；练习跨页与结束返回须保持上下文。
5. **让验证接触真实体验**：浏览器 DOM、实际生成的 HTML、长笔记、暂停恢复、紧凑窗口及动效关闭状态都需要真实窗口核查；不能用一组自制 DOM 测试代替画面验收。

本文件是问题清单和证据边界，不包含页面重设计稿，也不授权实现改动。
