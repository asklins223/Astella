import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import type { CompanionPersonaPendingRevisionV1,CompanionPersonaPendingV1,CompanionPersonaPresetV1,CompanionPersonaProfileV1,CompanionPersonaProfileVersionV1,CompanionPersonaV1 } from "@astella/shared/companion-memory-desktop-contracts";
import { PERSONA_FIELD_CAPACITY, personaOriginOf, type PersonaSwitchOption, type SwitchableField } from "@astella/shared/pet-persona-merge";
import { useId,useMemo,useState } from "react";
import { HUD_PAGES } from "../../hud/hud-pages";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { formatDate } from "../notebook/surface-data";
import type { Section } from "./companion-center-model";
import { CenterFeedback,CenterSection,SectionState } from "./companion-center-primitives";

const BOUNDARY_ITEMS = [
  ["allowPlayful", "玩笑", "允许伴星在日常交流里开玩笑"],
  ["allowNudgeLearning", "学习提醒", "允许伴星在合适时机提醒复习"],
  ["allowVoiceTags", "声音表达", "让语气随对话变化，并在合适时轻笑或叹息"],
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

type PersonaPanelProps = { section: Section<CompanionPersonaV1>; persona: CompanionPersonaV1 | null; versions: CompanionPersonaProfileVersionV1[] | null; versionsError: string | null; busy: string | null; error: string | null; notice: string | null; onPreset: (preset: CompanionPersonaPresetV1) => void; onActiveness: (value: CompanionPersonaProfileV1["activeness"]) => void; onBoundary: (key: (typeof BOUNDARY_ITEMS)[number][0]) => void; onReset: () => void; onRestore: (revision: number) => void; onReloadVersions: () => void; onRename: (name: string) => Promise<boolean> | void; onSelfDescription: (text: string) => Promise<boolean> | void; onSettings?: () => void; onRetry: () => void; switchTarget?: CompanionPersonaPresetV1 | null; switchOptions?: readonly PersonaSwitchOption[]; overwrite?: readonly SwitchableField[]; onOverwrite?: (fields: readonly SwitchableField[]) => void; onSwitchCancel?: () => void; onSwitchConfirm?: () => void } & PersonaPendingProps;

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

/**
 * 她怎么说自己（方案 50 §8.1）。
 *
 * 与「说话风格」分开显示是刻意的：那一行是**你或预设给她的说法要求**，这一行是
 * 她自己回顾相处之后攒下的认识。混在一句话里，用户分不清哪句是自己写的，
 * 也就看不出"她变了"这件事到底发生过没有。
 *
 * 允许直接改和清空（来源从此记 `user`）——她能提，你也改得动，才算双向。
 */
function CompanionSelfDescriptionRow(props: {
  readonly current: string;
  readonly busy: boolean;
  readonly origin: string;
  readonly onSave: (text: string) => Promise<boolean> | void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.current;
  const trimmed = shown.trim();
  const dirty = trimmed !== props.current.trim();
  const commit = async () => { const saved = await props.onSave(trimmed); if (saved !== false) setDraft(null); };
  return <div className="cc-self-description">
    <label className="cc-self-description__field">
      <span className="cc-kicker">她怎么说自己<OriginBadge origin={props.origin} /></span>
      <textarea
        value={shown}
        rows={3}
        maxLength={PERSONA_FIELD_CAPACITY.selfDescription}
        aria-label="她怎么说自己"
        disabled={props.busy}
        placeholder={props.current ? undefined : "等她回顾过一段相处，这一句会自己长出来。你也可以先写一句。"}
        onChange={(event) => setDraft(event.target.value)}
      />
    </label>
    <div className="cc-actions">
      <button type="button" className="button primary" disabled={props.busy || !dirty} onClick={commit}>
        {trimmed.length === 0 ? "清空这一句" : "改这一句"}
      </button>
      {dirty ? <button type="button" disabled={props.busy} onClick={() => setDraft(null)}>取消</button> : null}
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

/**
 * 待生效那一版是谁提的、出自哪一次提议。
 *
 * 同一个人格修订，"她在这次对话里被你指出后改的"与"她自己回顾了一段相处之后改的"
 * 是两件不同的事（方案 50 §9.4 要求用户能察觉变化从哪来）。旧数据没有提案身份，
 * 就只说作者，不编一个来源出来。
 */
function pendingAuthorLabel(pending: CompanionPersonaPendingRevisionV1): string {
  if (pending.author === "assistant_tool" && pending.proposalKind === "assistant_reflection") {
    return "她回顾这段相处后提的";
  }
  return PERSONA_VERSION_AUTHOR_LABEL[pending.author];
}

const PERSONA_PENDING_LOADING = "正在加载待生效版本…";

/** 这一项是谁写的 —— 屏上要能看见「她改的」，否则"她能自己改"只是后台的事。 */
function OriginBadge({ origin }: { readonly origin: string }) {
  if (origin === "preset") return null;
  return <span className="cc-origin" data-origin={origin}>{origin === "user" ? "你改的" : "她改的"}</span>;
}

/**
 * 换人格之前的那一问。
 *
 * 为什么不是"直接换掉"：点一次卡片就把她攒下的语气、口头禅和你调过的开关清空，
 * 而事后只有一句"已保存"。这里把**只有你们改过的那些**列出来，逐项让用户决定
 * 留不留；名字不在其中（她改不了，你也起过）。
 *
 * 默认全部保留：用户要点第二下才发生不可逆的那件事。
 */
function PersonaSwitchSheet(props: {
  readonly target: CompanionPersonaPresetV1;
  readonly options: readonly PersonaSwitchOption[];
  readonly overwrite: readonly SwitchableField[];
  readonly busy: boolean;
  readonly onChange: (fields: readonly SwitchableField[]) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const kept = props.options.length - props.overwrite.length;
  const toggle = (field: SwitchableField) => props.onChange(
    props.overwrite.includes(field) ? props.overwrite.filter((entry) => entry !== field) : [...props.overwrite, field],
  );
  return <div className="cc-switch-sheet" role="group" aria-label={`换成 ${props.target.name} 之前`}>
    <h4>换成「{props.target.name}」</h4>
    {props.options.length === 0
      ? <p className="cc-muted">你和她的改动都还是预设原样，这次换过去不会有东西被盖掉。</p>
      : <><p className="cc-switch-sheet__lead">下面这些不是预设写的，<strong>默认全部替你留着</strong>。勾上的才会换成新预设的样子。</p>
        <ul className="cc-switch-list cc-switch-list--pick">{props.options.map(option => <li key={option.field}>
          <label>
            <input
              type="checkbox"
              checked={props.overwrite.includes(option.field)}
              disabled={props.busy}
              onChange={() => toggle(option.field)}
            />
            <span>
              <strong>{option.label}<OriginBadge origin={option.origin} /></strong>
              <small>现在：{option.current || "（空）"}</small>
              {option.changes ? <small>换过去会变成：{option.next || "（空）"}</small> : null}
            </span>
          </label>
        </li>)}</ul>
        <p className="cc-muted">名字不在其中：她改不了，你也起过。</p></>}
    <div className="cc-switch-sheet__actions">
      <button type="button" onClick={props.onCancel} disabled={props.busy}>取消</button>
      <button type="button" className="button primary" onClick={props.onConfirm} disabled={props.busy}>
        {props.busy ? "正在切换人格…" : props.options.length === 0 ? `换成「${props.target.name}」` : `就这样换（保留 ${kept} 项）`}
      </button>
    </div>
  </div>;
}

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
  // 来源只挂在账号档案上。还没有档案时生效的是系统默认人格，那一档全部算 preset。
  const fieldOrigin = props.persona.profile?.fieldOrigin;
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
        <div className="cc-tags">{profile?.personalityTags.map(tag => <span className="cc-tag" key={tag}>{tag}</span>)}<OriginBadge origin={personaOriginOf(fieldOrigin, "personalityTags")} /></div>
        <p>{profile?.speakingStyle ?? "正在使用系统默认表达。"}<OriginBadge origin={personaOriginOf(fieldOrigin, "speakingStyle")} /></p>
        {/* 预设里没有"出厂的自我描述"这一项：它只可能来自账号档案。 */}
        <CompanionSelfDescriptionRow
          current={props.persona.profile?.selfDescription ?? ""}
          busy={props.busy !== null}
          origin={personaOriginOf(fieldOrigin, "selfDescription")}
          onSave={props.onSelfDescription}
        />
        {profile?.examples.length ? <blockquote>{profile.examples[0].text}</blockquote> : null}
      </section>
      <section className="cc-persona-name"><h4>她叫什么</h4><p>用在署名、对话和书桌旁的称呼。</p>
        {profile ? <CompanionNameRow current={profile.name} busy={props.busy !== null} onRename={props.onRename} /> : <p>先选一份人格预设，就能给她取名。</p>}
      </section>
    </div>
    <CenterSection title={PERSONA_SECTIONS.appearance} detail="每份都是完整的表达方式，包含名字、语气、示例与边界。选择后会生成新版本。">
      <div className="cc-persona-presets">{props.persona.presets.map(preset => <button key={preset.presetId} type="button" aria-pressed={props.switchTarget ? props.switchTarget.presetId === preset.presetId : profile?.presetId === preset.presetId} disabled={props.busy !== null} onClick={() => props.onPreset(preset)}><span><strong>{preset.name}</strong>{profile?.presetId === preset.presetId ? <small>当前预设</small> : null}</span><p>{preset.speakingStyle}</p><small>{preset.personalityTags.join(" · ")}</small></button>)}</div>
      {props.switchTarget && props.onSwitchConfirm && props.onSwitchCancel && props.onOverwrite
        ? <PersonaSwitchSheet target={props.switchTarget} options={props.switchOptions ?? []} overwrite={props.overwrite ?? []} busy={props.busy !== null} onChange={props.onOverwrite} onCancel={props.onSwitchCancel} onConfirm={props.onSwitchConfirm} />
        : null}
    </CenterSection>
    <div className="cc-persona-expression">
      <CenterSection title="表达分量" detail="决定她一次说多少、日记写多细。">
        <div className="cc-segments" role="group" aria-label="人格表达分量">{(["quiet", "moderate", "active"] as const).map(value => <button key={value} type="button" aria-pressed={profile?.activeness === value} disabled={props.busy !== null} onClick={() => props.onActiveness(value)}>{activenessLabel(value)}</button>)}</div>
        <p className="cc-muted cc-origin-line"><OriginBadge origin={personaOriginOf(fieldOrigin, "activeness")} />她可以自己调这一档，你也可以。</p>
        <p className="cc-muted">主动介入的时机和间隔在伴星设置里管理。</p>{props.onSettings ? <button type="button" className="cc-link" onClick={props.onSettings}>调整主动介入</button> : null}
      </CenterSection>
      <CenterSection title={PERSONA_SECTIONS.boundaries} detail="这些边界只影响她怎样表达。">
        <div className="cc-switch-list">{BOUNDARY_ITEMS.map(([key, label, detail]) => <button key={key} type="button" role="switch" aria-checked={profile?.boundaries[key] === true} disabled={props.busy !== null} onClick={() => props.onBoundary(key)}><span><strong>{label}</strong><OriginBadge origin={personaOriginOf(fieldOrigin, `boundaries.${key}`)} /><small>{detail}</small></span><span className="cc-switch" data-on={profile?.boundaries[key] === true || undefined} aria-hidden="true"><i /></span></button>)}</div>
      </CenterSection>
    </div>
    <CenterSection title={PERSONA_SECTIONS.pending} detail="她自己的调整会先排在这里。生效条件以这一版的说明为准。">
      {props.pendingError ? <SectionState message="待生效版本暂时读不到" detail={props.pendingError} onRetry={props.onRetryPending} />
        : !props.pending ? <p className="cc-muted" role="status">{PERSONA_PENDING_LOADING}</p>
        : props.pending.pending === null ? <p className="cc-muted">{PERSONA_NO_PENDING}</p>
        : <article className="cc-persona-pending"><div><strong>第 {props.pending.pending.revision} 版 · {props.pending.pending.profile?.name ?? "回到默认表达"}</strong><small>{pendingAuthorLabel(props.pending.pending)} · {formatDate(props.pending.pending.stagedAt)}</small><p>{props.pending.pending.profile?.speakingStyle ?? props.pending.pending.profile?.selfDescription ?? "这一版会恢复默认人格表达。"}</p>{props.pending.pending.reason ? <p className="cc-pending-reason">{props.pending.pending.reason}</p> : null}<span className="cc-tag">{props.pending.pending.effectiveWhen}</span></div><button type="button" className="button primary" disabled={props.busy !== null} onClick={props.onActivatePending}>{props.busy === "activate-pending" ? "正在应用这一版…" : "现在生效"}</button></article>}
    </CenterSection>
    <details className="cc-persona-history"><summary>人格版本记录{props.versions ? ` · ${props.versions.length} 版` : ""}</summary>
      <p className="cc-muted">恢复旧版会留下新版本。各个书房累积的熟悉度会保留。</p>
      {props.versionsError ? <SectionState message="版本记录暂时无法读取" detail={props.versionsError} onRetry={props.onReloadVersions} /> : !props.versions ? <p role="status">正在加载版本记录…</p> : props.versions.length === 0 ? <p>还没有人格版本记录。</p> : <div id={olderVersionsId}>{props.versions.map(versionCard)}</div>}
    </details>
    <div className="cc-page-note"><span>回到当前发布的默认人格，同样会留下版本记录。</span><button type="button" className="cc-link" disabled={!props.persona.profile || props.busy !== null} onClick={props.onReset}>恢复系统默认人格</button></div>
  </div>;
}
