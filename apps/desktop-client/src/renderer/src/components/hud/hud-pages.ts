/**
 * The approved desktop-pages-v3 mockups are the spatial contract for every
 * business page. This registry is the single source of truth for the shell that
 * wraps a page body: its number, heading, room plate, companion seat and the one
 * line the companion says while that page is open.
 *
 * Page numbers match `.impeccable/review/desktop-pages-v3/effects/<NN>-*.png`.
 */
export type HudPageId =
  | "home"
  | "space"
  | "sources"
  | "source-detail"
  | "notes"
  | "note-read"
  | "note-edit"
  | "note-learning"
  | "note-card"
  | "note-history"












  | "search"
  | "graph"
  | "companion"
  | "settings"
;

export type HudPlate =
  | "home"
  | "library"
  | "writing"
  | "system"
  | "observatory";

export type HudCompanionSeat = "left" | "right" | "none";

export type CompanionSurfacePolicy = Readonly<{
  /** 任务页保留可见角色；assessment=正式作答边缘陪伴（可见且静默）。hidden 仅用于明确的关闭/不可用状态。 */
  mode: "hidden" | "home" | "ambient" | "assessment";
  seat: HudCompanionSeat;
  framing: "full" | "bust";
  interaction: "none" | "on-demand";
  proactive: "allow" | "silent";
  draggable: boolean;
  /** 用户主动唤起后才展示，绝不作为页面进入时的自动播报。 */
  starter?: string;
}>;

/**
 * 每一屏**能不能被她带过去**（39b §9.6 / 39d W2-1 的对账表）。
 *
 * 四套词表收一的最后一块：`HudPageId`（桌面端真有哪几屏，9）↔
 * `COMPANION_PAGE_DESTINATIONS_V2`（她能跳回去哪几屏，7）。两者对不上的地方
 * **必须显式写出来并给理由**，不能靠"反正没有"——那正是「她读得到 `generating`
 * 却跳不回去」这个缺陷长期没人看见的原因。
 *
 * `null` 的三种情形（每一种都有理由，不是"忘了填"）：
 *  - **死分支**（`login`／`register`）：没有任何组件发布这两屏，等删除；
 *  - **要实体 id**（`generating`／`candidate`／`assessment`／`result`／`resumable`／
 *    `goal-detail`／`note-read`／`note-edit`）：`companion_open_page` 只收**无参**落点
 *    （`allowedMainRouteV2Schema` 里不带实体 id 的那一批），而路由白名单里**没有**
 *    `card_generation` 这一档 —— 要把这几屏接上，先得有对应的路由 kind 或带参的打开动作；
 *  - **没有对应落点档**（`space`）：空间切换走顶栏胶囊，不是伴星导航。
 */
export const HUD_PAGE_DESTINATIONS: Readonly<Record<HudPageId, string | null>> = {
  home: "home",
  space: null,
  sources: "source",
  "source-detail": "source",
  notes: "note_library",
  "note-read": null,
  "note-edit": null,
  "note-learning": null,
  "note-card": null,
  "note-history": null,
  search: "search",
  graph: "star_map",
  companion: "conversation",
  settings: "settings",
};

export type HudPageDefinition = {
  readonly id: HudPageId;
  readonly number: string;
  readonly title: string;
  readonly subtitle: string;
  readonly plate: HudPlate;
  readonly companion: CompanionSurfacePolicy;
  /** A full-width paper that owns the room, e.g. the LearningRun assessment. */
  readonly wide?: boolean;
};

