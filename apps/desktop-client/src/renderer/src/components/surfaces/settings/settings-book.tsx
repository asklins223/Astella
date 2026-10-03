import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, CircleHelp, ChevronDown, House, Leaf, Settings2, ShieldCheck, Sparkles, Users, Archive, X } from "lucide-react";
import { useRoomStore } from "../../../app/room-store";
import { HudPage } from "../../hud/HudPage";
import { SurfaceDataState } from "../notebook/surface-data";
import { useSettingsTactile } from "./use-settings-tactile";

export const SETTINGS_SECTIONS = [
  { id: "account", label: "账户与空间", icon: House, description: "你的个人资料，和正在使用的学习空间。", tone: "mint" },
  { id: "members", label: "成员与邀请", icon: Users, description: "加入一间书房，或邀请别人来一起学习。", tone: "peach" },
  { id: "appearance", label: "主题与动效", icon: Leaf, description: "挑一个喜欢的光线，再试试书房的弹性手感。", tone: "yellow" },
  { id: "companion", label: "伴星设置", icon: Sparkles, description: "什么时候陪伴、用什么声音，都按你的习惯来。", tone: "mint" },
  { id: "data", label: "AI 数据同意", icon: ShieldCheck, description: "哪些内容可以交给 AI，由你自己决定。", tone: "sky" },
  { id: "management", label: "数据与维护", icon: Archive, description: "收好学习内容的副本，照看这间书房。", tone: "peach" },
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export function SettingsBook(props: {
  readonly section: SettingsSectionId;
  readonly onSectionChange: (value: SettingsSectionId) => void;
  readonly workspaceName?: string;
  readonly loading: boolean;
  readonly failure: string | null;
  readonly onRetry: () => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly footerNote?: string;
  readonly notice: string | null;
  readonly failureNotice: string | null;
  readonly onDismissNotice: () => void;
  readonly onReplayIntro?: () => void;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const scrollPositions = useRef(new Map<SettingsSectionId, number>());
  const [hasMore, setHasMore] = useState(false);
  const mode = useRoomStore(state => state.reducedMotion ? "off" : state.motionMode);
  useSettingsTactile(rootRef);
  const definition = SETTINGS_SECTIONS.find(section => section.id === props.section)!;
  const navigate = (section: SettingsSectionId) => {
    if (bodyRef.current) scrollPositions.current.set(props.section, bodyRef.current.scrollTop);
    props.onSectionChange(section);
  };
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = scrollPositions.current.get(props.section) ?? 0;
    const sync = () => {
      scrollPositions.current.set(props.section, body.scrollTop);
      setHasMore(body.scrollHeight - body.scrollTop - body.clientHeight > 5);
    };
    sync();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    const mutation = new MutationObserver(sync);
    resize?.observe(body);
    if (body.firstElementChild) resize?.observe(body.firstElementChild);
    mutation.observe(body, { childList: true, subtree: true, characterData: true });
    body.addEventListener("scroll", sync, { passive: true });
    return () => { resize?.disconnect(); mutation.disconnect(); body.removeEventListener("scroll", sync); };
  }, [props.section, props.loading, props.failure]);

  return <HudPage page="settings" showTitle={false}>
    <section ref={rootRef} className="settings-hud" data-layout="book" data-motion={mode}>
      <header className="settings-book-header">
        <span className="settings-book-badge" aria-hidden="true"><Settings2 size={28} /><i /></span>
        <div className="settings-book-heading"><h1>设置中心</h1><p>把书房调成舒服的样子</p></div>
        {props.workspaceName ? <span className="settings-book-space"><House size={15} aria-hidden="true" /><span>{props.workspaceName}</span></span> : null}
      </header>
      <div className="settings-book-spread">
      <aside className="settings-book-index">
      <nav className="settings-menu" aria-label="设置分类">
        <span className="settings-menu__cushion" data-settings-cushion aria-hidden="true" />
        {SETTINGS_SECTIONS.map(({ id, label, icon: Icon, tone }, index) => <button
          key={id} ref={element => { buttonRefs.current[index] = element; }}
          type="button" className={props.section === id ? "active" : undefined}
          aria-current={props.section === id ? "page" : undefined} aria-label={label}
          data-tone={tone} onClick={() => navigate(id)} onKeyDown={event => {
            const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % SETTINGS_SECTIONS.length
              : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + SETTINGS_SECTIONS.length - 1) % SETTINGS_SECTIONS.length
              : event.key === "Home" ? 0 : event.key === "End" ? SETTINGS_SECTIONS.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); navigate(SETTINGS_SECTIONS[next].id); buttonRefs.current[next]?.focus();
          }}>
          <span className="settings-menu__icon" aria-hidden="true"><Icon size={20} /></span><span>{label}</span>
        </button>)}
      </nav>
      {props.onReplayIntro ? <button type="button" className="settings-book-help" onClick={props.onReplayIntro}><CircleHelp size={16} aria-hidden="true" /><span>重新认识书房</span></button> : null}
      </aside>
      <article className={`settings-card${props.loading || props.failure ? " settings-card--state" : " preference"}`} aria-labelledby="settings-panel-title">
        <header className="settings-panel-header"><h2 id="settings-panel-title" className="title">{props.title}</h2><p>{definition.description}</p></header>
        {props.failureNotice || props.notice ? <div id="settings-action-message" className={`settings-notice${props.failureNotice ? " settings-notice--error" : ""}`} role={props.failureNotice ? "alert" : "status"}>
          {props.failureNotice ? <CircleAlert size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}<span>{props.failureNotice ?? props.notice}</span>
          <button type="button" className="settings-notice__dismiss" aria-label="收起操作提示" onClick={props.onDismissNotice}><X size={15} aria-hidden="true" /></button>
        </div> : null}
        <div className="settings-body" ref={bodyRef}>
          <div className="settings-page-content" data-settings-page={props.section}>
            {props.loading ? <SurfaceDataState kind="loading" message="正在读取设置" detail="这一页只显示服务器确认过的账户、空间与能力。" />
              : props.failure ? <SurfaceDataState kind="error" message="设置暂时不可用" detail={props.failure} onRetry={props.onRetry} />
              : props.children}
          </div>
        </div>
        <footer className="settings-actions">
          <span className="small">{props.loading || props.failure ? "先读取当前状态，再按你的习惯调整。" : props.footerNote}</span>
          {hasMore ? <button type="button" className="settings-more" onClick={() => bodyRef.current?.scrollBy({ top: Math.max(100, bodyRef.current.clientHeight * .72), behavior: mode === "full" ? "smooth" : "auto" })}>往下看看<ChevronDown size={14} aria-hidden="true" /></button> : null}
        </footer>
      </article>
      </div>
    </section>
  </HudPage>;
}
