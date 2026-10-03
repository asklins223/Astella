import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import type { CompanionPersonaPendingRevisionV1,CompanionPersonaPendingV1,CompanionPersonaPresetV1,CompanionPersonaProfileV1,CompanionPersonaProfileVersionV1,CompanionPersonaV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { useId,useMemo,useState } from "react";
import { HUD_PAGES } from "../../hud/hud-pages";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { formatDate } from "../notebook/surface-data";
import type { Section } from "./companion-center-model";
import { CenterFeedback,CenterSection,SectionState } from "./companion-center-primitives";

const BOUNDARY_ITEMS = [
  ["allowPlayful", "玩笑", "允许伴星在日常交流里开玩笑"],
  ["allowNudgeLearning", "学习提醒", "允许伴星在合适时机提醒复习"],
  ["allowVoiceTags", "语气标签", "允许回复携带表演语气"],
] as const;

type PersonaPendingProps = {
  /**
   * 读回的那一版与它的指针。**缺省 = 还没读到**，面板因此先不出声。
   *
   * 「读到且没有排队」不是 `null`，而是 `{ pending: null }` —— 把它做成缺省，
   * "还没读过" 与 "读过了，没有排队" 就成了同一个值，而后者是面板可以断言的事实，
   * 前者不是。
   */
  readonly pending?: CompanionPersonaPendingV1;
  readonly pendingError?: string | null;
  readonly onActivatePending?: () => void;
  readonly onRetryPending?: () => void;
};

type PersonaPanelProps = { section: Section<CompanionPersonaV1>; persona: CompanionPersonaV1 | null; versions: CompanionPersonaProfileVersionV1[] | null; versionsError: string | null; busy: string | null; error: string | null; notice: string | null; onPreset: (preset: CompanionPersonaPresetV1) => void; onActiveness: (value: CompanionPersonaProfileV1["activeness"]) => void; onBoundary: (key: (typeof BOUNDARY_ITEMS)[number][0]) => void; onReset: () => void; onRestore: (revision: number) => void; onReloadVersions: () => void; onRename: (name: string) => Promise<boolean> | void; onSettings?: () => void; onRetry: () => void } & PersonaPendingProps;

function CompanionNameRow(props: { readonly current: string; readonly busy: boolean; readonly onRename: (name: string) => Promise<boolean> | void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.current;
  const trimmed = shown.trim();
  const dirty = trimmed.length > 0 && trimmed !== props.current;
  const commit = async () => { const saved = await props.onRename(trimmed); if (saved !== false) setDraft(null); };
  return <div className="cc-name-form">
    <input
      type="text"
      value={shown}
      maxLength={60}
      aria-label="她叫什么"
      disabled={props.busy}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && dirty) { event.preventDefault(); commit(); } }}
    />
    <div className="cc-actions">
      <button type="button" className="button primary" disabled={props.busy || !dirty} onClick={commit}>改名</button>
      {dirty ? <button type="button" onClick={() => setDraft(null)}>取消</button> : null}
    </div>
  </div>;
}

const PERSONA_UNAVAILABLE = "人格档案当前不可用";

const PERSONA_SECTIONS = { appearance: "人格预设", boundaries: "边界", pending: "待生效版本" } as const;

function activenessLabel(value: CompanionPersonaProfileV1["activeness"] | undefined): string | null {
  if (value === "quiet") return "安静";
  if (value === "moderate") return "适度";
  if (value === "active") return "活跃";
  return null;
}

const PERSONA_VERSION_AUTHOR_LABEL: Record<CompanionPersonaPendingRevisionV1["author"], string> = {
  user: "你排的",
  assistant_tool: "她调整的",
  restore: "恢复旧版时排的",
  migration: "历史导入",
};

const PERSONA_NO_PENDING = "现在没有排队的人格版本。";

const PERSONA_PENDING_LOADING = "正在读取待生效版本…";