export const HUD_PAGES: Readonly<Record<HudPageId, HudPageDefinition>> = {
  home: {
    id: "home",
    number: "01",
    title: "首页",
    subtitle: "沿用当前 Home V2，只校准固定半身伴星与阅读起点",
    plate: "home",
    companion: {
      mode: "home", seat: "right", framing: "full", interaction: "on-demand", proactive: "allow", draggable: true,
    // "今天先完成 6 张到期复习" was a hard-coded count that had no relation to the
    // workspace it was spoken in.
      starter: "今天的学习从打开一篇笔记开始。",
    },
  },


  space: {
    id: "space",
    number: "04",
    title: "学习空间",
    subtitle: "这里列出你加入的每个空间；顶栏的空间胶囊随时可以切换",
    plate: "home",
    companion: {
      mode: "ambient", seat: "right", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
      starter: "选定空间后，我才读取对应的学习进度。",
    },
  },
  sources: {
    id: "sources",
    number: "05",
    title: "来源库",
    subtitle: "采集、搜索、解析与待处理材料在同一张资料索引上",
    plate: "library",
    companion: {
      mode: "ambient", seat: "right", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
      starter: "粘贴、拖入或填一个地址都能采集；也可以直接搜索已有来源。",
    },
  },
  "source-detail": {
    id: "source-detail",
    number: "06",
    title: "来源详情",
    // The source contract exposes parsed fragments and linked notes, not a
    // source-level evidence projection, so the plate names what the page shows.
    subtitle: "进入即阅读原文、核对解析结构并开始写笔记",
    plate: "library",
    companion: {
      mode: "ambient", seat: "left", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
      starter: "正文已经按片段整理好，可以直接开始写笔记。",
    },
  },
  notes: {
    id: "notes",
    number: "07",
    title: "笔记库",
    subtitle: "写下来的，都在这里",
    plate: "writing",
    companion: {
      mode: "ambient", seat: "right", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
    // A page-level line cannot see the records behind it, so it may not claim
    // anything about them. This one used to promise the top note "已经关联了
    // 来源和证据" on a page that also renders 未关联来源.
      starter: "书架按最近更新排在最前面。",
    },
  },
  "note-read": {
    id: "note-read",
    number: "08",
    title: "这篇笔记",
    subtitle: "原文还在，接着往下读",
    plate: "writing",
    companion: {
      mode: "ambient", seat: "left", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
      starter: "来源和版本都收在页边。",
    },
  },
  "note-edit": {
    id: "note-edit",
    number: "09",
    title: "笔记编辑",
    subtitle: "Markdown 所见即所得；可回去的版本按「保存」留下",
    plate: "writing",
    // Reading and writing are one page in two modes, so they share a seat: the
    // clips hang over the right edge in both, and flipping the seat moved the
    // whole paper ~277px the instant the mode changed.
    companion: {
      mode: "ambient", seat: "left", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
      starter: "我先保持安静，你专心写。",
    },
  },
  "note-card": {
    id: "note-card",
    number: "08",
    title: "学习卡",
    subtitle: "这篇笔记的配套练习",
    plate: "writing",
    companion: {
      mode: "ambient", seat: "right", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
    },
  },
  "note-learning": {
    id: "note-learning",
    number: "08",
    title: "学这篇笔记",
    subtitle: "从这篇笔记出发，把想弄懂的内容留下来",
    plate: "writing",
    companion: {
      mode: "ambient", seat: "left", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
    },
  },
  "note-history": {
    id: "note-history",
    number: "08",
    title: "学习记录",
    subtitle: "留下的线索都在这页",
    plate: "writing",
    companion: {
      mode: "ambient", seat: "left", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
    },
  },
  search: {
    id: "search",
    number: "18",
    title: "全局搜索",
    subtitle: "在笔记、来源和学习卡里，找回想接着读的那一句",
    plate: "library",
    companion: {
      mode: "ambient", seat: "right", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
      starter: "我把来源、笔记和学习卡放在同一组结果里。",
    },
  },
  graph: {
    id: "graph",
    number: "19",
    title: "理解星图",
    subtitle: "在星座之间漫游，沿着笔记接回学习",
    plate: "observatory",
    companion: {
      mode: "ambient", seat: "left", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
      starter: "这片星空全是真的：拖一拖，点一颗星，我陪你看它从哪来。",
    },
  },
  companion: {
    id: "companion",
    number: "20",
    title: "伴星中心",
    subtitle: "她的日记、对话和记忆都在这张书桌上",
    plate: "observatory",
    companion: {
      mode: "ambient", seat: "right", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
      starter: "今晚想回看哪段学习经历？记忆写入前会先确认。",
    },
  },
  settings: {
    id: "settings",
    number: "21",
    title: "设置中心",
    subtitle: "把书房、陪伴和数据调成适合你的样子",
    plate: "system",
    companion: {
      mode: "ambient", seat: "right", framing: "bust", interaction: "on-demand", proactive: "silent", draggable: false,
      starter: "这里没有虚构的模型选择或 BYOK 选项。",
    },
  },
};

/** Room plate per page, used for the scoped `bg-*` class on the HUD scope. */
export function hudPlateClass(plate: HudPlate): string {
  return `bg-${plate}`;
}
