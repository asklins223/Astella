/**
 * 每轮"路由/放行闸"读数（`companion_turn_runs.route`，迁移 0442）。
 *
 * 为什么单独落库：现在首字的账 = 网关首 token + 路由/放行增量，两者的比例每轮都在变。
 * 只写日志时，"这轮慢是分类器超时还是模型慢"要人去翻两条日志对时间；落成一列之后，
 * 直接按 `route->'classifier'->>'elapsedMs'` 和事件流的首字相减即可。
 *
 * 形状是**开放 JSONB**：L1 的 `source`/`probability`/`sim` 等字段以后往同一个对象里
 * 加，不再来一次迁移。只记读数，不记任何对话文本。
 *
 * 这里同时提供 `createCompanionRouteRecorder()`：把"收分类器回执 / 记放行时刻 /
 * 落一行 route"三件小事收进一个录制器，让 runtime 只留几行调用。原因很实在——
 * `companion-agent-runtime.ts` 已经贴着 1500 行的神文件阈值，任何原地加逻辑都会
 * 让 `god-file-ratchet` 变红。
 */

import { logger } from "../../lib/logger.ts";
import { updateRunMeta } from "./companion-agent-events.ts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";
import type { CompanionHybridFacts } from "../turn/companion-hybrid-entry.ts";
import {
  evaluateCompanionRelease,
  rememberCompanionReleaseSample,
  resolveCompanionReleaseRouterMode,
  type CompanionReleaseGates,
  type CompanionReleaseRouterMode,
} from "./companion-release-router.ts";

export interface CompanionRouteClassifierFacts {
  /** `l2` = 正常分类调用；`timeout` = 分类失败/超时退回 uncertain；`cached` = 复用已存解释。 */
  readonly source: "l2" | "timeout" | "cached" | "direct";
  readonly elapsedMs: number | null;
  /** 这次分类是否真的并发了两条上游请求（延迟对冲）。 */
  readonly hedged: boolean;
}

export interface CompanionReleaseShadowFacts {
  readonly mode: "shadow" | "enforce";
  readonly decision: "release" | "wait";
  readonly reason: string;
  readonly intentGuess: "conversation" | "question" | null;
  readonly safeProbability: number | null;
  readonly toolNoneProbability: number | null;
  readonly topSimilarity: number | null;
  readonly samples: number;
  readonly gates: CompanionReleaseGates;
  /** 同一轮 L2 的结论（用于离线算覆盖率和漏放率；不存原话）。 */
  readonly actual: { readonly intent: string; readonly toolUse: string; readonly safe: boolean } | null;
  readonly agreement: "aligned" | "misrelease" | "conservative" | "unknown";
}

export interface CompanionRouteRecordV1 {
  readonly version: 1;
  readonly entryMode?: "classified" | "direct_fast" | "direct_thinking" | "hybrid";
  readonly hybrid?: CompanionHybridFacts;
  readonly classifier: CompanionRouteClassifierFacts;
  readonly release: {
    /** 从 handler 开始到投机首步被放行之间等了多久。 */
    readonly waitedMs: number;
  };
  /** 影子 L1 的读数；只有 `COMPANION_RELEASE_ROUTER=shadow` 且本轮输入齐全时才有。 */
  readonly l1?: CompanionReleaseShadowFacts;
}

export interface CompanionRouteClassifierReceipt {
  readonly elapsedMs: number;
  readonly failureClass: string | null;
  readonly hedged?: boolean;
}

export function buildCompanionRouteRecordV1(input: {
  /** 分类器回执；没有发起分类（复用已存解释）时为 null。 */
  readonly classifier: CompanionRouteClassifierReceipt | null;
  readonly releasedAtMs: number;
  readonly handlerStartedAtMs: number;
}): CompanionRouteRecordV1 {
  const classifier = input.classifier === null
    ? { source: "cached" as const, elapsedMs: null, hedged: false }
    : {
      source: input.classifier.failureClass === "timeout" ? "timeout" as const : "l2" as const,
      elapsedMs: Math.max(0, Math.round(input.classifier.elapsedMs)),
      hedged: input.classifier.hedged === true,
    };
  return {
    version: 1,
    classifier,
    release: { waitedMs: Math.max(0, Math.round(input.releasedAtMs - input.handlerStartedAtMs)) },
  };
}

export interface CompanionRouteRecorderOptions {
  readonly entryMode?: "classified" | "direct_fast" | "direct_thinking" | "hybrid";
  /** 账号索引键（`workspaceId:userId`）；影子模式必需。 */
  readonly scopeKey?: string;
  /** 本轮用户原话；影子模式必需。 */
  readonly userText?: string;
  readonly recentMessages?: readonly { readonly role: string; readonly text: string }[];
  /** 影子 L1 的 embedding 出口（治理门后面那一层；失败返回 null 表示弃权）。 */
  readonly embedText?: (text: string) => Promise<readonly number[] | null>;
  /** 缺省按 `COMPANION_RELEASE_ROUTER` 解析；`off` 时完全不碰 embedding。 */
  readonly releaseRouterMode?: CompanionReleaseRouterMode;
  /** 进行中/暂停的学习任务或正式作答 → 状态门直接弃权。 */
  readonly activeLearningTask?: boolean;
}

