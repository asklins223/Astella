/**
 * 伴星会话的**派生逻辑**（2026-09-30 从 `companion-chat-session.tsx` 抽出）。
 *
 * ## 为什么抽
 *
 * 那个文件里原本混着两件毫不相干的事：**Provider**（取数 + 状态机 + 发消息）
 * 与**纯函数**（路由怎么落、文案怎么拼、nav chip 该不该留在消息外面、
 * 两个错误怎么映射成人话）。后者**一个 hook 都没有**，却占了两百多行——
 * 读 Provider 的人要一路滑过去，才知道它其实不碰状态。
 *
 * 判据就是 AGENTS.md 那句「页面组件只做四件事：取数、派生、摆位、接事件」：
 * **派生该有自己的地方。**
 *
 * ## 拆的是位置，不是行为
 *
 * 函数体**一个字没改**。原来靠同文件顶层可见的依赖这里显式 import；
 * 原来在本文件声明的类型从 `companion-chat-session` 取——**单向依赖**，不成环。
 *
 * ## 搬运必须按 AST 区间，不能按行号算术
 *
 * 两次栽在同一个地方：手算「从 JSDoc 起、到下一个顶层声明止」的区间，
 * 一次把 `/**` 留在原文件（新文件从 `* …` 开始 → `Expression expected`），
 * 一次把区间短成只有那段 JSDoc（函数体全留下 → `Cannot redeclare`），
 * **而报错行号离真因几百行**。`node.getStart()` / `node.getEnd()` 不会。
 */

import type { CompanionNavChip } from "./companion-chat-session";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CharacterCuePayloadV1,
  CompanionContentBlockV1,
  CompanionMessageV1,
  CompanionPageContextV1,
} from "@astella/shared/companion-conversation-contracts";
import type {
  CompanionAgentRouteEventV1,
  CompanionChatConversationV1,
  CompanionChatProposalGetResultV1,
} from "@astella/shared/companion-chat-desktop-contracts";
import type { DesktopRouteV1 } from "@astella/shared/desktop-ipc-contracts";
import { agentArtifactRefV1Schema } from "@astella/shared/agent-contracts";
import type { MainPageContextInputV2, PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import { companionPageRouteV2, SETTINGS_SECTION_IDS_V2 } from "@astella/shared/companion-bridge-contracts";
import { useRoomStore } from "../home/room-store";
import { openAgentArtifact } from "../../components/companion/goals/agent-goal-presentation";
import type { HudPageId } from "../../components/hud/hud-pages";
import { createRequestMeta, gatewayErrorMessage, requireWorkspaceEpoch, unwrapGatewayResult, RendererGatewayError } from "../client/desktop-client";
import {
  COMPANION_CONSENT_REQUIRED_LINE,
  SETTINGS_ATTENTION_AI_CONSENT,
  companionConsentGate,
  isCompanionConsentFailure,
} from "../companion-pages/companion-consent-gate";
import type { CompanionFeedNoteAnchor, CompanionNoteIntent } from "../../components/companion/hud/companion-feed";
import {
  appendCompanionAgentNode,
  buildCompanionRunTraces,
  type CompanionAgentNodes,
  type CompanionRunTrace,
} from "./companion-agent-nodes";
export function desktopRouteFromAgentRoute(route: CompanionAgentRouteEventV1["route"]): DesktopRouteV1 | null {
  switch (route.kind) {
    case "settings":
      return route.section
        ? { kind: "settings.section", section: route.section }
        : companionPageRouteV2("settings");
    case "source":
      return route.sourceId
        ? { kind: "source.detail", sourceId: route.sourceId }
        : companionPageRouteV2("source");
    case "note":
      return { kind: "note.detail", noteId: route.noteId, ...(route.noteVersionId ? { noteVersionId: route.noteVersionId } : {}) };
    // 那一份产物按回执精确取回，形状就是手记成果卡在用的 `agentArtifactRefV1`。
    // 认不出来（种类不在落点表里）就映射成 null——递一个点了没反应的按钮比没有按钮更糟。
    case "learning_artifact": {
      const parsed = agentArtifactRefV1Schema.safeParse({
        kind: route.artifactKind,
        id: route.artifactId,
        jobId: route.taskId,
        noteId: route.noteId,
        noteVersionId: route.noteVersionId,
      });
      return parsed.success ? { kind: "note.artifact", artifact: parsed.data } : null;
    }
    case "home":
    case "note_library":
    case "search":
    case "star_map":
    case "conversation":
      return companionPageRouteV2(route.kind);
    default:
      return null;
  }
}

export function companionMessageText(message: CompanionMessageV1): string {
  return message.blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "code") return block.code;
      if (block.type === "citation") return block.referenceId ? "" : `[${block.label}]`;
      return "";
    })
    .filter((value) => value.length > 0)
    .join("\n");
}

