import { useLayoutEffect, useRef, type RefObject } from "react";
import { ArrowLeft, Check, ChevronDown, Layers3, Search, Sparkles, X } from "lucide-react";
import type { ObjectiveCardGroupV2 } from "@ailearn/shared/objective-card-groups-v2";
import type { ObjectiveListItemV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import { useCardObjectSpring, useCardVisibleArrival } from "../../motion/card-object-spring";
import { CardPackObject, CardPackLearningCard, CardPackCardSpot } from "./card-pack-object";
import { cardStrategyPresentation } from "../review/card-strategy-presentation";
import { formatObjectiveState, objectiveProgressChips } from "../run/objective-state-copy";
import { readObjectiveLibraryView, writeObjectiveLibraryView, type ObjectiveLibraryFilter } from "../run/objective-library-view-state";

type Group = ObjectiveCardGroupV2<ObjectiveListItemV3>;
const filters = [{ key: "all", label: "全部卡片" }, { key: "attention", label: "需要处理" }, { key: "progress", label: "正在学习" }, { key: "stable", label: "已经答对过" }] as const;

/** One note is one pack. Opening a pack is browsing, and never starts a learning run. */
export function CardCollection(props: {
  groups: readonly Group[]; allGroups: readonly Group[]; filterMenuOpen: boolean;
  openPackKey: string | null; onPack(key: string | null): void;
  query: string; filter: ObjectiveLibraryFilter; countLine: string; hasMore: boolean;
  loadingMore: boolean; pageFailure: string | null; listRef: RefObject<HTMLDivElement | null>;
  onFilterMenu(open: boolean): void; onOpen(id: string): void;
  onQuery(value: string): void; onFilter(value: ObjectiveLibraryFilter): void;
  onMake(): void; onMore(): void; onScroll(value: number): void;
}) {
  const rootRef = useRef<HTMLElement>(null), menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null), searchRef = useRef<HTMLInputElement>(null);
  const { openPackKey, onPack: setOpenPackKey } = props;
  const openGroup = props.groups.find(group => group.noteKey === openPackKey);
  const openHeadingRef = useRef<HTMLHeadingElement>(null);
  const lastOpenKey = useRef(openPackKey), firstMount = useRef(true);
  useCardVisibleArrival(rootRef, "packs");
  const menu = useCardObjectSpring(menuRef, { open: props.filterMenuOpen ? 1 : 0 });
  const wasMenuOpen = useRef(props.filterMenuOpen);
  useLayoutEffect(() => {
    menu.current?.target({ open: props.filterMenuOpen ? 1 : 0 });
    if (props.filterMenuOpen && !wasMenuOpen.current) menuRef.current?.querySelector<HTMLElement>("[aria-pressed='true']")?.focus({ preventScroll: true });
    wasMenuOpen.current = props.filterMenuOpen;
  }, [props.filterMenuOpen, menu]);
  useLayoutEffect(() => {
    if (openPackKey && !openGroup) { setOpenPackKey(null); writeObjectiveLibraryView({ openPackKey: null, scrollTop: 0 }); }
  }, [openGroup, openPackKey, setOpenPackKey]);
  useLayoutEffect(() => {
    const list = props.listRef.current;
    if (firstMount.current) {
      firstMount.current = false;
      const id = readObjectiveLibraryView().lastObjectiveId;
      if (id && openGroup) [...(list?.querySelectorAll<HTMLElement>("[data-objective-id]") ?? [])].find(button => button.dataset.objectiveId === id)?.focus({ preventScroll: true });
    } else if (lastOpenKey.current !== openPackKey) {
      if (list) list.scrollTop = openGroup ? 0 : readObjectiveLibraryView().galleryScrollTop;
      if (openGroup) openHeadingRef.current?.focus({ preventScroll: true });
      else [...(list?.querySelectorAll<HTMLElement>("[data-pack-key] button") ?? [])].find(button => button.closest<HTMLElement>("[data-pack-key]")?.dataset.packKey === lastOpenKey.current)?.focus({ preventScroll: true });
    }
    lastOpenKey.current = openPackKey;
  }, [openPackKey, openGroup, props.listRef]);
  const togglePack = (key: string) => {
    const closing = openPackKey === key;
    const galleryScrollTop = closing ? readObjectiveLibraryView().galleryScrollTop : props.listRef.current?.scrollTop ?? 0;
    writeObjectiveLibraryView({ openPackKey: closing ? null : key, galleryScrollTop, scrollTop: closing ? galleryScrollTop : 0 });
    setOpenPackKey(closing ? null : key);
  };
  const closeMenu = () => { props.onFilterMenu(false); filterRef.current?.focus({ preventScroll: true }); };
  return <section ref={rootRef} className="card-collection" aria-label="学习卡包" data-pack-open={Boolean(openGroup)} onKeyDown={event => {
    if (event.key === "Escape" && props.filterMenuOpen) { event.stopPropagation(); closeMenu(); }
    else if (event.key === "Escape" && event.target === searchRef.current && props.query) { event.stopPropagation(); props.onQuery(""); }
    else if (event.key === "Escape" && openGroup) { event.stopPropagation(); togglePack(openGroup.noteKey); }
    else if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); searchRef.current?.focus(); }
  }}>
    <header className="card-collection__header">
      <div className="card-collection__welcome"><span className="card-collection__emblem" aria-hidden="true"><Layers3 size={27} /></span><div><h3>我的学习卡包</h3><p>一篇笔记，一套值得记住的知识。<span>{props.hasMore ? "已载入" : "共"} {props.allGroups.length} 套 · {props.countLine}</span></p></div></div>
      <button type="button" className="button primary" onClick={props.onMake}><Sparkles size={17} aria-hidden="true" />做一套新卡</button>
    </header>
    <div className="card-collection__find-line">
      <label className="card-collection__search"><Search size={17} aria-hidden="true" /><span className="sr-only">搜索学习卡</span><input ref={searchRef} value={props.query} onChange={event => props.onQuery(event.target.value)} placeholder={props.hasMore ? "找已载入的卡包或知识点" : "找一篇笔记，或一个知识点…"} />{props.query ? <button type="button" aria-label="清空学习卡搜索" onClick={() => { props.onQuery(""); searchRef.current?.focus(); }}><X size={16} aria-hidden="true" /></button> : <kbd aria-hidden="true">/</kbd>}</label>
      <div className="card-collection__filter-control"><button ref={filterRef} type="button" className="text-action" aria-expanded={props.filterMenuOpen} aria-controls="card-collection-filter" onClick={() => props.filterMenuOpen ? closeMenu() : props.onFilterMenu(true)}>{filters.find(item => item.key === props.filter)?.label}<ChevronDown size={15} aria-hidden="true" /></button><div ref={menuRef} id="card-collection-filter" className="card-collection__filter-menu" aria-hidden={!props.filterMenuOpen} inert={!props.filterMenuOpen} role="group" aria-label="筛选学习卡">{filters.map(item => <button key={item.key} type="button" aria-pressed={props.filter === item.key} onClick={() => { props.onFilter(item.key); closeMenu(); }}><span>{item.label}</span>{props.filter === item.key ? <Check size={15} aria-hidden="true" /> : null}</button>)}</div></div>
    </div>
    <div ref={props.listRef} className="card-collection__content" aria-label="学习卡收藏内容" onScroll={event => props.onScroll(event.currentTarget.scrollTop)}>
      {!openGroup ? <p className="card-collection__shelf-caption">{props.query || props.filter !== "all" ? `找到 ${props.groups.length} 套卡包` : "打开一套，看看里面的知识。"}</p> : null}
      <ul className="card-collection__packs" data-open={Boolean(openGroup)} data-count={Math.min(props.groups.length, 3)}>{props.groups.map(group => {
        const opened = group.noteKey === openGroup?.noteKey;
        const fullGroup = props.allGroups.find(item => item.noteKey === group.noteKey) ?? group;
        return <li key={group.noteKey} className="card-collection__pack" data-pack-key={group.noteKey} data-note-group={group.ungrouped ? "ungrouped" : "group"} data-open={opened} hidden={Boolean(openGroup) && !opened}>
          <div className="card-collection__pack-top">
            <CardPackObject identity={group.noteKey} title={group.title} count={fullGroup.items.length} opened={opened} onToggle={() => togglePack(group.noteKey)}><strong>{group.title}</strong><span>{fullGroup.items.length} 张学习卡{fullGroup.items.length !== group.items.length ? ` · 找到 ${group.items.length} 张` : ""}</span></CardPackObject>
            {opened ? <header className="card-collection__pack-heading">
              <span className="card-collection__pack-kicker">从这篇笔记收进来的知识</span>
              <h4 ref={openHeadingRef} tabIndex={-1}>{group.title}</h4>
              <p>{fullGroup.items.length} 张学习卡{fullGroup.items.length !== group.items.length ? ` · 找到 ${group.items.length} 张` : ""} · 翻开一张，开始练习。</p>
              <button type="button" className="text-action" onClick={() => togglePack(group.noteKey)}><ArrowLeft size={17} aria-hidden="true" />全部卡包</button>
            </header> : null}
          </div>
          {opened ? <ul className="card-collection__cards" data-count={Math.min(group.items.length, 3)} aria-label={`${group.title}的学习卡`}>{group.items.map((card, index) => {
            const strategy = card.cardStrategy ? cardStrategyPresentation[card.cardStrategy] : null;
            return <CardPackCardSpot key={card.objectiveId} id={card.objectiveId}><CardPackLearningCard id={card.objectiveId} index={index} title={card.conceptLabel ?? "未命名学习卡"} strategy={card.cardStrategy} strategyLabel={strategy?.label} symbol={strategy?.symbol} summary={card.publicSummary} state={formatObjectiveState(card.personalState.state)} progress={objectiveProgressChips(card.progress).join(" · ")} onOpen={() => props.onOpen(card.objectiveId)} /></CardPackCardSpot>;
          })}</ul> : null}
        </li>;
      })}</ul>
      {!props.groups.length ? <div className="card-collection__empty"><Search size={30} aria-hidden="true" /><h4>没有找到这一套</h4><p>换个关键词，或者看看全部卡包。</p><button type="button" className="button" onClick={() => { props.onQuery(""); props.onFilter("all"); }}>看看全部卡包</button></div> : null}
      <footer className="card-collection__end">{props.hasMore ? <button type="button" className="button" disabled={props.loadingMore} onClick={props.onMore}>{props.loadingMore ? "正在读取…" : "再找一些卡包"}</button> : <span>{openGroup ? "这一套的卡片都在这里了" : "每一套，都从你的一篇笔记长出来。"}</span>}{props.pageFailure ? <p role="alert">{props.pageFailure}<button type="button" className="text-action" onClick={props.onMore}>重试读取</button></p> : null}</footer>
    </div>
  </section>;
}
