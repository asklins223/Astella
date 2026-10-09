import { AiConsentTerms } from "../../ai-consent-terms";
import { Activity, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SettingRow, SettingsInlineState, type SettingsReadable } from "./settings-primitives.tsx";
import { SettingsCompanionPanel } from "./settings-companion-panel";
import { SettingsAccountPanel, type AvatarUploadOutcome } from "./settings-account-panel.tsx";
import { SettingsExportGroup } from "./settings-export-group.tsx";
import { SettingsUpdateGroup, UpdateBadge } from "./settings-update-panel.tsx";
import { SettingsRenderingGroup } from "./settings-rendering-panel";
import { useUpdateStatus } from "../../../app/update-status";
import { SettingsThemePicker, themeLabel } from "./settings-theme-picker.tsx";
import { SettingsInviteJoinField } from "./settings-invite-join-field.tsx";
import { SettingsMotionPreview } from "./settings-motion-preview";
import {
  SettingsCompanionStatus,
  CapabilityChip,
  actionReason,
  capabilityChipLabel,
  featureReason,
  nativeReason,
  live2dStatusLabel,
  type ActionCapabilityValue,
  type NativeCapabilityValue,
} from "./settings-companion-status.tsx";
import { SettingsDataBoundaryGroup } from "./settings-data-boundary-group.tsx";
import {
  SettingsWorkspaceGroup,
  dissolveSentence,
  type DissolvePreviewCounts,
  type DissolvePreviewState,
} from "./settings-workspace-group.tsx";
import { AUDIT_CATEGORY_LABELS, AUDIT_STATUS_LABELS, DATA_POLICY_FIELDS, spaceRoleTypeLine, spaceTypeLabel, THEME_PLATES } from "./settings-data-tables.ts";
import { copyText } from "../../../app/clipboard";

/**
 * 一个分区自己报给伴星读的那份事实（39d W2-7）。字段含义在这一页里**全页统一**，
 * 每个分区不许另起一套：
 *  - `statusLine`＝这一屏此刻写着的那句状态（内联状态优先；没有状态就是页脚那句说明）；
 *  - `items`＝此刻列在屏上的那些行，`label` 是行标题原话、`state` 是**那一行自己**的
 *    状态字（一枚 tag 或角色词）；折叠块（`<details>`）与页签外的行不算露出；
 *  - `metrics`＝屏上单独的计数／读数格；
 *  - `filters`＝这一屏的选中项（分段控件选中的那档、开关此刻的通断）；
 *  - `notice`＝内联状态那句解释（为什么读不到、为什么是空的）。
 */
type SettingsPanel = {
  readonly title: string;
  readonly body: React.ReactNode;
  readonly footerNote?: string;
  readonly readable: SettingsReadable;
};
import {
  AudioLines,
  Bell,
  BookOpen,
  Check,
  Clipboard,
  ClipboardCheck,
  Compass,
  Copy,
  Download,
  FileUp,
  ImageUp,
  KeyRound,
  LogOut,
  MessageCircle,
  MessagesSquare,
  Mic,
  Pause,
  Play,
  Moon,
  RefreshCw,
  SearchCheck,
  Sparkles,
  Sun,
  Trash2,
  UserPlus,
} from "lucide-react";
import {
  AI_CONSENT_VERSION,
  type AiDataPolicyV1,
  type AuthProfileResultV1,
  type CapabilityProjectionV1,
  type InviteCreatedV1,
  type InviteListResultV1,
  type InviteStatusV1,
  type MemberListResultV1,
  type SearchDriftResultV1,
  type SearchReindexResultV1,
  type SessionContextV1,
  type WorkspaceAiSettingsV1,
  type WorkspaceSummaryV1,
} from "@astella/shared/desktop-ipc-contracts";
import type { DesktopAiAuditItemV1, DesktopAiAuditPageV1 } from "@astella/shared/desktop-surface-contracts";
import { formatObjectiveDateTime } from "../run/objective-state-copy.ts";
import type { MotionMode } from "../../../app/room-machine";
import {
  NO_AVATAR_SRC,
  useRoomStore,
  type Live2dStatus,
} from "../../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, isJoinCommittedWithoutSession, joinFailureTone, unwrapGatewayResult } from "../../../app/desktop-client";
import { signOutCurrentAccount } from "../../../app/account-signout";
import { companionConsentGate, COMPANION_CONSENT_REQUIRED_LINE, COMPANION_EXTERNAL_DISABLED_LINE, SETTINGS_ATTENTION_AI_CONSENT, SETTINGS_SECTION_AI_CONSENT } from "../../../app/companion-consent-gate";
import { publishGateInvalidation } from "../../../app/gate-invalidation";
import {
  DIRECTORY_RAIL_MODE_EVENT,
  DIRECTORY_RAIL_MODE_KEY,
  readDirectoryRailMode,
  type DirectoryRailMode,
} from "../../DirectoryRail";
import { useHomeV2 } from "../../home-v2/HomeV2Experience";
import { SettingsBook, SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-book";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import { HudPicker, HudSegmented } from "../../hud/HudControls";
import { useHudPage } from "../../hud/use-hud-page";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { HUD_PAGES } from "../../hud/hud-pages";
import { SurfaceDataState, readAuthenticatedSession } from "../notebook/surface-data.tsx";

const SECTIONS = SETTINGS_SECTIONS.map(({ id, label }) => [id, label] as const);
const SECTION_IDS: readonly string[] = SECTIONS.map(([id]) => id);

/** Clear the one-off consent outline after the reader has had time to locate it. */
export const SETTINGS_ATTENTION_MS = 4_200;

const MOTION_OPTIONS: ReadonlyArray<readonly [MotionMode, string]> = [
  ["full", "完整"],
  ["lite", "轻量"],
  ["off", "关闭"],
];

const DIRECTORY_OPTIONS: ReadonlyArray<readonly [DirectoryRailMode, string]> = [
  ["auto", "自动"],
  ["expanded", "展开"],
  ["collapsed", "收起"],
];

/** The settings plate itself, which is the room the theme choice repaints. */


/**
 * Why a capability reads the way it does. The server sends a `reason` for
 * features and the projection is derived from consent + role for actions, so
 * the chip can always explain itself instead of leaving "未允许" unexplained.
 */

function roleLabel(role: WorkspaceSummaryV1["role"] | undefined): string {
  if (!role) return "—";
  return role === "owner" ? "Owner · 全部读写" : "Member · 只读协作";
}


/** 空间名册那一行下面那行小字：角色 · 空间类型。屏上写一次，登记也读同一份。 */

/** 「这个空间的边界」里数据边界那一格的读数。 */
function dataBoundaryLine(capabilityFailure: string | null, read: ActionCapabilityValue | undefined): string {
  if (capabilityFailure) return "状态未读取";
  return read === "allowed" ? "伴星可读取" : "当前不外发";
}

/** 开关没有字面：登记用本仓库已经在用的这两个词，用例断言的是 DOM 的 `aria-checked`。 */
function switchStateLine(checked: boolean): string {
  return checked ? "已开启" : "未开启";
}

/** 邀请与名册里那一行的角色词：屏上出现三次（邀请行、成员行、回执），同一份。 */
function inviteRoleLabel(role: "member" | "owner"): string {
  return role === "owner" ? "所有者" : "成员";
}

/** 两块主题板各自写着的名字。 */

/** 滑杆右边那个读数。 */

/** 模型在本机的加载状态那一枚 tag 写的字。 */

/** 播放器那一行 `<b>` 的字：没有读数时屏上写的就是「还没有试听过」。 */

/** 还没读回来的计数，屏上是一个破折号——登记也照屏上写，不拿 0 顶。 */
function countOrDash(value: number | undefined): string {
  return value === undefined ? "—" : String(value);
}

/** 分段控件此刻选中那一档在屏上写的那个词（取不到就是没露出，宁可不登记）。 */
function segmentedValue<T extends string>(
  options: ReadonlyArray<readonly [T, string]>,
  value: T | undefined,
): string | null {
  return options.find(([optionValue]) => optionValue === value)?.[1] ?? null;
}

/** 导出回执里的体积，按人读得懂的单位显示。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 头像文件读成 base64；分块 btoa，避免一次性展开整个字符串。 */
async function fileToBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < buffer.length; offset += 0x8000) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

const INVITE_EXPIRY_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["24", "24 小时"],
  ["72", "72 小时"],
  ["168", "7 天"],
  ["none", "无限制"],
];

const INVITE_ROLE_OPTIONS: ReadonlyArray<readonly ["member" | "owner", string]> = [
  ["member", "成员"],
  ["owner", "所有者"],
];

/**
 * 数据外发策略的四个开关：字段、标题、说明。以前它们是四段复制粘贴的 JSX，
 * 只有一处写错就会让开关写进另一个字段，而那种错误在类型上是看不出来的。
 */

/**
 * 「伴星授权」那四行：能力键、行标题、说明、图标。这四行是伴星最常被问到的一组
 * （"你能看到我的笔记吗"），所以屏上写一次、登记读同一份，不许有两套标题。
 */
const COMPANION_GRANTS: ReadonlyArray<{
  readonly key: "companion.read" | "companion.sendMessage" | "companion.decideProposal" | "settings.update";
  readonly title: string;
  readonly detail: string;
  readonly mark: React.ReactNode;
}> = [
  { key: "companion.read", title: "伴星读取工作区内容", detail: "决定伴星能看到哪些来源、笔记与目标。", mark: <BookOpen size={15} /> },
  { key: "companion.sendMessage", title: "向伴星发送消息", detail: "消息内容可能离开这台电脑，交给服务器处理。", mark: <MessageCircle size={15} /> },
  { key: "companion.decideProposal", title: "确认伴星的提议", detail: "提议写入笔记或目标前始终需要你确认。", mark: <ClipboardCheck size={15} /> },
  { key: "settings.update", title: "代你改空间设置", detail: "空间级的设置只有所有者能改；上面那份同意与策略始终归你自己。", mark: <KeyRound size={15} /> },
];

/**
 * 审计里的数据类别是内部枚举名（db-schema 的 `data_categories`）。认得出的翻成人话，
 * 认不出的**原样上屏**——编一个标签会让读者以为那是系统认识的东西。
 */


/** 每页读多少条外发记录。服务端上限 100，这里要的是"翻得动"，不是"一次读完"。 */
const AUDIT_PAGE_SIZE = 20;



/** 切引擎时一起落定的音色：edge 只有一条，千问取目录第一条。 */

/** 跟着账号走的读数：还没读回来时屏上是哪一个词（读到过却拿不到＝未读到）。 */


function inviteStatusLabel(status: InviteStatusV1): string {
  if (status === "active") return "可用";
  if (status === "consumed") return "已使用";
  if (status === "revoked") return "已撤销";
  return "已过期";
}

