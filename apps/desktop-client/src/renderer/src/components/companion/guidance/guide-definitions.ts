import { BookOpen, Compass, Files, MessageCircle, NotebookPen, RotateCcw, Settings2, type LucideIcon } from "lucide-react";
import { COMPANION_GUIDE_STEP_IDS } from "@astella/shared/companion-shell-contracts";
import { getHomeFeature, type HomeFeatureId } from "../../home-v2/home-feature-registry";

export type GuideStepId = typeof COMPANION_GUIDE_STEP_IDS[number];
export type GuideTopicId = "welcome" | "space" | "sources" | "reading" | "agent" | "review" | "settings";
export type GuideStep = { id: GuideStepId; title: string; detail: string; cue: string; demo: "room" | "note" | "reading" | "agent" | "review" | "return"; feature?: HomeFeatureId; action?: string; anchor?: string; target: string; practice: string; gated?: "consent" };
export const GUIDE_OPEN_EVENT = "astella:companion-guide-open";
export const GUIDE_PRACTICE_EVENT = "astella:companion-guide-practice";
export function openCompanionGuide(topic?: GuideTopicId) { window.dispatchEvent(new CustomEvent(GUIDE_OPEN_EVENT, { detail: { topic } })); }
export const GUIDE_STEPS: Record<GuideStepId, GuideStep> = {
  voice: { id: "voice", title: "先让伴星能出声", detail: "伴星要把话念给你听，得先经你同意把这段讲解交给外部模型。开了，这一路都有声音；不开也看得完，只是少了我在旁边说。", cue: "先让我能出声：去设置里签署 AI 使用同意，我才被允许念给你听。开好了回来，我们接着从这间书房走起。", demo: "room", anchor: '.hud-rail [aria-label="设置"], .room-control-guide', action: "去设置开启", target: "设置里的「AI 数据同意」", practice: "设置在这里：签下「AI 使用同意」就好。回到书房，我接着带你走第一站。", gated: "consent" },
  room: { id: "room", title: "同一位伴星，这一间书房", detail: "空间把资料、笔记与具体经历放在一起。右上角的门牌始终告诉你：现在在哪、能做什么。", cue: "先认一认右上角的门牌。它告诉你现在在哪间书房，以及你的身份。我会陪你一起，从一个问题开始。", demo: "room", anchor: ".room-control-space", action: "看看空间菜单", target: "右上角，是这间书房的门牌", practice: "这里可以查看、新建和切换空间。现在不用换书房，接着往下走，我带你找到第一篇笔记。" },
  notes: { id: "notes", title: "从一篇笔记开始", detail: "可以直接写下想法，也可以先收录资料，再整理成带出处的笔记。笔记是你可以继续修改的学习纸页。", cue: "我们就从“为什么回想比重读更有帮助”这个问题开始。材料留下出处，再用自己的话记成一篇笔记。左边的笔记入口，收着你的纸页。", demo: "note", feature: "all-notes", action: "打开我的笔记", anchor: '.hud-rail [aria-label="笔记"], [data-guide-anchor="notes"], [data-feature="all-notes"]', target: "从这里，找到或写一篇笔记", practice: "已经到你的笔记了。可以选一篇来读，有编辑权限时也能新建。接下来，我用刚才那篇示例带你看看怎么读懂。" },
  reading: { id: "reading", title: "按眼前的需要，读懂这一篇", detail: "速看先理清整篇；回想检查自己的理解；选一句交给伴星解释；往外学把问题展开。它们可以按需要单独使用。", cue: "继续读这篇笔记。卡在这句，就选中它，叫我解释。想先看整体用速看，想检查理解用回想；问题还能接着往外学。", demo: "reading", feature: "all-notes", action: "去选一篇来读", anchor: '[data-guide-anchor="note-learning"], .hud-rail [aria-label="笔记"], [data-feature="all-notes"]', target: "打开一篇笔记，再选中不明白的一句", practice: "在笔记里选一篇打开，就能开始阅读。选中原句可以交给我解释；带路的位置还留着，准备好了再接着看。" },
  agent: { id: "agent", title: "一件事，有来有回", detail: "直接说需求，或使用页面上的按钮。任务纸页里可以看进展、补充想法和停止；有候选产物时先看，再确认保存。", cue: "还想把这个问题整理成提纲，就直接告诉我。任务里能看进展，也能补充或停止。提纲先给你看，确认后才保存。", demo: "agent", feature: "companion-center", action: "打开伴星中心", anchor: '.hud-rail [aria-label="伴星"], [data-guide-anchor="agent-tasks"]', target: "在这里，找到伴星和任务进展", practice: "这里是伴星中心，对话、任务和记录都能回来找。需要帮忙时直接提需求；接下来，我们收好带路，开始你自己的学习。" },
  return: { id: "return", title: "去做自己的事，随时回来", detail: "今日下一步帮你接续，记录留在真实学习页面里。需要再看一段时，展开右上角岛里的「伴星带路」。", cue: "你已经走过从问题、笔记，到解释和提纲的路了。现在换成你想学的内容。带路收在右上角，想再看哪一段，随时回来。", demo: "return", anchor: ".room-control-guide, .room-control-trigger", action: "开始我的学习", feature: "all-notes", target: "伴星带路一直收在右上角", practice: "现在挑一篇笔记，或者写下你自己的问题。结束带看后，我也会在旁边陪你。" },
  space: { id: "space", title: "先在这里安顿下来", detail: "这张门牌属于当前已验证的空间。内容正在读取时可以正常导航；读到后，再选择适合自己的起点。", cue: "我们到了。先看看这里有什么，再挑一篇开始。", demo: "room", feature: "all-notes", action: "查看这里的笔记", anchor: ".room-control-space", target: "门牌显示当前空间和你的身份", practice: "这里就是这间书房的笔记。共享内容按你的权限打开，你自己的回想和学习记录会继续留在自己这里。" },
  sources: { id: "sources", title: "资料留出处，笔记留想法", detail: "来源资料保存收录与解析状态，笔记承载你整理的理解。两者各有入口，可以从来源继续整理，也可以直接写笔记。", cue: "把材料放进来，再用自己的话记下来。之后回看时，还能找到它从哪里来。", demo: "note", feature: "sources", action: "打开来源资料", anchor: '.hud-rail [aria-label="来源"], [data-guide-anchor="sources"], [data-feature="sources"]', target: "资料从这里收录，出处一起留下", practice: "这里能收录资料、查看解析状态，再带着出处整理成笔记。我们接着看看笔记怎样承载你自己的理解。" },
  review: { id: "review", title: "需要的时候，再回想一次", detail: "自己的学习记录和回想帮助你回顾。学习卡与长期复习按需要使用，到期内容会出现在今日复习。", cue: "不用为了结束带看去完成练习。等你想巩固这一篇时，我们再一起回来。", demo: "review", feature: "today-review", action: "打开今日复习", anchor: '.hud-rail [aria-label="复习"], [data-guide-anchor="review"], [data-feature="today-review"]', target: "需要巩固时，从这里回来", practice: "这里显示你安排的复习。没有到期内容也没关系，等需要巩固时再回来。" },
  settings: { id: "settings", title: "把书房调成舒服的样子", detail: "岛里可以切换空间、日夜、总静音和动效。设置中心管理账号、AI 使用条件、声音与个人偏好。", cue: "右上角可以切换日夜、总静音和动效。账号、声音与个人偏好在设置中心。把书房调成舒服的样子，就可以安心学了。", demo: "room", feature: "settings", action: "打开设置中心", anchor: '.hud-rail [aria-label="设置"], .room-control-motion', target: "声音、动效和个人偏好在这里", practice: "设置已经打开了。按你的习惯调整声音和动效，随时可以继续或者结束带看。" },
};
export const GUIDE_TOPICS: readonly { id: GuideTopicId; title: string; description: string; icon: LucideIcon; steps: readonly GuideStepId[] }[] = [
  { id: "welcome", title: "从这里开始，一起走一遍", description: "开声音 → 书房 → 笔记 → 读懂 → 伴星帮忙 → 开始学习", icon: Compass, steps: ["voice", "room", "notes", "reading", "agent", "return"] },
  { id: "space", title: "认识当前空间", description: "这里的内容、权限和起点", icon: BookOpen, steps: ["space", "notes"] },
  { id: "sources", title: "从资料到笔记", description: "收录、整理，留下自己的理解", icon: Files, steps: ["sources", "notes"] },
  { id: "reading", title: "读懂一篇笔记", description: "速看、回想、解释与往外学", icon: NotebookPen, steps: ["reading"] },
  { id: "agent", title: "请伴星帮我做事", description: "提需求、看进展、找产物", icon: MessageCircle, steps: ["agent"] },
  { id: "review", title: "回顾与复习", description: "回到自己的记录，按需巩固", icon: RotateCcw, steps: ["review"] },
  { id: "settings", title: "空间与个人设置", description: "找到适合自己的声音和节奏", icon: Settings2, steps: ["settings"] },
];
export const GUIDE_JOURNEY_LABELS: Record<GuideStepId, string> = { voice: "开启声音", room: "认识书房", space: "认识空间", notes: "找到笔记", sources: "收录资料", reading: "读懂一句", agent: "伴星帮忙", return: "开始学习", review: "回想复习", settings: "个人偏好" };
export const WELCOME_TITLES: Partial<Record<GuideStepId, string>> = { voice: "先让伴星能出声", room: "先认一认，我们的书房", notes: "带着一个问题，展开一页", reading: "接着，读懂这一句", agent: "把刚才的问题，交给伴星", return: "现在，轮到你的第一篇了" };
export function guideFeatureAvailable(step: GuideStep) { return !step.feature || getHomeFeature(step.feature).availability === "native"; }
export function topicForStep(step: string): GuideTopicId { return GUIDE_TOPICS.find(topic => topic.steps.includes(step as GuideStepId))?.id ?? "welcome"; }