export function PersonaPanel(props: PersonaPanelProps) {
  const olderVersionsId = useId();
  const personaReadableView = useMemo<PageReadableV1 | null>(() => {
    const profile = props.persona?.profile ?? props.persona?.activePreset ?? null;
    if (!props.section.ok || !props.persona) {
      return {
        pageId: "companion",
        title: HUD_PAGES.companion.title,
        statusLine: PERSONA_UNAVAILABLE,
        ...(!props.section.ok ? { notice: `${PERSONA_UNAVAILABLE}：${props.section.message.slice(0, 60)}` } : {}),
      };
    }
    const rows: Array<{ label: string; state: string }> = [];
    const push = (label: string, state: string) => {
      if (label.trim() && rows.length < 12) rows.push({ label, state });
    };
    props.persona.presets.forEach((preset) => push(preset.name, PERSONA_SECTIONS.appearance));
    BOUNDARY_ITEMS.forEach(([, label]) => push(label, PERSONA_SECTIONS.boundaries));
    const presetName = props.persona.presets.find((preset) => preset.presetId === profile?.presetId)?.name;
    // 「当前 / 待生效 + 生效条件」是合同点名要在**回执**里给出的一格（A50）。
    // 它进 filters 而不是 notice：它是屏上那一段的稳定事实，不是刚发生的一次结果。
    const pendingRevision = props.pending?.pending?.revision ?? null;
    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      statusLine: props.notice ?? props.error ?? undefined,
      filters: [
        { label: "当前版本", value: `第 ${props.persona.profileRevision} 版`.slice(0, 40) },
        ...(presetName ? [{ label: "当前预设", value: presetName.slice(0, 40) }] : []),
        ...(activenessLabel(profile?.activeness) ? [{ label: "表达分量", value: activenessLabel(profile?.activeness)!.slice(0, 40) }] : []),
        ...(pendingRevision ? [
          { label: "待生效版本", value: `第 ${pendingRevision} 版`.slice(0, 40) },
          { label: "生效条件", value: props.pending!.pending!.effectiveWhen.slice(0, 40) },
        ] : []),
      ],
      items: rows.map((row, index) => ({ ordinal: index + 1, label: row.label.slice(0, 120), state: row.state.slice(0, 40) })),
    };
  }, [props.error, props.notice, props.pending, props.persona, props.section]);
  usePageReadableView(personaReadableView);
  if (!props.section.ok || !props.persona) return <SectionState message={PERSONA_UNAVAILABLE} detail={!props.section.ok ? props.section.message : undefined} onRetry={props.onRetry} />;
  const profile = props.persona.profile ?? props.persona.activePreset;
  const currentRevision = props.persona.profileRevision;
  const pendingRevision = props.pending?.pending?.revision ?? null;
  const versionCard = (version: CompanionPersonaProfileVersionV1) => <article key={version.id} className="cc-version" data-pending={version.revision === pendingRevision || undefined}>
    <div><strong>第 {version.revision} 版 · {version.profile?.name ?? "系统默认"}</strong><small>{formatDate(version.createdAt)} · {version.action === "reset" ? "恢复默认" : version.action === "restore" ? "恢复旧版" : version.action === "migration" ? "历史导入" : version.author === "assistant_tool" ? "伴星调整" : "手动修改"}</small></div>
    <span className="cc-tag">{version.revision === pendingRevision ? "待生效" : version.revision === currentRevision ? "当前版本" : "旧版"}</span>
    <button type="button" className="cc-link" disabled={props.busy !== null || version.revision === currentRevision} onClick={() => props.onRestore(version.revision)}>恢复第 {version.revision} 版</button>
  </article>;
  return <div className="cc-persona">
    <CenterFeedback error={props.error} notice={props.notice} />
    <div className="cc-persona-profile">
      <section className="cc-persona-identity" aria-label="当前人格">
        <span className="cc-kicker">当前第 {currentRevision} 版 · 账号共享</span>
        <h3>{profile?.name ?? "伴星"}</h3>
        <div className="cc-tags">{profile?.personalityTags.map(tag => <span className="cc-tag" key={tag}>{tag}</span>)}</div>
        <p>{profile?.speakingStyle ?? "正在使用系统默认表达。"}</p>
        {profile?.examples.length ? <blockquote>{profile.examples[0].text}</blockquote> : null}
      </section>
      <section className="cc-persona-name"><h4>她叫什么</h4><p>用在署名、对话和书桌旁的称呼。</p>
        {profile ? <CompanionNameRow current={profile.name} busy={props.busy !== null} onRename={props.onRename} /> : <p>先选一份人格预设，就能给她取名。</p>}
      </section>
    </div>
    <CenterSection title={PERSONA_SECTIONS.appearance} detail="每份都是完整的表达方式，包含名字、语气、示例与边界。选择后会生成新版本。">
      <div className="cc-persona-presets">{props.persona.presets.map(preset => <button key={preset.presetId} type="button" aria-pressed={profile?.presetId === preset.presetId} disabled={props.busy !== null} onClick={() => props.onPreset(preset)}><span><strong>{preset.name}</strong>{profile?.presetId === preset.presetId ? <small>当前预设</small> : null}</span><p>{preset.speakingStyle}</p><small>{preset.personalityTags.join(" · ")}</small></button>)}</div>
    </CenterSection>
    <div className="cc-persona-expression">
      <CenterSection title="表达分量" detail="决定她一次说多少、日记写多细。">
        <div className="cc-segments" role="group" aria-label="人格表达分量">{(["quiet", "moderate", "active"] as const).map(value => <button key={value} type="button" aria-pressed={profile?.activeness === value} disabled={!profile || props.busy !== null} onClick={() => props.onActiveness(value)}>{activenessLabel(value)}</button>)}</div>
        <p className="cc-muted">主动介入的时机和间隔在伴星设置里管理。</p>{props.onSettings ? <button type="button" className="cc-link" onClick={props.onSettings}>调整主动介入</button> : null}
      </CenterSection>
      <CenterSection title={PERSONA_SECTIONS.boundaries} detail="这些边界只影响她怎样表达。">
        <div className="cc-switch-list">{BOUNDARY_ITEMS.map(([key, label, detail]) => <button key={key} type="button" role="switch" aria-checked={profile?.boundaries[key] === true} disabled={!profile || props.busy !== null} onClick={() => props.onBoundary(key)}><span><strong>{label}</strong><small>{detail}</small></span><span className="cc-switch" data-on={profile?.boundaries[key] === true || undefined} aria-hidden="true"><i /></span></button>)}</div>
      </CenterSection>
    </div>
    <CenterSection title={PERSONA_SECTIONS.pending} detail="她自己的调整会先排在这里。生效条件以这一版的说明为准。">
      {props.pendingError ? <SectionState message="待生效版本暂时读不到" detail={props.pendingError} onRetry={props.onRetryPending} />
        : !props.pending ? <p className="cc-muted" role="status">{PERSONA_PENDING_LOADING}</p>
        : props.pending.pending === null ? <p className="cc-muted">{PERSONA_NO_PENDING}</p>
        : <article className="cc-persona-pending"><div><strong>第 {props.pending.pending.revision} 版 · {props.pending.pending.profile?.name ?? "回到默认表达"}</strong><small>{PERSONA_VERSION_AUTHOR_LABEL[props.pending.pending.author]} · {formatDate(props.pending.pending.stagedAt)}</small><p>{props.pending.pending.profile?.speakingStyle ?? "这一版会恢复默认人格表达。"}</p><span className="cc-tag">{props.pending.pending.effectiveWhen}</span></div><button type="button" className="button primary" disabled={props.busy !== null} onClick={props.onActivatePending}>{props.busy === "activate-pending" ? "正在生效…" : "现在生效"}</button></article>}
    </CenterSection>
    <details className="cc-persona-history"><summary>人格版本记录{props.versions ? ` · ${props.versions.length} 版` : ""}</summary>
      <p className="cc-muted">恢复旧版会留下新版本。各个书房累积的熟悉度会保留。</p>
      {props.versionsError ? <SectionState message="版本记录暂时无法读取" detail={props.versionsError} onRetry={props.onReloadVersions} /> : !props.versions ? <p role="status">正在读取版本记录…</p> : props.versions.length === 0 ? <p>还没有人格版本记录。</p> : <div id={olderVersionsId}>{props.versions.map(versionCard)}</div>}
    </details>
    <div className="cc-page-note"><span>回到当前发布的默认人格，同样会留下版本记录。</span><button type="button" className="cc-link" disabled={!props.persona.profile || props.busy !== null} onClick={props.onReset}>恢复系统默认人格</button></div>
  </div>;
}