export async function applyRouteToRoom(route: DesktopRouteV1): Promise<boolean> {
  const room = useRoomStore.getState();
  switch (route.kind) {
    case "room.home":
      room.invoke("home");
      return true;
    case "understanding.graph":
      room.invoke("graph");
      return true;
    case "search.global":
      room.invoke("search");
      return true;
    case "note.library":
      room.invoke("open-notes");
      return true;
    case "settings.section":
      room.setSettingsSection(route.section);
      room.invoke("open-settings");
      return true;
    case "source.library":
      room.invoke("open-sources");
      return true;
    case "source.detail":
      room.setActiveSourceId(route.sourceId);
      room.invoke("open-source");
      return true;
    case "note.detail":
      // 阅读页只按 noteId 读当前版本（NoteTargetRef 的契约），版本号如实留空。
      room.setActiveNoteRef({ noteId: route.noteId, noteVersionId: null, mode: "preview" });
      room.setNoteReturnTo("library");
      room.invoke("open-notebook");
      return true;
    case "note.artifact":
      // 与手记里那张成果卡同一个落点：同一份 setActiveNoteRef（带 learningResult/learningView）
      // 加同一次 invoke。这里再写一遍"怎么打开一份学习产物"就会分叉——那条路径上
      // 版本号、taskId 与清掉 learningView 的时机都各有讲究。
      return openAgentArtifact(route.artifact, room.workspaceScopeRevision);
    case "companion.center":
      room.setCompanionCenterTarget({
        tab: route.tab ?? "memory",
        ...(route.focusMemoryId ? { focusMemoryId: route.focusMemoryId } : {}),
        ...(route.focusMessageId ? { focusMessageId: route.focusMessageId } : {}),
      });
      room.invoke("open-companion-center");
      return true;
    default:
      return false;
  }
}

/**
 * 历史消息没有活动会话对象，但其中保存的推荐仍应能按用户点击前往。
 * 复用与会话 goToRoute 相同的服务端解析、工作区切换检查和页面落点。
 */
export async function navigateCompanionHistoryRoute(route: DesktopRouteV1): Promise<void> {
  const scopeRevision = useRoomStore.getState().workspaceScopeRevision;
  const resolved = unwrapGatewayResult(await window.astella.navigation.resolve({ meta: createRequestMeta(), route }));
  if (resolved.current.scope !== "workspace") throw new Error("navigation did not resolve to the current workspace");
  if (useRoomStore.getState().workspaceScopeRevision !== scopeRevision) throw new Error("工作空间已切换，请在当前空间重新操作。");
  unwrapGatewayResult(await window.astella.navigation.go({
    meta: createRequestMeta(resolved.current.workspaceEpoch),
    route: resolved.current.route,
    entryKind: "user",
  }));
  if (useRoomStore.getState().workspaceScopeRevision !== scopeRevision) throw new Error("工作空间已切换，请在当前空间重新操作。");
  if (!await applyRouteToRoom(resolved.current.route)) throw new Error("这个落点在桌面端还没有对应的页面");
  if (useRoomStore.getState().workspaceScopeRevision !== scopeRevision) throw new Error("工作空间已切换，请在当前空间重新操作。");
}

export function navChipSharesTarget(a: CompanionNavChip, b: CompanionNavChip): boolean {
  return a.summary === b.summary && JSON.stringify(a.route) === JSON.stringify(b.route);
}

export function navChipsStillOutsideMessages(
  chips: readonly CompanionNavChip[],
  messages: readonly CompanionMessageV1[],
): CompanionNavChip[] {
  const landed = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "nav") {
        // 比映射**之后**的桌面路由：chip 存的就是这个形状，映射不到的两边都是 null。
        landed.add(JSON.stringify(desktopRouteFromAgentRoute(block.route)));
      }
    }
  }
  if (landed.size === 0) return [...chips];
  return chips.filter((chip) => !landed.has(JSON.stringify(chip.route)));
}

