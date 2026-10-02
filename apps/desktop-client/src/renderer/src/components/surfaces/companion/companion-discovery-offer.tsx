/**
 * 40 §7：「自然停顿时可以提供**一次**『留在发现簿』，用户忽略后不再催促。」
 *
 * ## 这个文件只做"一次机会"这一件事
 *
 * 合同那句话有两个硬要求，缺一个就变成另一种东西：
 *
 *  1. **一次**——不是每条回复旁都挂一颗按钮。常驻的按钮会变成界面的一部分，
 *     用户每次看见都要重新判断一次要不要点，于是它就变成了噪声，也就不再是
 *     「一次机会」。所以这里只有**最新那一句**（= 她刚说完的那次停顿）带入口。
 *  2. **忽略后不再催促**——这条必须跨重启成立。只放在 React state 里的话，
 *     关掉应用再打开，同一句话又来问一遍，而用户已经明确说过「先不留」。
 *     所以「先不留」写进 localStorage。
 *
 * ## 收藏的必须是用户能点回去的原文
 *
 * 这里传进来的 `body` 是**屏上正在显示的那段话本身**，不是任何概括、摘要或
 * 模型推测。发现簿是「本人收藏的视图」，收藏一句模型自己复述的话等于把
 * 二手判断当成本人的理解存起来——那正是 §7「各自标清作者和来源」要防的事。
 *
 * ## 同一身份不重复插入这件事不在这里做
 *
 * 服务端按 `UNIQUE (workspace, user, kind, source, source_id)` upsert，重复收藏
 * 会回到 `already_collected` 而不是新插一行。所以这里**不**自己造去重逻辑，
 * 只把同一个身份三元组原样传下去（见 `companion-discovery-identity.test.ts`）。
 */
import type { CompanionDiscoveryKind, CompanionDiscoverySource } from "@ailearn/shared/desktop-ipc-contracts";

/** §7 共用身份三元组。发现簿页与这里的按钮传的是同一份。 */
export interface DiscoveryKeepIdentity {
  readonly kind: CompanionDiscoveryKind;
  readonly source: CompanionDiscoverySource;
  readonly sourceId: string;
}

/** 一次收藏请求的完整形状（与 preload 通道的入参一致）。 */
export interface DiscoveryKeepRequest extends DiscoveryKeepIdentity {
  readonly author: "user" | "assistant";
  readonly body: string;
}

/**
 * 正文上限。服务端入口 schema 与入库列都按 4000 字收，多一个字符就是 422。
 *
 * 截断在这里做而不是让用户看见一次失败：超长的回答与日记本来就存在，
 * 而"因为太长所以留不下来"对用户没有任何意义。省略号标出这是一段摘录。
 */
export const DISCOVERY_BODY_MAX = 4000;

