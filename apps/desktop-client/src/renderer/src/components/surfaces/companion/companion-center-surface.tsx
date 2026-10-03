import { BookOpen,CircleUserRound,HeartHandshake,Library,MessageCircle,NotebookPen,RefreshCw,Settings2,Sparkles } from "lucide-react";
import { Activity,useEffect,useRef,useState,type KeyboardEvent } from "react";
import { useCompanionChat } from "../../../app/companion-chat-session";
import { useRoomStore } from "../../../app/room-store";
import { HudPage } from "../../hud/HudPage";
import { useHudPage } from "../../hud/use-hud-page";
import { CompanionActivityPage } from "./companion-activity-page";
import { CENTER_PAGES,type CompanionCenterTab } from "./companion-center-model";
import { CompanionDialoguePage } from "./companion-dialogue-page";
import { CompanionDiaryPage } from "./companion-diary-page";
import { CompanionDiscoveryPage } from "./companion-discovery-page";
import { CompanionMemoryPage } from "./companion-memory-page";
import { CompanionOverviewPage } from "./companion-overview-page";
import { CompanionPersonaPage } from "./companion-persona-page";
import { useCompanionTactile } from "./use-companion-tactile";

const PAGE_ICONS = { overview: HeartHandshake, dialogue: MessageCircle, diary: NotebookPen, memory: Library, discovery: BookOpen, activity: Sparkles, persona: CircleUserRound };

/** The little house owns navigation; each room keeps its own data and unfinished work. */
export function CompanionCenterSurface() {
  useHudPage("companion");
  const chat = useCompanionChat();
  const routeTarget = useRoomStore(state => state.companionCenterTarget);
  const motionMode = useRoomStore(state => state.motionMode);
  const reducedMotion = useRoomStore(state => state.reducedMotion);
  const [tab, setTab] = useState<CompanionCenterTab>(routeTarget?.tab && routeTarget.tab !== "data" ? routeTarget.tab : "overview");
  const [refreshKey, setRefreshKey] = useState(0);
  const [focusMemoryId, setFocusMemoryId] = useState<string | null>(routeTarget?.focusMemoryId ?? null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(routeTarget?.focusMessageId ?? null);
  const [diaryDate, setDiaryDate] = useState<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const houseRef = useRef<HTMLDivElement>(null);
  useCompanionTactile(houseRef, tab);
  const active = CENTER_PAGES.find(page => page.id === tab)!;
  const ActiveIcon = PAGE_ICONS[tab];
  const openSettings = () => {
    const room = useRoomStore.getState();
    room.setSettingsSection("companion");
    room.invoke("open-settings");
  };
  useEffect(() => {
    if (!routeTarget) return;
    const room = useRoomStore.getState();
    room.setCompanionCenterTarget(null);
    if (routeTarget.tab === "data") { room.setSettingsSection("companion"); room.invoke("open-settings"); return; }
    setTab(routeTarget.tab);
    if (routeTarget.focusMemoryId) setFocusMemoryId(routeTarget.focusMemoryId);
    if (routeTarget.focusMessageId) setFocusMessageId(routeTarget.focusMessageId);
  }, [routeTarget]);
  const navigate = (next: CompanionCenterTab) => setTab(next);
  const tabKeyDown = (event: KeyboardEvent, index: number) => {
    const count = CENTER_PAGES.length;
    const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1
      : event.key === "ArrowDown" || event.key === "ArrowRight" ? (index + 1) % count
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? (index - 1 + count) % count : null;
    if (next === null) return;
    event.preventDefault();
    navigate(CENTER_PAGES[next].id);
    tabRefs.current[next]?.focus();
  };
  return <HudPage page="companion" wide>
    <div ref={houseRef} className="cc-book" aria-label="伴星中心" data-active-tab={tab} data-motion={reducedMotion ? "off" : motionMode}>
      <aside className="cc-house-rail">
        <div className="cc-house-company" title={chat.companionName}><span className="cc-house-company__dot" aria-hidden="true" /><span>和 <strong>{chat.companionName}</strong> 一起</span></div>
        <nav className="cc-room-tabs" role="tablist" aria-label="伴星中心分区" aria-orientation="vertical">
          <span className="cc-room-tabs__cushion" aria-hidden="true" />
          {CENTER_PAGES.map((page, index) => { const Icon = PAGE_ICONS[page.id]; return <button key={page.id} id={`companion-tab-${page.id}`} data-room={page.id} ref={element => { tabRefs.current[index] = element; }} type="button" role="tab" aria-selected={tab === page.id} aria-controls={`companion-panel-${page.id}`} tabIndex={tab === page.id ? 0 : -1} onKeyDown={event => tabKeyDown(event, index)} onClick={() => navigate(page.id)}><span className="cc-room-tabs__icon" aria-hidden="true"><Icon size={20} strokeWidth={2.2} /></span><span>{page.label}</span></button>; })}
        </nav>
        <button type="button" className="cc-house-settings" onClick={openSettings} aria-label="伴星设置" title="伴星设置"><Settings2 size={17} aria-hidden="true" /><span>伴星设置</span></button>
      </aside>
      <div className="cc-house-main">
        <header className="cc-house-header">
          <span className="cc-house-badge" aria-hidden="true"><ActiveIcon size={26} strokeWidth={2.4} /><i /><i /></span>
          <div className="cc-house-heading"><h2>{active.label}</h2><p>{active.detail}</p></div>
          <button type="button" className="cc-icon-button" onClick={() => setRefreshKey(value => value + 1)} aria-label="刷新当前伴星页面" title="刷新当前页"><RefreshCw size={17} /></button>
        </header>
        <div className="cc-paper">
          {/* Activity preserves unfinished edits while removing hidden pages' effects and readable views. */}
          {CENTER_PAGES.map(page => <Activity key={page.id} mode={tab === page.id ? "visible" : "hidden"}>
            <section className={`cc-page cc-page--${page.id}`} id={`companion-panel-${page.id}`} role="tabpanel" aria-labelledby={`companion-tab-${page.id}`} tabIndex={-1}>
              {page.id === "overview" ? <CompanionOverviewPage refreshKey={refreshKey} onGo={navigate} onDiary={date => { setDiaryDate(date); navigate("diary"); }} /> : null}
              {page.id === "dialogue" ? <CompanionDialoguePage refreshKey={refreshKey} focusMessageId={focusMessageId} onFocusConsumed={() => setFocusMessageId(null)} /> : null}
              {page.id === "diary" ? <CompanionDiaryPage refreshKey={refreshKey} requestedDate={diaryDate} onMemory={id => { setFocusMemoryId(id); navigate("memory"); }} onSettings={openSettings} /> : null}
              {page.id === "memory" ? <CompanionMemoryPage refreshKey={refreshKey} requestedMemoryId={focusMemoryId} onFocusConsumed={() => setFocusMemoryId(null)} /> : null}
              {page.id === "discovery" ? <CompanionDiscoveryPage refreshKey={refreshKey} /> : null}
              {page.id === "activity" ? <CompanionActivityPage refreshKey={refreshKey} onMemory={id => { setFocusMemoryId(id); navigate("memory"); }} onMessage={id => { setFocusMessageId(id); navigate("dialogue"); }} /> : null}
              {page.id === "persona" ? <CompanionPersonaPage refreshKey={refreshKey} onSettings={openSettings} /> : null}
            </section>
          </Activity>)}
        </div>
      </div>
    </div>
  </HudPage>;
}
