/**
 * 星图的**读者控制状态**（2026-09-30 从 `graph-surface.tsx` 抽出）。
 *
 * ## 为什么抽
 *
 * `GraphSurface` 原来 40 个 hook（软线 25）。开头这一段——搜索词、三个
 * 「要不要显示证据/来源/关系」开关、状态筛选、选中项、路径（**一个**笔记 + **一个**层）、
 * 以及**随时**可切的等价册页——**没有一个和服务端有关**。
 * 它回答的是「**读者现在在看哪一层、翻到哪一张**」。
 *
 * 判据就是 AGENTS.md 那句「页面组件只做四件事：取数、派生、摆位、接事件」：
 * **这些是摆位参数，不是取数。**
 *
 * ## ⚠️ 紧跟在它后面那条 `useSurfaceProjection(…)` **留在组件里**
 *
 * 它把拓扑图算成 `projections` / `visibleGraph` / `topologyEdges`——
 * **那是取数**。第 8 轮把「首尾两块」一起搬走时，它被夹在两个切口之间，
 * 组件当场少 18 个派生值。
 * **教训**：「每段独立解析通过」测不出「域划错了」——
 * 搬出去的对象是**一个域**，不是「一段连续的行」。
 *
 * ## `compactLayout` 是**入参**，不是搬过来的
 *
 * 它是 `useCompactUniverseLayout()` 的结果——**那也是取数（量视口）**，
 * 按判据该留在组件侧，所以这个 hook **接收**它。
 *
 * ## 拆的是位置，不是行为
 *
 * 一行没改，依赖数组一个没动。**等价册页那条规矩也在**——
 * 降级件只在画布挂掉那天才在，就没法当"等价"来验收：用户得能在画布好好的时候
 * 也走一遍，才知道它做的事一样多。
 */
import {
  useDeferredValue,
  useId,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { DeepeningLayer, StateFilter } from "./graph-surface-types";

export type GraphControls = {
  query: string;
  deferredQuery: string;
  searchOpen: boolean;
  searchActiveIndex: number;
  stateFilter: StateFilter;
  showEvidence: boolean;
  showSources: boolean;
  showLinks: boolean;
  selectedId: string | null;
  indexActiveIndex: number;
  pendingFocusId: string | null;
  fitRequest: number;
  pathNoteId: string | null;
  layer: DeepeningLayer;
  listMode: boolean;
  compactLayoutRef: MutableRefObject<boolean>;
  listboxId: string;
  setQuery: Dispatch<SetStateAction<string>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setSearchActiveIndex: Dispatch<SetStateAction<number>>;
  setStateFilter: Dispatch<SetStateAction<StateFilter>>;
  setShowEvidence: Dispatch<SetStateAction<boolean>>;
  setShowSources: Dispatch<SetStateAction<boolean>>;
  setShowLinks: Dispatch<SetStateAction<boolean>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setIndexActiveIndex: Dispatch<SetStateAction<number>>;
  setPendingFocusId: Dispatch<SetStateAction<string | null>>;
  setFitRequest: Dispatch<SetStateAction<number>>;
  setPathNoteId: Dispatch<SetStateAction<string | null>>;
  setLayer: Dispatch<SetStateAction<DeepeningLayer>>;
  setListMode: Dispatch<SetStateAction<boolean>>;
};

export function useGraphControls(
  compactLayout: boolean,
): GraphControls {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchActiveIndex, setSearchActiveIndex] = useState(-1);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [showEvidence, setShowEvidence] = useState(true);
  const [showSources, setShowSources] = useState(true);
  const [showLinks, setShowLinks] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [indexActiveIndex, setIndexActiveIndex] = useState(0);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  /**
   * 39d W8-1 · W8-3：**一个**选中笔记 + **一个**层。三个尺度同一条路径，
   * 换层不换笔记，换笔记回到层一（见上面那段注释）。
   */
  const [pathNoteId, setPathNoteId] = useState<string | null>(null);
  const [layer, setLayer] = useState<DeepeningLayer>("overview");
  /**
   * §11.5「星图不可用时提供相同笔记和下一步的列表」：**随时**可切的等价册页，
   * 不是只在画布挂掉时才出现的降级件。降级件只有坏掉那天才在，就没法当"等价"
   * 来验收——用户得能在画布好好的时候也走一遍，才知道它做的事一样多。
   */
  const [listMode, setListMode] = useState(false);
  const compactLayoutRef = useRef(compactLayout);
  const listboxId = `universe-search-listbox-${useId().replace(/:/g, "")}`;
  return {
    query, setQuery, deferredQuery,
    searchOpen, setSearchOpen, searchActiveIndex, setSearchActiveIndex,
    stateFilter, setStateFilter,
    showEvidence, setShowEvidence, showSources, setShowSources, showLinks, setShowLinks,
    selectedId, setSelectedId, indexActiveIndex, setIndexActiveIndex,
    pendingFocusId, setPendingFocusId, fitRequest, setFitRequest,
    pathNoteId, setPathNoteId, layer, setLayer, listMode, setListMode,
    compactLayoutRef, listboxId,
  };
}