export async function readCompleteCompanionHistory(
  baseline: number | null,
  loadPage: (beforeSeq: number) => Promise<{
    readonly items: readonly CompanionMessageV1[];
    readonly hasMore: boolean;
    readonly oldestSeq: number | null;
  } | null>,
): Promise<CompanionMessageV1[] | null> {
  const older: CompanionMessageV1[] = [];
  let beforeSeq = baseline;
  try {
    while (beforeSeq != null) {
      const page = await loadPage(beforeSeq);
      if (!page) return null;
      older.push(...page.items);
      if (!page.hasMore) break;
      if (page.oldestSeq == null || page.oldestSeq >= beforeSeq) return null;
      beforeSeq = page.oldestSeq;
    }
  } catch {
    return null;
  }
  return older.sort((a, b) => a.seq - b.seq);
}

export function isCompanionRunConflict(error: unknown): boolean {
  return error instanceof RendererGatewayError && error.code === "conflict";
}

export function companionTurnErrorMessage(error: unknown, blockedRunIdentified = true): string {
  if (isCompanionRunConflict(error)) {
    // 认得出是哪一条挡着，界面上就有那颗「停掉上一条」；认不出（那条读被限流，
    // 或者它已经不在最新的摘要窗口里）就别再指向一个不存在的按钮——服务端的回收器
    // 会在几十秒内把它收掉，说清这件事才是真话。
    return blockedRunIdentified
      ? "上一条还挂着。按「停掉上一条」，这句就能立刻发出去。"
      // 认不出是哪条 run 时，旧文案说「系统几十秒内会自动收掉它」——线上（2026-10-17）
      // 实际是本地接替号过期，一条 run 也没挂着，用户照着等只会一直发不出去。
      // 现在客户端会先清掉旧号、空手重发一次；走到这句说明确实还有一条读不到的活动
      // run，那就只陈述能确认的事实。
      : "这句还没发出去：上一轮的状态暂时对不上，稍等一下再发一次。";
  }
  return gatewayErrorMessage(error);
}

export function companionReplyFailureMessage(code: unknown, recoverable: unknown): string {
  if (code === "TOOL_ARGUMENTS_INVALID") return "这一步没能执行，已停止重复尝试；已经做好的内容还在。";
  if (code === "REPLY_FORMAT_INVALID") return "这次答复格式异常，已停止输出；已经做好的内容还在。";
  if (code === "ACTION_NOT_EXECUTED") return "这次没能确认操作完成，已经做好的内容还在。";
  if (code === "CONTEXT_STALE") return "这一轮依据的上下文已变化，原回复已停止。请先查看已有结果，再按当前内容继续。";
  // 孤儿 run 被回收（迁移 0232/0424）：这一轮的处理任务根本没跑起来，或跑它的进程
  // 已经没了。说清楚"不是这句话的问题"，并且别再指向一颗此刻并不存在的停止按钮。
  if (typeof code === "string" && code.startsWith("JOB_")) {
    return "这一轮的后台任务已中断。已有内容和操作结果仍保留，请先查看结果再决定是否继续。";
  }
  // 达到长度上限不是"没做成"：已经说出的那半句是有效的，缺的是后半段。
  // 以前这条落进 recoverable=false 的通用文案，用户看到「这一轮没能完成。重新说一遍就好」＋半截正文，
  // 而 worker 早就写好了「可以接着分段讲」——两侧说的是两件事。
  if (code === "REPLY_LENGTH_LIMIT") return "这次答复达到长度上限，已经说出的内容保留；说一句「接着讲」，我就从断的地方往下说。";
  if (code === "RATE_LIMITED") return "模型服务暂时繁忙，稍后再试就好。已经做好的内容还在。";
  if (code === "PROVIDER_UNAVAILABLE") return "模型服务暂时不可用，已经做好的内容还在。";
  if (code === "PROVIDER_FIRST_OUTPUT_TIMEOUT") return "模型服务未能及时返回首段内容。已有内容保留，可以从中断处继续。";
  if (code === "PROVIDER_IDLE_TIMEOUT") return "模型输出中断，等待新的进展超时。已有内容保留，可以从中断处继续。";
  return recoverable === false ? "这一轮没能完成。已有内容和操作结果仍保留，请先查看结果再决定下一步。" : "这一轮暂时没能完成，可以先查看已有内容再继续。";
}