export function clipDiscoveryBody(text: string, limit = DISCOVERY_BODY_MAX): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1)}…`;
}

/** 身份三元组的稳定写法。簿子里与这里都用它，避免两处各拼一种 key。 */
export function discoveryIdentityKey(identity: DiscoveryKeepIdentity): string {
  return `${identity.kind}|${identity.source}|${identity.sourceId}`;
}

// ── 「先不留」之后不再问 ──────────────────────────────────────────────────
//
// 沿用 `space-recents.ts` / `source-intake.ts` 的本机存储写法：读不出来当没有，
// 写不进去也不挡操作。隐私浏览或手改过的残留都不该让这句话变成一个坏掉的功能。

const DECLINED_KEY = "ailearn:companion-discovery-declined";

type OfferStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): OfferStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 用户是否已经说过「先不留」。跨重启成立——合同要的就是「不再催促」。 */
export function readDiscoveryKeepDeclined(storage: OfferStorage | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(DECLINED_KEY) === "declined";
  } catch {
    return false;
  }
}

export function rememberDiscoveryKeepDeclined(storage: OfferStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(DECLINED_KEY, "declined");
  } catch {
    // 写不进去就退化成"本次运行内不再问"——比让按钮变灰却说不出原因好。
  }
}

// ── 这一处现在该显示什么 ──────────────────────────────────────────────────

export type DiscoveryKeepState =
  /** 从没问过：显示那一次机会。 */
  | "offer"
  /** 已经收下了：显示角标，不再给第二次。 */
  | "kept"
  /** 用户说过「先不留」：全局不再问（§7「忽略后不再催促」）。 */
  | "declined"
  /** 不是最新那一次停顿，或这一条已经处理过：什么都不显示。 */
  | "hidden";

/**
 * 把「谁在说话」翻成簿子里该记成谁。
 *
 * 簿子里的作者是**必填**的：一条没有标作者的建议，读起来就像用户自己写的。
 * 这里从消息角色推，不让渲染层自己填——填错一次就是簿子里多一句冒充用户的话。
 */
export function discoveryAuthorFor(role: "user" | "assistant"): "user" | "assistant" {
  return role === "user" ? "user" : "assistant";
}

/**
 * 她说的那一句话在簿子里算哪一类。
 *
 * 她整理过的内容对应 `kept_ai_suggestion`；用户自己说的对应 `user_utterance`
 * （§7「用户原话」）。两者都由服务端 `evaluateDiscoveryEntry` 校验过组合关系，
 * 这里只负责给出与角色一致的那一对。
 */
export function discoveryKindFor(role: "user" | "assistant"): CompanionDiscoveryKind {
  return role === "user" ? "user_utterance" : "kept_ai_suggestion";
}

/** 纯函数：这一处现在显示机会、角标，还是什么都不显示。 */
export function resolveDiscoveryKeepState(input: {
  /** 这是不是最新那一次自然停顿。只有最新那一次才问。 */
  readonly isLatestPause: boolean;
  /** 簿子里已经有这一份了吗（问过服务端 `discovery.state`）。 */
  readonly alreadyCollected: boolean;
  /** 用户在别处说过「先不留」。 */
  readonly declined: boolean;
  /** 这一次已经问过了（成功或失败），不再问第二次。 */
  readonly spent: boolean;
}): DiscoveryKeepState {
  if (input.alreadyCollected) return "kept";
  if (input.declined) return "declined";
  if (!input.isLatestPause || input.spent) return "hidden";
  return "offer";
}

/** 屏上那一行：机会、角标与失败说明。 */
export interface DiscoveryKeepProps {
  readonly state: DiscoveryKeepState;
  readonly busy: boolean;
  /** 收藏成功或失败后的一句说明。null = 还没有发生过。 */
  readonly feedback: string | null;
  /** 收藏失败（那一行是 role="alert"）。 */
  readonly failure: string | null;
  readonly onKeep: () => void;
  readonly onDecline: () => void;
}

export function DiscoveryKeepAction(props: DiscoveryKeepProps) {
  if (props.state === "hidden") return null;
  if (props.state === "kept") {
    return <p className="discovery-keep discovery-keep--kept" role="status">已留在发现簿，可以在那一页找到它。</p>;
  }
  if (props.state === "declined") return null;
  return <div className="discovery-keep">
    {/*
      文案说的是**这件事对用户意味着什么**：留下的是屏上这一段原话，
      之后仍然只是他自己的收藏（不进入评分、不建立学习目标）。
      「先不留」是一个真的出口——没有它，这个入口就只是又一处必须解释的压力。
    */}
    <button
      type="button"
      disabled={props.busy}
      data-busy={props.busy || undefined}
      onClick={props.onKeep}
      aria-label="把这一段原话留在发现簿"
    >{props.busy ? "正在留下…" : "留在发现簿"}</button>
    <button type="button" className="text-action" disabled={props.busy} onClick={props.onDecline}>先不留</button>
    <small>留下的是上面这一段原话，之后只是你自己的收藏。</small>
    {props.failure ? <p className="discovery-keep__error" role="alert">{props.failure}</p> : null}
    {props.feedback ? <p className="discovery-keep__notice" role="status">{props.feedback}</p> : null}
  </div>;
}