/**
 * 「168 小时内有效」不是读者写得出来的话。选项自己带着人读得懂的说法，就直接
 * 用它，别把内部小时数再抄一遍。
 */
function inviteExpiryLabel(value: string): string {
  if (value === "none") return "长期有效，直到手动撤销";
  return `${INVITE_EXPIRY_OPTIONS.find(([option]) => option === value)?.[1] ?? value}内有效`;
}

/** 邀请与成员时间只作展示，按日历日截取。 */
function dayLabel(value: string | null): string {
  return value ? value.slice(0, 10) : "—";
}

/**
 * One row of the settings card, and the only one there is: an optional mark,
 * the copy, and the control cell on the right. A consent toggle, a capability
 * chip, a roster entry, a ledger value and a preference choice are all the same
 * object here, which is what the three near-identical rows this replaces
 * (`choice-row`, `settings-consent-row`, `settings-capability`) had stopped
 * being — they disagreed on padding, on the gap before the control, and on
 * whether the title was serif 12px or sans 11px.
 *
 * The three cells are placed explicitly (`settings-row__body` → column 2,
 * `settings-row__control` → column 3): with auto-placement a mark-less row
 * dropped its control into the flexible middle track, which un-anchored it
 * from the right edge and, in a narrow column with long copy, squeezed that
 * track to zero and let the control spill out of the card.
 */
/** 外壳级（不分分区）的三句话：JSX 与登记引用同一份。 */
const SETTINGS_LOADING = { message: "正在读取设置", detail: "这一页只显示服务器确认过的账户、空间与能力。" } as const;
const SETTINGS_UNAVAILABLE = "设置暂时不可用";
/** 每个分区都在目录里有一格；她要先知道读者站在哪一格。 */
const SECTION_FILTER_LABEL = "当前分区";

export function summaryOfDissolveCounts(counts: Record<string, number>): string {
  const cleared = Object.entries(counts)
    .filter(([key]) => !key.startsWith("_"))
    .reduce((total, [, value]) => total + value, 0);
  const rehomed = counts._rehomedGlobalMemories ?? 0;
  const retired = counts._retiredWorkspaceMemories ?? 0;
  const parts = [`清掉了 ${cleared} 项内容`];
  if (rehomed > 0) parts.push(`${rehomed} 条属于你的记忆已迁回你的个人空间`);
  if (retired > 0) parts.push(`${retired} 条只属于这个空间的记忆已收掉`);
  return `${parts.join("，")}。`;
}