export interface CompanionRouteRecorder {
  /**
   * 分类器回执：记下来，并按既有格式打一行日志。**不落库**——真正的写发生在
   * `record()`，那时放行时刻已经知道了。
   */
  onReceipt(
    receipt: CompanionRouteClassifierReceipt,
    context: { readonly runId: string; readonly providerId: string; readonly modelId: string },
  ): void;
  /** 给 `attentionPromise` 套一层：它落定 = 放行闸打开的那一刻。 */
  track<T>(promise: Promise<T>): Promise<T>;
  /** 每轮一次：把 route 写进 run meta。不 await、失败只 warn，绝不影响这一轮。 */
  record(event: AgentEventContext, handlerStartedAtMs: number, hybrid?: CompanionHybridFacts): void;
}

export type CompanionRouteMetaWriter = (
  event: AgentEventContext,
  patch: { route: CompanionRouteRecordV1 },
) => Promise<void>;

function releaseShadowFacts(
  verdict: Awaited<ReturnType<typeof evaluateCompanionRelease>>,
  actual: { intent: string; toolUse: string; safe: boolean } | null,
  mode: "shadow" | "enforce",
): CompanionReleaseShadowFacts {
  const agreement = actual === null
    ? "unknown" as const
    : verdict.decision === "release"
      ? (actual.safe ? "aligned" as const : "misrelease" as const)
      : (actual.safe ? "conservative" as const : "aligned" as const);
  return { mode, ...verdict, actual, agreement };
}

export function createCompanionRouteRecorder(
  options: CompanionRouteRecorderOptions = {},
  writeMeta: CompanionRouteMetaWriter = (event, patch) => updateRunMeta(event, patch),
): CompanionRouteRecorder {
  const direct = options.entryMode !== undefined && options.entryMode !== "classified";
  const mode = direct ? "off" : options.releaseRouterMode ?? resolveCompanionReleaseRouterMode();
  const { scopeKey, userText, recentMessages, embedText } = options;
  const shadowEnabled = mode !== "off" && Boolean(scopeKey && userText && embedText);
  let receipt: CompanionRouteClassifierReceipt | null = null;
  let settledAtMs: number | null = null;
  let actual: { intent: string; toolUse: string; safe: boolean } | null = null;
  return {
    onReceipt(next, context) {
      receipt = next;
      logger.info({ runId: context.runId, providerId: context.providerId, modelId: context.modelId, ...next },
        "companion interpretation settled; failure metadata contains no conversation or provider text");
    },
    track(promise) {
      return promise.then((value) => {
        settledAtMs = Date.now();
        const interpretation = value as { intent?: unknown; toolUse?: unknown } | null;
        if (typeof interpretation?.intent === "string" && typeof interpretation.toolUse === "string") {
          actual = {
            intent: interpretation.intent,
            toolUse: interpretation.toolUse,
            safe: (interpretation.intent === "conversation" || interpretation.intent === "question")
              && interpretation.toolUse === "none",
          };
        }
        return value;
      });
    },
    record(event, handlerStartedAtMs, hybrid) {
      const write = (route: CompanionRouteRecordV1): void => {
        void writeMeta(event, { route }).catch((err: unknown) => {
          logger.warn({ runId: event.read.runId, err: err instanceof Error ? err.message : String(err) },
            "companion route record write failed; turn unaffected");
        });
      };
      const base = (): CompanionRouteRecordV1 => ({
        ...buildCompanionRouteRecordV1({
          classifier: receipt, releasedAtMs: settledAtMs ?? Date.now(), handlerStartedAtMs,
        }),
        ...(options.entryMode ? { entryMode: options.entryMode } : {}),
        ...(direct && !(options.entryMode === "hybrid" && receipt) ? { classifier: { source: "direct", elapsedMs: null, hedged: false } } : {}),
        ...(hybrid ? { hybrid } : {}),
      });
      if (!shadowEnabled) { write(base()); return; }
      void (async () => {
        let l1: CompanionReleaseShadowFacts | undefined;
        try {
          const verdict = await evaluateCompanionRelease({
            scopeKey: scopeKey!, text: userText!, recentMessages,
            activeLearningTask: options.activeLearningTask, embed: embedText!,
          });
          l1 = releaseShadowFacts(verdict, actual, mode === "enforce" ? "enforce" : "shadow");
          // 本轮的标签只喂给**后面**的轮次：先算 L1 再入库，否则这条样本会污染自己的判定。
          if (actual) {
            void rememberCompanionReleaseSample({
              scopeKey: scopeKey!, text: userText!, intent: actual.intent, toolUse: actual.toolUse, embed: embedText!,
            }).catch(() => undefined);
          }
        } catch {
          l1 = undefined;
        }
        write(l1 ? { ...base(), l1 } : base());
      })();
    },
  };
}