export function SettingsSurface() {
  const theme = useRoomStore((state) => state.theme);
  const setTheme = useRoomStore((state) => state.setTheme);
  const themeMode = useRoomStore((state) => state.themeMode);
  const followTimeTheme = useRoomStore((state) => state.followTimeTheme);
  const motionMode = useRoomStore((state) => state.motionMode);
  const setMotionMode = useRoomStore((state) => state.setMotionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const live2dStatus = useRoomStore((state) => state.live2dStatus);
  const settingsSection = useRoomStore((state) => state.settingsSection);
  const setSettingsSection = useRoomStore((state) => state.setSettingsSection);
  const settingsAttention = useRoomStore((state) => state.settingsAttention);
  const setSettingsAttention = useRoomStore((state) => state.setSettingsAttention);
  const setHudPage = useRoomStore((state) => state.setHudPage);
  const closeSurface = useRoomStore((state) => state.closeSurface);
  /**
   * 更新状态读的是 app 级 store（`app/update-status.ts`），**不是**本页自己订阅。
   * 伴星通知与 HUD 角标读的是同一份，所以这里不能再挂第二条 `onUpdateState`：
   * 两条订阅会各收到一次推送，而设置页一关，通知那条链路就跟着断。
   */
  const update = useUpdateStatus();
  const invoke = useRoomStore((state) => state.invoke);
  const { replayIntro } = useHomeV2();
  const [directoryMode, setDirectoryMode] = useState<DirectoryRailMode>(readDirectoryRailMode);
  const [session, setSession] = useState<SessionContextV1 | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummaryV1[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityProjectionV1 | null>(null);
  const [aiSettings, setAiSettings] = useState<WorkspaceAiSettingsV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [aiDetailsOpen, setAiDetailsOpen] = useState(false);
  const [deviceDetailsOpen, setDeviceDetailsOpen] = useState(false);
  const [workspaceListFailure, setWorkspaceListFailure] = useState<string | null>(null);
  const [capabilityFailure, setCapabilityFailure] = useState<string | null>(null);
  const [aiSettingsFailure, setAiSettingsFailure] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failureNotice, setFailureNotice] = useState<string | null>(null);

  /**
   * 邀请动作自己的失败（审计 F31）：它要贴在「生成邀请」那张卡里，而不是页尾那条
   * 通用提示——那里离按钮很远，而这条错误的下一步动作就在这张卡上（换个入口）。
   */
  const [inviteFailure, setInviteFailure] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [aiSaving, setAiSaving] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [inventory, setInventory] = useState<{ sources: number; notes: number; objectives: number } | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryFailure, setInventoryFailure] = useState<string | null>(null);
  // ── 旧版设置页回补（2026-09-18）────────────────────────────────
  const [profile, setProfile] = useState<AuthProfileResultV1 | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [profileBusy, setProfileBusy] = useState<string | null>(null);
  // 解散是不可逆动作：确认文本按空间名校验，且计数只在成功后由服务端那份带来。
  const [transferCandidate, setTransferCandidate] = useState<string | null>(null);
  const [dissolvePending, setDissolvePending] = useState<string | null>(null);
  /**
   * 退出确认（审计 F40）：退出与解散都会让人"看不到一批材料"，此前一个一键即走、
   * 一个要打空间名。同等级后果给同等级防护——行内展开确认，写清代价与回来的路。
   */
  const [leavePending, setLeavePending] = useState<string | null>(null);
  const [dissolveConfirmText, setDissolveConfirmText] = useState("");
  /**
   * 解散前的先睹计数（审计 F39 ③）。三种状态要分开：还没取到、取到了、取不到——
   * 把"取不到"画成 0 会撒一句"这里什么都没有"，而那句话正在给一个不可逆动作壮胆。
   */
  const [dissolvePreview, setDissolvePreview] = useState<DissolvePreviewState>(null);
  const [profileFailure, setProfileFailure] = useState<string | null>(null);
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [passwordForm, setPasswordForm] = useState({ current: "", next: "", confirm: "" });
  /** 退出登录后这台设备就交还给登录页了；这一位只用来让按下去的那一下有回音。 */
  const [signingOut, setSigningOut] = useState(false);
  const [invites, setInvites] = useState<InviteListResultV1 | null>(null);
  const [members, setMembers] = useState<MemberListResultV1 | null>(null);
  const [invitesRead, setInvitesRead] = useState(false);
  const [membersRead, setMembersRead] = useState(false);
  const [invitesFailure, setInvitesFailure] = useState<string | null>(null);
  const [membersFailure, setMembersFailure] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<"member" | "owner">("member");
  const [inviteExpiry, setInviteExpiry] = useState("72");
  const [createdInvite, setCreatedInvite] = useState<InviteCreatedV1 | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [ownerBusy, setOwnerBusy] = useState<string | null>(null);
  const [removeCandidate, setRemoveCandidate] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [markdownExporting, setMarkdownExporting] = useState(false);
  const [drift, setDrift] = useState<SearchDriftResultV1 | null>(null);
  const [reindexResult, setReindexResult] = useState<SearchReindexResultV1 | null>(null);
  /**
   * AI 外发记录（doc 34 L3 的另一半：写侧一直在记，桌面以前没有任何地方读）。
   * 没点开就不读，读到之前这一行只有说明、没有清单。
   */
  const [auditPage, setAuditPage] = useState<DesktopAiAuditPageV1 | null>(null);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditFailure, setAuditFailure] = useState<string | null>(null);
  const [inventoryEpoch, setInventoryEpoch] = useState(0);
  const [auxiliaryEpoch, setAuxiliaryEpoch] = useState(0);
  const epochRef = useRef<number | undefined>(undefined);

  const [companionReadable, setCompanionReadable] = useState<SettingsReadable>({});
  const consentGroupRef = useRef<HTMLElement | null>(null);
  const consentAttentionTimerRef = useRef<number | null>(null);
  const [consentAttention, setConsentAttention] = useState(false);
  const [consentGuidance, setConsentGuidance] = useState(false);
  useHudPage("settings");

  const section: SettingsSectionId = SECTION_IDS.includes(settingsSection)
    ? settingsSection as SettingsSectionId
    : "account";
  const [visitedSections, setVisitedSections] = useState<readonly SettingsSectionId[]>([section]);
  useEffect(() => {
    setVisitedSections(previous => previous.includes(section) ? previous : [...previous, section]);
  }, [section]);

  /**
   * 伴星因缺少 AI 同意停摆时会把读者送到这里（2026-09-19）：滚到「签署状态」卡、
   * 闪一下。请求**立刻消费**（只引导一次，下次进页面不再闪），高亮由计时器摘掉；
   * 计时器住在 ref 里而不是 effect 清理函数里——消费请求会让 effect 重跑，
   * 返回清理函数会把刚设好的计时器立刻取消，高亮就永远摘不掉了。
   */
  useEffect(() => {
    if (settingsAttention !== SETTINGS_ATTENTION_AI_CONSENT || section !== SETTINGS_SECTION_AI_CONSENT) return;
    setSettingsAttention(null);
    setConsentAttention(true);
    setConsentGuidance(true);
    consentGroupRef.current?.scrollIntoView({ block: "center", behavior: reducedMotion || motionMode !== "full" ? "auto" : "smooth" });
    if (consentAttentionTimerRef.current !== null) window.clearTimeout(consentAttentionTimerRef.current);
    consentAttentionTimerRef.current = window.setTimeout(() => {
      consentAttentionTimerRef.current = null;
      setConsentAttention(false);
    }, SETTINGS_ATTENTION_MS);
  }, [motionMode, reducedMotion, section, setSettingsAttention, settingsAttention]);

  useEffect(() => () => {
    if (consentAttentionTimerRef.current !== null) window.clearTimeout(consentAttentionTimerRef.current);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    setWorkspaceListFailure(null);
    setCapabilityFailure(null);
    setAiSettingsFailure(null);
    try {
      const current = await readAuthenticatedSession(epochRef);
      setSession(current);
      const meta = () => createRequestMeta(current.workspaceEpoch);
      const [workspaceResult, capabilityResult, aiResult] = await Promise.allSettled([
        (async () => {
          const response = await window.astella.workspace.list({ meta: meta() });
          if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
          return unwrapGatewayResult(response).workspaces;
        })(),
        (async () => {
          const response = await window.astella.capabilities.get({ meta: meta() });
          if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
          return unwrapGatewayResult(response);
        })(),
        (async () => {
          const response = await window.astella.workspace.getAiSettings({ meta: meta() });
          if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
          return unwrapGatewayResult(response);
        })(),
      ]);

      if (workspaceResult.status === "fulfilled") setWorkspaces(workspaceResult.value);
      else {
        setWorkspaces([]);
        setWorkspaceListFailure(gatewayErrorMessage(workspaceResult.reason));
      }
      if (capabilityResult.status === "fulfilled") setCapabilities(capabilityResult.value);
      else {
        setCapabilities(null);
        setCapabilityFailure(gatewayErrorMessage(capabilityResult.reason));
      }
      if (aiResult.status === "fulfilled") setAiSettings(aiResult.value);
      else {
        setAiSettings(null);
        setAiSettingsFailure(gatewayErrorMessage(aiResult.reason));
      }
      setFailureNotice(null);
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Re-read only the server facts a policy write can change. A full `load()`
   * would blank the whole card behind the loading paper, which reads as the
   * switch having thrown the page away.
   */
  const reloadAfterPolicyWrite = useCallback(async () => {
    const [capabilityResult, aiResult] = await Promise.allSettled([
      (async () => {
        const response = await window.astella.capabilities.get({ meta: createRequestMeta(epochRef.current) });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        return unwrapGatewayResult(response);
      })(),
      (async () => {
        const response = await window.astella.workspace.getAiSettings({ meta: createRequestMeta(epochRef.current) });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        return unwrapGatewayResult(response);
      })(),
    ]);
    if (capabilityResult.status === "fulfilled") {
      setCapabilities(capabilityResult.value);
      setCapabilityFailure(null);
    } else {
      setCapabilityFailure(gatewayErrorMessage(capabilityResult.reason));
    }
    if (aiResult.status === "fulfilled") {
      setAiSettings(aiResult.value);
      setAiSettingsFailure(null);
    } else {
      setAiSettingsFailure(gatewayErrorMessage(aiResult.reason));
    }
  }, []);

  /** What the workspace holds, read from the same lists the library pages use. */
  useEffect(() => {
    if (!session?.workspace?.workspaceId) return undefined;
    let active = true;
    setInventoryLoading(true);
    setInventoryFailure(null);
    void (async () => {
      try {
        const meta = () => createRequestMeta(epochRef.current);
        const [sources, notes, objectives] = await Promise.all([
          window.astella.source.list({ meta: meta(), limit: 1 }),
          window.astella.note.list({ meta: meta(), limit: 1 }),
          window.astella.objective.list({ meta: meta(), limit: 1 }),
        ]);
        if (!active) return;
        setInventory({
          sources: unwrapGatewayResult(sources).total,
          notes: unwrapGatewayResult(notes).total,
          objectives: unwrapGatewayResult(objectives).total,
        });
      } catch (error) {
        // The inventory is informational; the rest of the page still stands.
        if (active) {
          setInventory(null);
          setInventoryFailure(gatewayErrorMessage(error));
        }
      } finally {
        if (active) setInventoryLoading(false);
      }
    })();
    return () => { active = false; };
  }, [session?.workspace?.workspaceId, inventoryEpoch]);

  const changeDirectoryMode = useCallback((next: DirectoryRailMode) => {
    setDirectoryMode(next);
    try {
      window.localStorage.setItem(DIRECTORY_RAIL_MODE_KEY, next);
    } catch {
      // Preference persistence is progressive enhancement.
    }
    window.dispatchEvent(new CustomEvent(DIRECTORY_RAIL_MODE_EVENT, { detail: { mode: next } }));
  }, []);

  const switchTo = async (workspace: WorkspaceSummaryV1) => {
    if (workspace.workspaceId === session?.workspace?.workspaceId || switching) return;
    setSwitching(workspace.workspaceId);
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.astella.workspace.switch({
        meta: createRequestMeta(epochRef.current),
        workspaceId: workspace.workspaceId,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      // The whole room is scoped to one verified workspace, so a switch is a
      // boundary change: reuse the gate's own invalidation path rather than
      // patching each surface's cursor by hand. That reset also drops the
      // surface back to the room, forgets the settings section and republishes
      // `hudPage` as home — right for the room's own space menu, wrong here:
      // the reader asked for a different space *while sitting on this page*, so
      // the page, its section and its published page identity all come straight
      // back and the confirmation is still visible. (`hudPage` is republished
      // explicitly because `useHudPage`'s effect does not re-run for a page that
      // never unmounted, which would leave the chrome reading the home page.)
      publishGateInvalidation("stale_workspace");
      invoke("open-settings");
      setSettingsSection(section);
      setHudPage("settings", "returning");
      setNotice(`已切换到「${workspace.name}」，这一页读的是新空间的最新状态。`);
      await load();
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setSwitching(null);
    }
  };

  const joinWithInvite = async () => {
    const inviteToken = inviteCode.trim();
    if (!inviteToken || joining) return;
    setJoining(true);
    setNotice(null);
    setFailureNotice(null);
    try {
      try {
        const response = await window.astella.auth.joinWorkspace({
          meta: createRequestMeta(epochRef.current),
          inviteToken,
        });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        unwrapGatewayResult(response);
      } catch (error) {
        // 成员关系已经落库、只是本机会话没重读上：加入这件事确实成了，走完成功那一段。
        if (!isJoinCommittedWithoutSession(error)) throw error;
      }
      setInviteCode("");
      // 加入改变的是「名册与可进入的空间集合」，当前空间**没有**被换掉（服务端那条路
      // 只写成员行，不换 session）。所以这里要重发的是各面的读数，而不是把人弹出设置页。
      publishGateInvalidation("stale_workspace");
      invoke("open-settings");
      setSettingsSection(section);
      setHudPage("settings", "returning");
      setNotice("已加入协作空间，可在「账户与空间」查看和切换。");
      await load();
    } catch (error) {
      const text = gatewayErrorMessage(error);
      // 「已经在这个空间里」不是一次失败：那一行就在同一张纸的空间列表里，
      // 放进红色那格会把它说成"没做成"，而人要做的只是去点它。
      if (joinFailureTone(error) === "notice") setNotice(text);
      else setFailureNotice(text);
    } finally {
      setJoining(false);
    }
  };

  const saveDataPolicy = async (patch: Partial<AiDataPolicyV1>, field: string) => {
    if (!aiSettings || aiSaving) return;
    setAiSaving(field);
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.astella.workspace.updateAiDataPolicy({
        meta: createRequestMeta(epochRef.current),
        policy: { ...aiSettings.dataPolicy, ...patch },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setAiSettings(unwrapGatewayResult(response));
      // 同意与策略会改变服务端的能力投影（伴星读取 / 外发），所以顺带刷新它，
      // 否则同一页的「外发同意」会停在改动前。
      await reloadAfterPolicyWrite();
      setNotice("AI 数据策略已更新。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setAiSaving(null);
    }
  };

  /**
   * 笔记导出为 Markdown 目录。落盘由主进程做，读者在系统对话框里选文件夹；
   * 取消不算失败，回执里 `canceled` 与计数是分开的几件事。
   *
   * 失败的那几篇**要照实报数**：回执恒满足 `exported + failed === total`，
   * 只说「导出了 N 篇」会让人以为整个空间都存下来了。
   */
  const exportNotesMarkdown = async () => {
    if (markdownExporting) return;
    setMarkdownExporting(true);
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.astella.note.exportMarkdown({ meta: createRequestMeta(epochRef.current) });
      const result = unwrapGatewayResult(response);
      if (result.canceled) {
        setNotice("已取消导出，没有写入任何文件。");
        return;
      }
      const images = result.images ?? 0;
      const imageFailures = result.imageFailures ?? 0;
      // 图片的数要说**两句**：放进 assets/ 的那几张，和没取回来、正文里还留着站内地址的那几张。
      // 只报前者，读者拿去别的编辑器才发现有几处点开是空的。
      const imageNote = images > 0
        ? `，${images} 张图放在 assets/${imageFailures > 0 ? `，另有 ${imageFailures} 张没取回来（正文里那一处还是站内地址）` : ""}`
        : imageFailures > 0 ? `，有 ${imageFailures} 张图没取回来（正文里那一处还是站内地址）` : "";
      setNotice(result.failed > 0
        ? `已导出 ${result.exported} 篇到 ${result.directory}${imageNote}，${result.failed} 篇没写成（这一篇取不到或写不进去，可以再导一次）。`
        : `已导出 ${result.exported} 篇到 ${result.directory}${imageNote}。`);
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setMarkdownExporting(false);
    }
  };

  /**
   * 整库导出。数据在服务端取，落盘位置由读者在系统保存对话框里选；取消不算
   * 失败，所以回执里 `saved` 与 `canceled` 是分开的两件事。
   */
  const exportWorkspace = async () => {
    if (exporting) return;
    setExporting(true);
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.astella.workspace.export({ meta: createRequestMeta(epochRef.current) });
      const result = unwrapGatewayResult(response);
      setNotice(result.saved
        ? `已导出到 ${result.filePath}（${formatBytes(result.bytes)}）。`
        : "已取消导出，没有写入任何文件。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const signConsent = async () => {
    if (aiSaving) return;
    setAiSaving("consent");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.astella.workspace.updateAiConsent({
        meta: createRequestMeta(epochRef.current),
        consentVersion: AI_CONSENT_VERSION,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setAiSettings(unwrapGatewayResult(response));
      await reloadAfterPolicyWrite();
      setNotice("AI 使用同意已签署，外部 AI 已开启，能力状态已刷新。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setAiSaving(null);
    }
  };

  // ── 旧版设置页回补的操作 ───────────────────────────────────────────
  /** 改昵称。空串等价于清除；服务端自己截断到 32 字。 */
  const saveDisplayName = async () => {
    if (profileBusy) return;
    setProfileBusy("displayName");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.astella.auth.updateProfile({
        meta: createRequestMeta(epochRef.current),
        displayName: displayName.trim() || null,
      });
      const next = unwrapGatewayResult(response);
      setProfile(next);
      setSession((current) => {
        if (current?.status !== "authenticated" || !current.user) return current;
        return { ...current, user: { ...current.user, displayName: next.displayName ?? undefined } };
      });
      setNotice(next.displayName ? `显示名已更新为「${next.displayName}」。` : "显示名已清除。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  /**
   * 上传头像：main 以 multipart 送 /uploads/avatars，服务端同时持久化 avatarUrl。
   * 结果回给取景框等（`AvatarUploadOutcome`）——它在人点下「使用这张」之后还开着，
   * 要等这一步落定：成功才收框，失败就地显示原因。提示条照旧记一份，取消后也算数。
   */
  const uploadAvatar = async (file: File): Promise<AvatarUploadOutcome> => {
    if (profileBusy) return { ok: false, message: "还有一项账户操作正在进行，请稍后再试。" };
    setProfileBusy("avatar");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.astella.auth.uploadAvatar({
        meta: createRequestMeta(epochRef.current),
        request: {
          version: 1,
          fileName: file.name,
          mimeType: file.type,
          bytesBase64: await fileToBase64(file),
        },
      });
      const result = unwrapGatewayResult(response);
      setProfile((current) => ({ version: 1, displayName: current?.displayName ?? null, avatarUrl: result.url }));
      setNotice("头像已更新。");
      return { ok: true };
    } catch (error) {
      const message = gatewayErrorMessage(error);
      setFailureNotice(message);
      return { ok: false, message };
    } finally {
      setProfileBusy(null);
    }
  };

  const clearAvatar = async () => {
    if (profileBusy) return;
    setProfileBusy("avatar");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.astella.auth.updateProfile({
        meta: createRequestMeta(epochRef.current),
        avatarUrl: null,
      });
      setProfile(unwrapGatewayResult(response));
      setNotice("头像已清除，恢复首字母印章。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  /** 改密码：服务端会撤销所有会话，改完必须重新登录。 */
  const submitPasswordChange = async () => {
    if (profileBusy) return;
    if (!passwordForm.current || passwordForm.next.length < 8) {
      setFailureNotice("新密码至少 8 位。");
      return;
    }
    if (passwordForm.next !== passwordForm.confirm) {
      setFailureNotice("两次输入的新密码不一致。");
      return;
    }
    setProfileBusy("password");
    setNotice(null);
    setFailureNotice(null);
    try {
      unwrapGatewayResult(await window.astella.auth.changePassword({
        meta: createRequestMeta(epochRef.current),
        commandId: crypto.randomUUID(),
        currentPassword: passwordForm.current,
        newPassword: passwordForm.next,
      }));
      setPasswordForm({ current: "", next: "", confirm: "" });
      // 所有会话已被服务端撤销，凭据也已在本机清除：走 gate 重新登录。
      publishGateInvalidation("stale_workspace");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  /**
   * 退出登录。动作本体在 `app/account-signout.ts`，与顶栏账户小框共用一份：
   * 两处对「退出了没有」的说法必须一致，三种结局的话也由它一次写好。
   *
   * 这里不接 `setNotice`：门禁随即把整页换成登录页，页面自己的提示活不过那一行
   * （设置页以前就是这么把「已切换到…」弄丢的）。
   */
  const signOutOfAccount = async () => {
    if (signingOut) return;
    setSigningOut(true);
    await signOutCurrentAccount();
  };

  /** Owner：生成邀请。结果里的 token 只显示这一次。 */
  const createInvite = async () => {
    if (ownerBusy) return;
    setOwnerBusy("create");
    setNotice(null);
    setFailureNotice(null);
    setInviteFailure(null);
    try {
      const response = await window.astella.invites.create({
        meta: createRequestMeta(epochRef.current),
        role: inviteRole,
        expiresInHours: inviteExpiry === "none" ? undefined : Number(inviteExpiry),
      });
      setCreatedInvite(unwrapGatewayResult(response));
      const listResponse = await window.astella.invites.list({ meta: createRequestMeta(epochRef.current) });
      setInvites(unwrapGatewayResult(listResponse));
    } catch (error) {
      setInviteFailure(gatewayErrorMessage(error));
    } finally {
      setOwnerBusy(null);
    }
  };

  const revokeInvite = async (inviteId: string) => {
    if (ownerBusy) return;
    setOwnerBusy(inviteId);
    setNotice(null);
    setFailureNotice(null);
    try {
      unwrapGatewayResult(await window.astella.invites.revoke({
        meta: createRequestMeta(epochRef.current),
        inviteId,
      }));
      const listResponse = await window.astella.invites.list({ meta: createRequestMeta(epochRef.current) });
      setInvites(unwrapGatewayResult(listResponse));
      setNotice("邀请已撤销。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setOwnerBusy(null);
    }
  };

  /** Owner：移除成员。二次确认在行内完成（第一次点变成确认）。 */
  /**
   * Owner：把这个空间交给某个成员（行内二次确认，与"移除成员"同一节奏）。
   *
   * 这一步同时是**原 owner 的出口**：转让后自己降为 member，`leaveWorkspace` 那条
   * `owner_cannot_leave` 就不再挡他。转让与退出是两步、两个动作，
   * 所以这里不说"你可以退出了"这种还没发生的话——只说现在谁是所有者。
   */
  const transferOwnership = async (member: { userId: string; email: string }) => {
    if (ownerBusy) return;
    if (transferCandidate !== member.userId) {
      setTransferCandidate(member.userId);
      return;
    }
    setOwnerBusy(member.userId);
    setTransferCandidate(null);
    setNotice(null);
    setFailureNotice(null);
    try {
      unwrapGatewayResult(await window.astella.workspace.transferOwnership({
        meta: createRequestMeta(epochRef.current),
        workspaceId: currentWorkspace?.workspaceId ?? "",
        toUserId: member.userId,
      }));
      setNotice(`已把「${currentWorkspace?.name ?? "这个空间"}」交给 ${member.email}，你不再是它的所有者。`);
      // 角色边界变了：走既有的失效路径，再把读者留在这一页。
      publishGateInvalidation("stale_workspace");
      invoke("open-settings");
      setSettingsSection(section);
      setHudPage("settings", "returning");
      await load();
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setOwnerBusy(null);
    }
  };

  const removeMember = async (userId: string) => {
    if (ownerBusy) return;
    if (removeCandidate !== userId) {
      setRemoveCandidate(userId);
      return;
    }
    setOwnerBusy(userId);
    setRemoveCandidate(null);
    setNotice(null);
    setFailureNotice(null);
    try {
      unwrapGatewayResult(await window.astella.members.remove({
        meta: createRequestMeta(epochRef.current),
        userId,
      }));
      const listResponse = await window.astella.members.list({ meta: createRequestMeta(epochRef.current) });
      setMembers(unwrapGatewayResult(listResponse));
      setNotice("成员已移除，其在当前空间的会话立即失效。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setOwnerBusy(null);
    }
  };

  /** Member：退出协作工作区。退出当前空间时服务端会签发个人空间的新会话。 */
  /**
   * 解散一个协作空间（端点 `DELETE /workspaces/:id`，判据在服务端迁移 0276）。
   *
   * 三件事是这条出口的底线：① 确认必须**输入空间名**，不是点两下；
   * ② 成功后照服务端带回的逐表计数说话，自己不加"大约多少"这种数字；
   * ③ 失败绝不写成"已删除"——它走既有的 failureNotice 那条路。
   */
  const loadDissolvePreview = async (workspaceId: string) => {
    setDissolvePreview({ workspaceId, phase: "loading" });
    try {
      const result = unwrapGatewayResult(await window.astella.workspace.dissolvePreview({
        meta: createRequestMeta(epochRef.current),
        workspaceId,
      }));
      setDissolvePreview({ workspaceId, phase: "ready", counts: result.counts });
    } catch {
      setDissolvePreview({ workspaceId, phase: "unavailable" });
    }
  };

  const dissolveWorkspace = async (workspace: WorkspaceSummaryV1) => {
    if (profileBusy || dissolveConfirmText !== workspace.name) return;
    setProfileBusy(`dissolve-${workspace.workspaceId}`);
    setNotice(null);
    setFailureNotice(null);
    try {
      const result = unwrapGatewayResult(await window.astella.workspace.dissolve({
        meta: createRequestMeta(epochRef.current),
        workspaceId: workspace.workspaceId,
      }));
      const summary = summaryOfDissolveCounts(result.counts);
      setNotice(`已解散「${workspace.name}」。${summary}`);
      setDissolvePending(null);
      setDissolveConfirmText("");
      publishGateInvalidation("stale_workspace");
      invoke("open-settings");
      setSettingsSection(section);
      setHudPage("settings", "returning");
      await load();
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  const leaveWorkspace = async (workspace: WorkspaceSummaryV1) => {
    if (profileBusy) return;
    setProfileBusy(`leave-${workspace.workspaceId}`);
    setNotice(null);
    setFailureNotice(null);
    try {
      unwrapGatewayResult(await window.astella.auth.leaveWorkspace({
        meta: createRequestMeta(epochRef.current),
        workspaceId: workspace.workspaceId,
      }));
      // 审计 F40：退出是单向的（这一行会从名册里消失），所以回执必须说清怎么回来。
      setNotice(`已退出「${workspace.name}」。要再进来，需要空间所有者重新发一个邀请码。`);
      // 空间边界变化：沿用切换空间的失效路径，但把读者送回这一页。
      publishGateInvalidation("stale_workspace");
      invoke("open-settings");
      setSettingsSection(section);
      setHudPage("settings", "returning");
      await load();
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  /** 重命名自己的个人工作区。 */
  const renamePersonalWorkspace = async () => {
    const name = renameValue.trim();
    if (!renamableWorkspace || !name || profileBusy) return;
    setProfileBusy("rename");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.astella.workspace.rename({
        meta: createRequestMeta(epochRef.current),
        workspaceId: renamableWorkspace.workspaceId,
        name,
      });
      const result = unwrapGatewayResult(response);
      setWorkspaces((current) => current.map((workspace) => (
        workspace.workspaceId === result.workspaceId ? { ...workspace, name: result.name } : workspace
      )));
      setSession((current) => {
        if (current?.status !== "authenticated" || !current.workspace) return current;
        if (current.workspace.workspaceId !== result.workspaceId) return current;
        return { ...current, workspace: { ...current.workspace, name: result.name } };
      });
      setNotice(`个人空间已更名为「${result.name}」。`);
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setProfileBusy(null);
    }
  };

  const checkSearchDrift = async () => {
    if (ownerBusy) return;
    setOwnerBusy("drift");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.astella.search.drift({ meta: createRequestMeta(epochRef.current) });
      setDrift(unwrapGatewayResult(response));
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setOwnerBusy(null);
    }
  };

  const runSearchReindex = async () => {
    if (ownerBusy) return;
    setOwnerBusy("reindex");
    setNotice(null);
    setFailureNotice(null);
    try {
      const response = await window.astella.search.reindex({ meta: createRequestMeta(epochRef.current) });
      setReindexResult(unwrapGatewayResult(response));
      setNotice("搜索索引已重建。");
    } catch (error) {
      setFailureNotice(gatewayErrorMessage(error));
    } finally {
      setOwnerBusy(null);
    }
  };

  /**
   * 作答方式是账号级偏好，写它有自己的忙碌位：以前借用 `profileBusy`，结果是
   * 改昵称的同时点这一行会被静默丢弃（控件没有 disabled 状态，也没有反馈）。
   */
  const loadAuditPage = async (offset: number) => {
    if (!window.astella) return;
    setAuditBusy(true);
    setAuditFailure(null);
    try {
      const response = await window.astella.workspace.getAiAuditLog({
        meta: createRequestMeta(epochRef.current),
        limit: AUDIT_PAGE_SIZE,
        offset,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setAuditPage(unwrapGatewayResult(response));
      setAuditOffset(offset);
    } catch (error) {
      // 读不到就明说读不到：把失败演成"这个空间没有外发记录"，是替系统撒了一个谎。
      setAuditPage(null);
      setAuditFailure(gatewayErrorMessage(error));
    } finally {
      setAuditBusy(false);
    }
  };

  const copyInviteToken = async (token: string) => {
    setCopiedCode(false);
    setFailureNotice(null);
    try {
      if (!await copyText(token)) throw new Error("clipboard unavailable");
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 2_000);
    } catch {
      setFailureNotice("无法写入剪贴板。邀请码已显示在页面中，请手动选择并复制。");
    }
  };

  const currentWorkspace = session?.workspace ?? null;
  const currentRole = session?.membership?.role;
  const companion = capabilities?.actionCapabilities;
  const features = capabilities?.featureAvailability;

  const isOwner = currentRole === "owner";
  /** 个人空间没有"成员"这回事（审计 F17）：邀请/名册/转让都不该在这里出现。 */
  const spaceIsPersonal = currentWorkspace?.isPersonal === true;
  const personalWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.isPersonal) ?? null,
    [workspaces],
  );

  /**
   * 能改名的那个空间（审计 F39）：自己的个人空间，或者**当前这个协作空间**（我是它的
   * owner）。协作空间此前一律拒掉，界面上唯一的替代出口是不可逆的解散——名字随手起错
   * 了没有轻的出路是操作逻辑问题，而改名本身没有任何破坏性。
   */
  const renamableWorkspace = isOwner && currentWorkspace && !currentWorkspace.isPersonal
    ? currentWorkspace
    : personalWorkspace;

  // ── 旧版设置页回补：档案、Owner 名册、作答偏好随会话读取 ───────────
  const sessionUserId = session?.user?.userId ?? null;
  const sessionWorkspaceId = session?.workspace?.workspaceId ?? null;
  /**
   * 只在「换了人」或「换了空间」时重读，而不是在 `session` 对象每次换引用时
   * 重读：改显示名、改头像都会写一份新的 session，之前那样会让这段读取再跑一遍，
   * 回填的旧值会把读者正在输入的内容覆盖掉。
   */
  useEffect(() => {
    if (!sessionUserId || !sessionWorkspaceId) return undefined;
    let active = true;
    const meta = () => createRequestMeta(epochRef.current);
    setProfileFailure(null);
    setInvitesRead(!isOwner);
    setMembersRead(!isOwner);
    setInvitesFailure(null);
    setMembersFailure(null);
    if (!isOwner) {
      setInvites(null);
      setMembers(null);
    }

    void (async () => {
      try {
        const profileResult = unwrapGatewayResult(
          await window.astella.auth.getProfile({ meta: meta() }),
        );
        if (!active) return;
        setProfile(profileResult);
        setDisplayName(profileResult.displayName ?? "");
      } catch (error) {
        if (active) setProfileFailure(gatewayErrorMessage(error));
      }
    })();

    if (isOwner) {
      void (async () => {
        try {
          const result = unwrapGatewayResult(await window.astella.invites.list({ meta: meta() }));
          if (active) setInvites(result);
        } catch (error) {
          if (active) setInvitesFailure(gatewayErrorMessage(error));
        } finally {
          if (active) setInvitesRead(true);
        }
      })();
      void (async () => {
        try {
          const result = unwrapGatewayResult(await window.astella.members.list({ meta: meta() }));
          if (active) setMembers(result);
        } catch (error) {
          if (active) setMembersFailure(gatewayErrorMessage(error));
        } finally {
          if (active) setMembersRead(true);
        }
      })();
    }

    return () => { active = false; };
  }, [auxiliaryEpoch, sessionUserId, sessionWorkspaceId, isOwner]);

  // 头像字节：站内地址渲染层够不到，走 main 的字节通道取 base64。
  const avatarObjectKey = profile?.avatarUrl
    ? profile.avatarUrl.replace("/api/uploads/", "")
    : null;
  useEffect(() => {
    if (!avatarObjectKey) {
      setAvatarSrc(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const response = await window.astella.auth.getAvatar({
          meta: createRequestMeta(epochRef.current),
          request: { version: 1, objectKey: avatarObjectKey },
        });
        const data = unwrapGatewayResult(response);
        if (active) setAvatarSrc(`data:${data.mimeType};base64,${data.imageBase64}`);
      } catch {
        // 头像取不回就落回首字母印章，不算页面失败。
      }
    })();
    return () => { active = false; };
  }, [avatarObjectKey]);
  /**
   * 换头像、清头像都发生在这页，而顶栏那颗折叠印章是常驻的、不会重新挂载——它读的
   * 是房间 store 里那份字节，这里不喂，回到房间还是旧的那张脸。喂的时机有讲究：
   * `profile` 还是 null（档案还没读回来）时什么都不写，否则会把一次「还没问过」
   * 错记成「确认没有头像」，那颗印章就再也等不到照片了。
   */
  useEffect(() => {
    const email = session?.user?.email;
    if (!profile || !email) return;
    if (profile.avatarUrl && !avatarSrc) return; // 有头像，等字节取回来再写
    const src = avatarSrc ?? NO_AVATAR_SRC;
    const current = useRoomStore.getState().accountAvatar;
    if (current?.email === email && current.src === src) return;
    useRoomStore.getState().setAccountAvatar({ email, src });
  }, [avatarSrc, profile, session?.user?.email]);
  /** 先调整个人资料，再查看空间名册；两者各自占满行宽。 */
  const accountPanel = (): SettingsPanel => ({
    title: "账户与空间",
    body: (
      <div className="settings-account-grid">
        <section className="settings-account-column" aria-label="个人账户">
          <div className="settings-identity">
            {avatarSrc
              ? <img className="settings-identity__avatar" src={avatarSrc} alt="头像" />
              : (
                <span className="settings-identity__seal" aria-hidden="true">
                  {(session?.user?.displayName ?? session?.user?.email ?? "我").slice(0, 1).toUpperCase()}
                </span>
              )}
            <div>
              <b>{session?.user?.displayName ?? session?.user?.email ?? "已登录"}</b>
              <small>{session?.user?.displayName ? session.user.email : "凭据只保存在这台设备上"}</small>
            </div>
          </div>
          {profileFailure ? (
            <SettingsInlineState
              title="个人档案暂时未同步"
              detail={profileFailure}
              tone="error"
              onRetry={() => setAuxiliaryEpoch((value) => value + 1)}
            />
          ) : null}
          <SettingsAccountPanel
            profile={profile}
            displayName={displayName}
            busy={profileBusy}
            onDisplayNameChange={setDisplayName}
            onSaveDisplayName={saveDisplayName}
            onUploadAvatar={uploadAvatar}
            onClearAvatar={clearAvatar}
          />


          <details className="settings-disclosure">
            <summary>
              <span>
                <b>修改密码</b>
                <small>修改后所有已登录会话都会失效。</small>
              </span>
            </summary>
            <div className="settings-form">
              <div className="settings-field">
                <label className="settings-field__label" htmlFor="settings-password-current">当前密码</label>
                <div className="hud-field">
                  <input id="settings-password-current" type="password" value={passwordForm.current} autoComplete="current-password" disabled={profileBusy !== null} onChange={(event) => { const current = event.currentTarget.value; setPasswordForm((form) => ({ ...form, current })); }} />
                </div>
              </div>
              <div className="settings-field">
                <label className="settings-field__label" htmlFor="settings-password-next">新密码</label>
                <div className="hud-field">
                  <input id="settings-password-next" type="password" value={passwordForm.next} placeholder="至少 8 位" autoComplete="new-password" disabled={profileBusy !== null} onChange={(event) => { const next = event.currentTarget.value; setPasswordForm((form) => ({ ...form, next })); }} />
                </div>
              </div>
              <div className="settings-field">
                <label className="settings-field__label" htmlFor="settings-password-confirm">确认新密码</label>
                <div className="hud-field">
                  <input
                    id="settings-password-confirm"
                    type="password"
                    value={passwordForm.confirm}
                    autoComplete="new-password"
                    disabled={profileBusy !== null}
                    onChange={(event) => { const confirm = event.currentTarget.value; setPasswordForm((form) => ({ ...form, confirm })); }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void submitPasswordChange();
                    }}
                  />
                </div>
              </div>
              <button type="button" className="button" disabled={profileBusy !== null || !passwordForm.current || !passwordForm.next} onClick={() => void submitPasswordChange()}>
                <KeyRound size={13} aria-hidden="true" />
                {profileBusy === "password" ? "修改中…" : "修改密码"}
              </button>
            </div>
          </details>
          <details className="settings-disclosure">
            <summary>
              <span>
                <b>退出登录</b>
                <small>换一个人用这台设备，或者到别的设备上继续。</small>
              </span>
            </summary>
            <div className="settings-rows">
              <SettingRow
                title={`退出 ${session?.user?.email ?? "这个账号"}`}
                detail="清掉这台设备上的登录状态，并请学习服务撤销这次登录。学习记录不会因为退出而减少，其他设备上的登录也不受影响。"
              >
                <button
                  type="button"
                  className="button danger"
                  disabled={signingOut}
                  onClick={() => void signOutOfAccount()}
                >
                  <LogOut size={13} aria-hidden="true" />
                  {signingOut ? "正在退出…" : "退出登录"}
                </button>
              </SettingRow>
            </div>
          </details>
        </section>

        <section className="settings-account-column" aria-label="当前空间">
          <div className="space-identity">
            <span className="space-seal">{currentWorkspace?.name?.slice(0, 1) ?? "学"}</span>
            <div>
              <h3>{currentWorkspace?.name ?? "未选择学习空间"}</h3>
              <div className="meta">
                <span>{roleLabel(currentRole)}</span>
                <span>{spaceTypeLabel(currentWorkspace?.workspaceType)}</span>
              </div>
            </div>
          </div>
          {workspaceListFailure ? (
            <SettingsInlineState
              title="空间列表暂时不可用"
              detail={workspaceListFailure}
              tone="error"
              onRetry={() => void load()}
            />
          ) : null}
          <section className="settings-group">
            <h3 className="settings-group__title">这个空间的边界</h3>
            <div className="ledger-field">
              <b>数据边界</b>
              <span className="write-line">
                <Compass className="write-line__icon" size={12} aria-hidden="true" />
                {dataBoundaryLine(capabilityFailure, companion?.["companion.read"])}
              </span>
            </div>
          </section>
          <SettingsWorkspaceGroup
            workspaces={workspaces}
            workspaceListFailure={workspaceListFailure}
            currentWorkspace={currentWorkspace}
            renamableWorkspace={renamableWorkspace}
            renameValue={renameValue}
            setRenameValue={setRenameValue}
            switchTo={switchTo}
            renamePersonalWorkspace={renamePersonalWorkspace}
            leaveWorkspace={leaveWorkspace}
            dissolveWorkspace={dissolveWorkspace}
            leavePending={leavePending}
            setLeavePending={setLeavePending}
            dissolvePending={dissolvePending}
            setDissolvePending={setDissolvePending}
            dissolveConfirmText={dissolveConfirmText}
            setDissolveConfirmText={setDissolveConfirmText}
            dissolvePreview={dissolvePreview}
            loadDissolvePreview={loadDissolvePreview}
            switching={switching}
            profileBusy={profileBusy}
          />
        </section>
      </div>
    ),
    footerNote: "空间数据彼此隔离；显示名与头像跨空间通用。",
    readable: {
      ...(workspaceListFailure
        ? { statusLine: "空间列表暂时不可用", notice: workspaceListFailure }
        : workspaces.length === 0
          ? { statusLine: "没有可切换的空间", notice: "当前会话未返回其他学习空间。" }
          : {}),
      metrics: [{ label: "数据边界", value: dataBoundaryLine(capabilityFailure, companion?.["companion.read"]) }],
      filters: [
        { label: "当前空间", value: currentWorkspace?.name ?? "未选择学习空间" },
        { label: "你的身份", value: roleLabel(currentRole) },
      ],
      items: workspaces.slice(0, 12).map((workspace) => ({
        label: workspace.name,
        state: spaceRoleTypeLine(workspace.role, workspace.workspaceType),
      })),
    },
  });


  /** 成员与邀请：这个空间里的"人"——加入入口，Owner 的邀请与成员名册。 */
  const membersPanel = (): SettingsPanel => ({
    title: "成员与邀请",
    body: (
      <>
        <div className="settings-block">
          <div className="settings-block__head">
            <div>
              <b>用邀请码加入协作空间</b>
              <p>邀请码由空间所有者发出，加入后立刻出现在「账户与空间」的空间列表里。</p>
            </div>
          </div>
            <SettingsInviteJoinField
              inviteCode={inviteCode}
              setInviteCode={setInviteCode}
              joining={joining}
              joinWithInvite={joinWithInvite}
            />
        </div>

        {/* Owner 专属：创建邀请、邀请记录、成员管理。写入由服务端 requireOwner 收口。
            三个 settings-group 用与「数据与维护」一致的小标题节奏，不再用 block 堆叠。
            Member 侧不是整块消失，而是留一个说清边界的锁定块：看不见不等于知道
            自己不能做，审查里「只读没有常驻表达」正是从这里来的。
            「谁能改政策」不在这一页说：它已经归到「AI 数据同意」的账号级设置里。 */}
        {isOwner && spaceIsPersonal ? (
          /* 审计 F17：个人空间此前照样摆着"生成邀请"，点下去必吃 409
             （服务端 `personal_workspace_not_shareable`）——一个做不到的按钮比没有更糟。
             这里说清边界，并指向真正能做的那件事（空间胶囊 → 新建协作空间）。 */
          <section className="settings-group">
            <h3 className="settings-group__title">成员与邀请</h3>
            <div className="settings-rows">
              <SettingRow
                title="个人空间不邀请别人"
                detail="这里只有你一个人：资料、笔记与排程都是你自己的。要和别人一起学，先新建一个协作空间——点右上角的空间胶囊，选「新建协作空间」，进去之后再邀请成员。"
              >
                <span className="tag">个人空间</span>
              </SettingRow>
            </div>
          </section>
        ) : isOwner ? (
          <>
            <section className="settings-group">
              <h3 className="settings-group__title">发出邀请</h3>
              <div className="settings-rows">
                <SettingRow
                  title="角色"
                  detail={inviteRole === "owner" ? "所有者：完整读写，可管理成员与邀请" : "成员：只读访问 + 验证/复习"}
                >
                  <HudSegmented
                    label="邀请角色"
                    value={inviteRole}
                    options={INVITE_ROLE_OPTIONS}
                    compact
                    disabled={ownerBusy !== null}
                    onChange={(next) => setInviteRole(next)}
                  />
                </SettingRow>
                <SettingRow title="有效期" detail={inviteExpiryLabel(inviteExpiry)}>
                  <HudPicker
                    label="邀请有效期"
                    value={inviteExpiry}
                    options={INVITE_EXPIRY_OPTIONS}
                    disabled={ownerBusy !== null}
                    onChange={setInviteExpiry}
                  />
                </SettingRow>
                <SettingRow title="生成邀请" detail="邀请码只在生成后显示一次，请立即复制保存。">
                  <button type="button" className="button primary" disabled={ownerBusy !== null} onClick={() => void createInvite()}>
                    <UserPlus size={13} aria-hidden="true" />
                    {ownerBusy === "create" ? "生成中…" : "生成邀请"}
                  </button>
                </SettingRow>
              </div>
              {inviteFailure ? (
                <p className="settings-notice settings-notice--error" role="alert">{inviteFailure}</p>
              ) : null}
              {createdInvite ? (
                <div className="settings-invite-receipt" role="status">
                  <span>
                    <b>邀请码（只显示这一次）</b>
                    <small>{`${createdInvite.tokenHint} · ${inviteRoleLabel(createdInvite.role)}${createdInvite.expiresAt ? ` · ${dayLabel(createdInvite.expiresAt)} 前有效` : " · 长期有效"}`}</small>
                  </span>
                  <code>{createdInvite.token}</code>
                  <button type="button" className="button primary" onClick={() => void copyInviteToken(createdInvite.token)}>
                    {copiedCode ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                    {copiedCode ? "已复制" : "复制"}
                  </button>
                </div>
              ) : null}
            </section>

            <section className="settings-group">
              <h3 className="settings-group__title">邀请记录</h3>
              <div className="settings-rows">
                {invitesFailure ? (
                  <SettingRow title="邀请记录暂时不可用" detail={invitesFailure}>
                    <button type="button" className="button" onClick={() => setAuxiliaryEpoch((value) => value + 1)}>重试</button>
                  </SettingRow>
                ) : !invitesRead ? (
                  <SettingRow title="正在读取邀请记录" detail="稍候，这不会阻塞其他设置。" />
                ) : (invites?.items.length ?? 0) === 0 ? (
                  <SettingRow title="暂无邀请记录" detail="在上方生成第一个邀请码。" />
                ) : invites?.items.map((invite) => (
                  <SettingRow
                    key={invite.id}
                    title={`${invite.tokenHint} · ${inviteRoleLabel(invite.role)}`}
                    detail={`创建 ${dayLabel(invite.createdAt)} · ${invite.expiresAt ? `过期 ${dayLabel(invite.expiresAt)}` : "长期有效"}${invite.consumedByEmail ? ` · 使用人 ${invite.consumedByEmail}` : ""}`}
                  >
                    <span className={invite.status === "active" ? "tag green" : "tag"}>{inviteStatusLabel(invite.status)}</span>
                    {invite.status === "active" ? (
                      <button
                        type="button"
                        className="button danger"
                        aria-label={`撤销邀请 ${invite.tokenHint}`}
                        disabled={ownerBusy !== null}
                        onClick={() => void revokeInvite(invite.id)}
                      >
                        {ownerBusy === invite.id ? "撤销中…" : "撤销"}
                      </button>
                    ) : null}
                  </SettingRow>
                ))}
              </div>
            </section>

            <section className="settings-group">
              <h3 className="settings-group__title">工作区成员</h3>
              <div className="settings-rows">
                {membersFailure ? (
                  <SettingRow title="成员名册暂时不可用" detail={membersFailure}>
                    <button type="button" className="button" onClick={() => setAuxiliaryEpoch((value) => value + 1)}>重试</button>
                  </SettingRow>
                ) : !membersRead ? (
                  <SettingRow title="正在读取成员" detail="稍候，这不会阻塞邀请功能。" />
                ) : (members?.items.length ?? 0) === 0 ? (
                  <SettingRow title="暂无成员" detail="通过邀请码邀请第一位成员。" />
                ) : members?.items.map((member) => (
                  <SettingRow
                    key={member.userId}
                    title={member.email}
                    detail={`${inviteRoleLabel(member.role)} · ${dayLabel(member.joinedAt)} 加入`}
                  >
                    {member.role !== "owner" ? (removeCandidate === member.userId ? (
                      <>
                        <button type="button" className="button" aria-label={`把 ${member.email} 设为所有者`} disabled={ownerBusy !== null} onClick={() => void transferOwnership(member)}>
                          {transferCandidate === member.userId ? "确认交出" : "设为所有者"}
                        </button>
                        <button type="button" className="button danger" aria-label={`移除成员 ${member.email}`} disabled={ownerBusy !== null} onClick={() => void removeMember(member.userId)}>
                          <Trash2 size={12} aria-hidden="true" />
                          确认移除
                        </button>
                        <button type="button" className="button" disabled={ownerBusy !== null} onClick={() => setRemoveCandidate(null)}>取消</button>
                      </>
                    ) : (
                      <>
                      <button type="button" className="button" aria-label={`把 ${member.email} 设为所有者`} disabled={ownerBusy !== null} onClick={() => void transferOwnership(member)}>
                        {transferCandidate === member.userId ? "确认交出" : "设为所有者"}
                      </button>
                      <button type="button" className="button danger" aria-label={`移除成员 ${member.email}`} disabled={ownerBusy !== null} onClick={() => void removeMember(member.userId)}>
                        <Trash2 size={12} aria-hidden="true" />
                        {ownerBusy === member.userId ? "移除中…" : "移除"}
                      </button>
                      </>
                    )) : (
                      <span className="tag green">Owner</span>
                    )}
                  </SettingRow>
                ))}
              </div>
            </section>
          </>
        ) : (
          <section className="settings-group">
            <h3 className="settings-group__title">邀请与成员</h3>
            <div className="settings-rows">
              <SettingRow
                title="只有空间所有者能发邀请、看名册、移成员"
                detail="你在这个空间是成员：读得到已共享的资料，也能做复习与验证；采集、写笔记和生成学习卡由所有者发起。名册与邀请要改动，请找所有者。"
              >
                <span className="tag">只读</span>
              </SettingRow>
            </div>
          </section>
        )}
      </>
    ),
    footerNote: isOwner && spaceIsPersonal
      ? "个人空间仅供你使用；一起学习可创建或加入协作空间。"
      : isOwner
        ? "邀请与成员只影响当前空间；AI 同意始终由每个人自己决定。"
        : "邀请码由空间所有者发出；AI 数据同意仍由你本人决定。",
    /**
     * 这一屏的清单有两种"没露出"：Owner／Member 看到的是完全不同的两组行（成员侧只有
     * 一句边界说明），而两份列表各自还在自己的读取分支里（读不到／还没读完／空的）。
     * 四条分支都照屏上那一刻那一行的标题登记，**读到的那一格换成"正在读取…"时，
     * 登记里也不许留着上一批邀请**。
     */
    readable: isOwner && spaceIsPersonal
      ? { items: [{ label: "个人空间不邀请别人", state: "个人空间" }] }
      : isOwner
        ? {
            filters: [
              { label: "邀请角色", value: segmentedValue(INVITE_ROLE_OPTIONS, inviteRole) ?? "" },
              { label: "邀请有效期", value: segmentedValue(INVITE_EXPIRY_OPTIONS, inviteExpiry) ?? "" },
            ],
            items: [
              ...(invitesFailure
                ? [{ label: "邀请记录暂时不可用" }]
                : !invitesRead
                  ? [{ label: "正在读取邀请记录" }]
                  : (invites?.items.length ?? 0) === 0
                    ? [{ label: "暂无邀请记录" }]
                    : (invites?.items ?? []).map((invite) => ({
                      label: `${invite.tokenHint} · ${inviteRoleLabel(invite.role)}`,
                      state: inviteStatusLabel(invite.status),
                    }))),
              ...(membersFailure
                ? [{ label: "成员名册暂时不可用" }]
                : !membersRead
                  ? [{ label: "正在读取成员" }]
                  : (members?.items.length ?? 0) === 0
                    ? [{ label: "暂无成员" }]
                    : (members?.items ?? []).map((member) => ({
                      label: member.email,
                      state: inviteRoleLabel(member.role),
                    }))),
            ].slice(0, 12),
          }
        : { items: [{ label: "只有空间所有者能发邀请、看名册、移成员", state: "只读" }] },
  });


  /** A visual choice: the two plates the reader actually stands on. */
  const appearancePanel = (): SettingsPanel => ({
    title: "主题与动效",
    body: (
      <>
        <section className="settings-group">
          <h3 className="settings-group__title">环境主题</h3>
          <SettingsThemePicker theme={theme} setTheme={setTheme} themeMode={themeMode} onFollowTime={followTimeTheme} />
        </section>

        <div className="settings-columns">
          <section className="settings-group">
            <h3 className="settings-group__title">动效与无障碍</h3>
            <SettingsMotionPreview />
            <div className="settings-rows">
              <SettingRow title="动效等级" detail="完整保留轻快回弹，轻量减少运动，关闭则直接就位。">
                <HudSegmented label="动效等级" value={motionMode} options={MOTION_OPTIONS} onChange={setMotionMode} compact />
              </SettingRow>
              <SettingRow title="系统减少动效" detail="由操作系统决定，优先级高于上面的等级。">
                <span className={reducedMotion ? "tag green" : "tag"}>{switchStateLine(reducedMotion)}</span>
              </SettingRow>
            </div>
          </section>

          <section className="settings-group">
            <h3 className="settings-group__title">左侧目录</h3>
            <div className="settings-rows">
              <SettingRow title="目录行为" detail="自动模式下进入内容后缩回底部，手动操作始终优先。">
                <HudSegmented label="目录行为" value={directoryMode} options={DIRECTORY_OPTIONS} onChange={changeDirectoryMode} compact />
              </SettingRow>
            </div>
          </section>
        </div>

      </>
    ),
    footerNote: "主题、动效、目录行为与入场引导都只影响这台设备，不写入工作区。",
    /**
     * 这一屏没有服务端读数：五项全是这台设备此刻的偏好，所以登记的是**每一行选中的那一档**，
     * 而不是"这里可以选什么"。「重播」那行只有一个按钮、没有取值，不登记（她答不出任何事实）。
     */
    readable: {
      filters: [{ label: "环境主题", value: themeMode === "system" ? "随时间变化" : themeLabel(theme) }],
      items: [
        { label: "动效等级", state: segmentedValue(MOTION_OPTIONS, motionMode) ?? undefined },
        { label: "系统减少动效", state: switchStateLine(reducedMotion) },
        { label: "目录行为", state: segmentedValue(DIRECTORY_OPTIONS, directoryMode) ?? undefined },
      ],
    },
  });

  /**
   * 一行一个音色：名字与说明直接用官方口径（声线特质、试听语种），不自己形容音质。
   * 「试听」不要求先选中——挑声音本来就是先听再定。
   */

  /** A control block, then what the companion is currently allowed to do. */
  const companionPanel = (): SettingsPanel => ({
    title: "伴星设置",
    body: <SettingsCompanionPanel onReadable={setCompanionReadable} capabilities={<>
      {capabilityFailure ? <SettingsInlineState title="伴星能力状态暂时不可用" detail={capabilityFailure} tone="error" onRetry={() => void load()} /> : null}
      <SettingsCompanionStatus live2dStatus={live2dStatus} capabilities={capabilities} companion={companion} features={features ?? null} actionReason={actionReason} featureReason={featureReason} nativeReason={nativeReason} />
    </>} />,
    footerNote: "人格与陪伴记录在伴星中心管理；这里调整运行规则与设备偏好。",
    readable: companionReadable,
  });

  /** Consent drawn as the path the data takes, then the policy your own account signs. */
  const dataPanel = (): SettingsPanel => {
    const policy = aiSettings?.dataPolicy ?? null;
    const signed = Boolean(aiSettings?.consentVersion);
    const busy = aiSaving !== null;
    const consentStateLine = signed ? "已签署" : aiSettings?.requiresConsent ? "需要签署" : "未签署";
    /** 「外发记录」那一格此刻的翻页读数（只有真读到过、且列表非空才成立）。 */
    const auditPagingLine = auditPage && auditPage.items.length > 0
      ? `第 ${auditOffset + 1}–${auditOffset + auditPage.items.length} 条 · 共 ${auditPage.total} 条`
      : null;
    if (aiSettingsFailure) {
      const unreadableDetail = `${aiSettingsFailure} 这一页不用默认值猜一个状态给你看，重试即可。`;
      return {
        title: "AI 数据同意",
        body: (
          <SettingsInlineState
            title="没能读到你的 AI 数据设置"
            detail={unreadableDetail}
            tone="error"
            onRetry={() => void load()}
          />
        ),
        footerNote: "政策状态读取成功后，才会开放签署与修改入口。",
        /** 整张卡被这张报错纸换掉了：一行策略、一行授权都不许登记。 */
        readable: { statusLine: "没能读到你的 AI 数据设置", notice: unreadableDetail },
      };
    }
    return {
      title: "AI 数据同意",
      body: (
        <>
          {capabilityFailure ? (
            <SettingsInlineState
              title="授权能力状态暂时不可用"
              detail={capabilityFailure}
              tone="error"
              onRetry={() => void load()}
            />
          ) : null}
          <p className="settings-notice-paper">使用外部 AI 时，完成任务所需的笔记、回答或图片可能发送到模型服务。下面的同意和外发策略跟着你的账号走；切换学习空间时沿用。</p>

          <details className="settings-disclosure"><summary><span><b>阅读《AI 使用协议》</b><small>当前版本 · {AI_CONSENT_VERSION}</small></span></summary><AiConsentTerms /></details>

          <section
            ref={consentGroupRef}
            className={`settings-group${consentAttention ? " settings-group--attention" : ""}`}
            data-attention={consentAttention ? SETTINGS_ATTENTION_AI_CONSENT : undefined}
          >
            {consentGuidance && companionConsentGate(aiSettings) !== null ? (
              <p className="settings-notice-paper" role="status">
                <strong>伴星：</strong>{companionConsentGate(aiSettings) === "external_disabled"
                  ? COMPANION_EXTERNAL_DISABLED_LINE : COMPANION_CONSENT_REQUIRED_LINE}
              </p>
            ) : null}
            <h3 className="settings-group__title">签署状态</h3>
            <div className="settings-rows">
              <SettingRow
                title="AI 使用同意"
                detail={!aiSettings
                  ? "还没有读到你的同意状态。"
                  : signed
                    ? `已签署（版本 ${aiSettings.consentVersion}）${aiSettings.consentAt ? ` · ${aiSettings.consentAt.slice(0, 10)}` : ""}`
                    : aiSettings.requiresConsent
                      ? "这里配了外部模型服务，没签署前你的内容不会离开这台设备。"
                      : "现在只用本机模型跑，不需要签署。"}
              >
                {signed
                  ? <span className="tag green">{consentStateLine}</span>
                  : <span className="tag">{consentStateLine}</span>}
              </SettingRow>
              {!signed ? (
                <SettingRow
                  title="签署同意"
                  detail={`签署当前版本（${AI_CONSENT_VERSION}）并开启外部 AI。已有的图片、检测和审计选择保留；你可以随时关闭外发。同意只对你的账号生效，切换空间时沿用。`}
                >
                  <button type="button" className="button primary" disabled={busy} onClick={() => void signConsent()}>
                    {aiSaving === "consent" ? "签署中…" : "签署"}
                  </button>
                </SettingRow>
              ) : null}
            </div>
          </section>

          <SettingsDataBoundaryGroup
            policy={policy}
            busy={busy}
            aiSaving={aiSaving}
            isOwner={isOwner}
            audit={{ auditPage, auditOffset, auditBusy, auditFailure, auditPagingLine }}
            onSavePolicy={saveDataPolicy}
            loadAuditPage={loadAuditPage}
            auditPageSize={AUDIT_PAGE_SIZE}
            formatWhen={formatObjectiveDateTime}
          />

          <details className="settings-disclosure" open={aiDetailsOpen} onToggle={event => setAiDetailsOpen(event.currentTarget.open)}>
            <summary><span><b>查看当前 AI 可用范围</b><small>这些状态由同意、策略与服务能力决定。</small></span></summary>
            <p className="settings-group__note">由上面的同意与数据策略推导，这一组不能单独修改。</p>
            <div className="settings-rows settings-rows--split">
              {COMPANION_GRANTS.map((grant) => (
                <SettingRow key={grant.key} mark={grant.mark} title={grant.title} detail={grant.detail}>
                  <CapabilityChip value={companion?.[grant.key]} reason={actionReason(companion?.[grant.key])} />
                </SettingRow>
              ))}
            </div>
          </details>
        </>
      ),
      footerNote: "改动会立刻存到服务器，这一页的能力状态同时刷新。",
      // Folded capability rows stay out of the page facts until the reader opens them.
      // Audit entries use their paging line because the page-facts contract is capped at twelve rows.
      readable: {
        ...(capabilityFailure ? { statusLine: "授权能力状态暂时不可用", notice: capabilityFailure } : {}),
        items: [
          { label: "AI 使用同意", state: consentStateLine },
          ...(!signed ? [{ label: "签署同意" }] : []),
          ...DATA_POLICY_FIELDS.map(([field, title]) => ({
            label: title,
            state: switchStateLine(policy?.[field] ?? false),
          })),
          { label: "外发记录" },
          ...(auditFailure
            ? [{ label: "外发记录暂时读不到" }]
            : auditPagingLine
              ? [{ label: auditPagingLine }]
              : isOwner && auditPage && auditPage.items.length === 0
                ? [{ label: "还没有外发记录" }]
                : []),
          ...(aiDetailsOpen ? COMPANION_GRANTS.map((grant) => ({
            label: grant.title,
            state: capabilityChipLabel("action", companion?.[grant.key]) ?? undefined,
          })) : []),
        ].slice(0, 12),
      },
    };
  };

  /** An inventory of what the workspace holds, then where lifecycle actions live. */
  const managementPanel = (): SettingsPanel => ({
    title: "数据与维护",
    body: (
      <>
        {/* 更新排在最上面：进这一页的用户多半是冲着"是不是该更新了"来的，
            那是这一页的第一件事；统计和导出往下压。 */}
        <SettingsUpdateGroup
          state={update.state}
          busy={update.checking || update.downloading || update.installing}
          onCheck={() => { void update.check(); }}
          onDownload={() => { void update.download(); }}
          onInstall={() => { void update.install(); }}
        />

        <SettingsRenderingGroup />

        <section className="settings-group">
          <h3 className="settings-group__title">空间内容</h3>
          <p className="settings-group__note">导出的存档只包含「{currentWorkspace?.name ?? "当前空间"}」；其他空间各自保存。</p>
          <div className="settings-stats">
            <div className="settings-stat" data-loading={inventoryLoading ? "true" : undefined}>
              <b>{countOrDash(inventory?.sources)}</b>
              <span>来源</span>
            </div>
            <div className="settings-stat" data-loading={inventoryLoading ? "true" : undefined}>
              <b>{countOrDash(inventory?.notes)}</b>
              <span>笔记</span>
            </div>
            <div className="settings-stat" data-loading={inventoryLoading ? "true" : undefined}>
              <b>{countOrDash(inventory?.objectives)}</b>
              <span>学习卡</span>
            </div>
          </div>
          {inventoryFailure ? (
            <SettingsInlineState
              title="空间内容数量暂时不可用"
              detail={inventoryFailure}
              tone="error"
              onRetry={() => setInventoryEpoch((value) => value + 1)}
            />
          ) : null}
        </section>

        <div className="settings-columns">
          <SettingsExportGroup
            currentRole={currentRole}
            exporting={exporting}
            markdownExporting={markdownExporting}
            onExport={exportWorkspace}
            onExportMarkdown={exportNotesMarkdown}
            onImported={invoke}
            onCloseSurface={closeSurface}
          />
        </div>

        <details className="settings-disclosure" open={deviceDetailsOpen} onToggle={event => setDeviceDetailsOpen(event.currentTarget.open)}>
          <summary><span><b>设备功能状态</b><small>遇到剪贴板、通知或更新问题时，在这里查看接入情况。</small></span></summary>
          <p className="settings-group__note">这里显示这台设备实际可用的功能。</p>
          {capabilityFailure ? (
            <SettingsInlineState title="本机能力状态暂时不可用" detail={capabilityFailure} tone="error" onRetry={() => void load()} />
          ) : (
            <div className="settings-rows settings-rows--split">
              <SettingRow mark={<Clipboard size={15} />} title="剪贴板链接识别" detail="回到学习空间时只识别刚复制的链接；导入前一定先问你。">
                <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.clipboard} reason={nativeReason(capabilities?.nativeCapabilities.clipboard)} />
              </SettingRow>
              <SettingRow mark={<Bell size={15} />} title="系统通知" detail="学习提醒通道；未接入时不会伪装成可配置开关。">
                <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.notifications} reason={nativeReason(capabilities?.nativeCapabilities.notifications)} />
              </SettingRow>
              <SettingRow mark={<Download size={15} />} title="自动更新" detail="客户端更新通道；未接入时不会显示虚假的检查按钮。">
                <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.updates} reason={nativeReason(capabilities?.nativeCapabilities.updates)} />
              </SettingRow>
            </div>
          )}
          <p className="settings-group__note settings-group__note--after">“未接入”表示客户端没有这条链路，不是系统权限被拒绝。</p>
        </details>

        {/* 搜索索引维护（F-025 / F-011，Owner）。 */}
        {currentRole === "owner" ? (
          <details className="settings-disclosure">
            <summary>
              <span>
                <b>搜索异常排查</b>
                <small>明明有内容却搜不到时，检查或重建这个空间的搜索目录。</small>
              </span>
            </summary>
            <div className="settings-rows">
              <SettingRow
                title="漂移检测"
                detail={!drift
                  ? "核对业务表与搜索索引是否一致（幽灵 / 缺失 / 过期文档）。"
                  : drift.hasDrift
                    ? `发现漂移：缺失 ${drift.missing}、幽灵 ${drift.ghosts}、内容过期 ${drift.stale}。`
                    : "索引与业务表一致，没有漂移。"}
              >
                {drift
                  ? <span className={drift.hasDrift ? "tag" : "tag green"}>{drift.hasDrift ? "有漂移" : "一致"}</span>
                  : null}
                <button type="button" className="button" disabled={ownerBusy !== null} onClick={() => void checkSearchDrift()}>
                  <SearchCheck size={13} aria-hidden="true" />
                  {ownerBusy === "drift" ? "检测中…" : "检测"}
                </button>
              </SettingRow>
              <SettingRow
                title="重建索引"
                detail={!reindexResult
                  ? "清空并重建这个空间的搜索索引；中间任何一步失败都会退回原样。"
                  : `已删除 ${reindexResult.deleted} 条旧文档，重建笔记 ${reindexResult.indexedNotes} / 来源 ${reindexResult.indexedSources} / 目标 ${reindexResult.indexedObjectives}${reindexResult.errors > 0 ? `，${reindexResult.errors} 条失败` : ""}${reindexResult.capped ? "（超出单表行数上限，结果被截断）" : ""}。`}
              >
                <button type="button" className="button" disabled={ownerBusy !== null} onClick={() => void runSearchReindex()}>
                  <RefreshCw size={13} aria-hidden="true" />
                  {ownerBusy === "reindex" ? "重建中…" : "重建"}
                </button>
              </SettingRow>
            </div>
          </details>
        ) : null}
      </>
    ),
    footerNote: "导出会生成一份只读存档；学习内容仍保留在当前空间。",
    /**
     * 状态字取**屏上从上到下第一张报错纸**（内容数量那一块在上方，先挡住它说的事）。
     * 「搜索异常排查」整块收在 `<details>` 里，默认没露出 ⇒ 漂移与重建的读数一条都不登记；
     * 三颗导出／导入按钮那几行没有取值，也不登记。
     */
    readable: {
      ...(inventoryFailure
        ? { statusLine: "空间内容数量暂时不可用", notice: inventoryFailure }
        : capabilityFailure && deviceDetailsOpen
          ? { statusLine: "本机能力状态暂时不可用", notice: capabilityFailure }
          : {}),
      metrics: [
        { label: "来源", value: countOrDash(inventory?.sources) },
        { label: "笔记", value: countOrDash(inventory?.notes) },
        { label: "学习卡", value: countOrDash(inventory?.objectives) },
      ],
      items: deviceDetailsOpen ? [
        { label: "剪贴板链接识别", state: capabilityChipLabel("native", capabilities?.nativeCapabilities.clipboard) ?? undefined },
        { label: "系统通知", state: capabilityChipLabel("native", capabilities?.nativeCapabilities.notifications) ?? undefined },
        { label: "自动更新", state: capabilityChipLabel("native", capabilities?.nativeCapabilities.updates) ?? undefined },
      ] : [],
    },
  });

  const PANELS: Record<SettingsSectionId, () => SettingsPanel> = {
    account: accountPanel,
    members: membersPanel,
    appearance: appearancePanel,
    companion: companionPanel,
    data: dataPanel,
    management: managementPanel,
  };

  const panel = PANELS[section]();

  /**
   * 这一屏登记给伴星读的是什么（39d W2-7 落下的最后一页）。
   *
   * 六个分区各自只报自己那份事实（见 `SettingsReadable`），公用的三样在这里拼一次：
   * 页身份、页名、当前在哪一格目录上。**整页还在读取、或整页读不到的时候，分区那一份
   * 一个字都不发**——那一刻屏上是外壳那两张纸，分区里的数字属于上一轮。
   * 状态字取不到分区自己的那句时，用的是页脚那句说明：它本来就写在屏上。
   */
  const sectionLabel = SECTIONS.find(([id]) => id === section)?.[1] ?? section;
  const settingsReadableView: PageReadableV1 = loading || failure
    ? {
        pageId: "settings",
        title: HUD_PAGES.settings.title,
        statusLine: loading ? SETTINGS_LOADING.message : SETTINGS_UNAVAILABLE,
        ...(failure ? { notice: failure.slice(0, 200) } : {}),
        filters: [{ label: SECTION_FILTER_LABEL, value: sectionLabel }],
      }
    : {
        pageId: "settings",
        title: HUD_PAGES.settings.title,
        statusLine: (panel.readable.statusLine ?? panel.footerNote ?? panel.title).slice(0, 160),
        ...(panel.readable.notice ? { notice: panel.readable.notice.slice(0, 200) } : {}),
        ...(panel.readable.metrics?.length
          ? { metrics: panel.readable.metrics.slice(0, 6).map((entry) => ({ label: entry.label.slice(0, 40), value: entry.value.slice(0, 40) })) }
          : {}),
        filters: [
          { label: SECTION_FILTER_LABEL, value: sectionLabel },
          ...(panel.readable.filters ?? []).map((entry) => ({ label: entry.label.slice(0, 40), value: entry.value.slice(0, 40) })),
        ].slice(0, 6),
        ...(panel.readable.items?.length
          ? {
              items: panel.readable.items.slice(0, 12).map((row, index) => ({
                ordinal: index + 1,
                label: row.label.slice(0, 120),
                ...(row.state ? { state: row.state.slice(0, 40) } : {}),
              })),
            }
          : {}),
      };
  usePageReadableView(settingsReadableView);

  return <SettingsBook
    section={section}
    onSectionChange={next => { setSettingsSection(next); setNotice(null); setFailureNotice(null); }}
    workspaceName={currentWorkspace?.name}
    loading={loading}
    failure={failure}
    onRetry={() => void load()}
    title={panel.title}
    footerNote={panel.footerNote}
    notice={notice}
    failureNotice={failureNotice}
    onDismissNotice={() => { setNotice(null); setFailureNotice(null); }}
    onReplayIntro={replayIntro}
  >{(visitedSections.includes(section) ? visitedSections : [...visitedSections, section]).map(id => <Activity key={id} mode={id === section ? "visible" : "hidden"}>
    <div className="settings-section-content" data-settings-active={id === section ? "true" : "false"}>{id === section ? panel.body : PANELS[id]().body}</div>
  </Activity>)}</SettingsBook>;
}
