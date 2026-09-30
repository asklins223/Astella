/**
 * 争议与更正的 HTTP 面（39d W5-5；39 §14.2、§16.11、§16.25）。
 *
 * 四个动作，形状与 §14.2 那段话一一对应：
 *   POST …/disputes            开一份争议（"我不同意这次判定"）
 *   POST …/disputes/supplement 补充说明（§14.2 明写允许，且**不重开**已落库的复核）
 *   POST …/disputes/recheck    落**一次**重新检查的结论（§16.22 的服务端入口）
 *   POST …/disputes/correction 写一条只追加的更正（§16.25 两档）
 *   POST …/disputes/close      结束争议；本人要的话顺带把该项暂不安排（§14.2）
 *   GET  …/disputes            读回这一份争议与它的更正（界面要能念出理由）
 *
 * 状态码不是随手挑的：每一条冲突都有 §14.2 的原话可对。
 *  - 404 `assessment_not_found`：§14.4 争议是个人数据，读别人的那一判定只能 404，
 *    不能用 403 告诉她"这个 id 确实存在"（那本身也是一次泄露）。
 *  - 409 `assessment_already_disputed` / `recheck_already_performed` / `correction_already_recorded`：
 *    §16.22「不能反复要求用户接受同一判定」。这三样重放一律 409，**不是** no-op——
 *    no-op 会让调用方以为还能再试一轮。
 *  - 422 `supplement_artifact_required`：§16.25「用户补答」必须指得出补充后的表现
 *    是哪一次作答。这是请求形状不合法，不是服务端故障。
 *
 * **系统那一半（2026-09-27，W5-5 第五刀）**：§14.2「用户提出争议后……**系统**基于
 * 原题、原回答和依据进行一次重新检查」的那一步，就挂在**开争议**这一发上——
 * 争议一落库就跑，跑的是 `dispute-recheck.ts` 那个内核任务（事务外一次真实模型调用）。
 * 刻意**不给它单独的端点**：挂成一颗能被按的按钮，§16.22「争议不形成死循环」立刻变成
 * 一个可重复的动作（`recheck` 那一档的写入方是系统，不是人）。
 *
 * ## 回执为什么拆成两步（2026-09-27 用户裁定）
 *
 * 这一发**等**那一次复核跑完（真模型实测 2.8–3.0 秒），而响应里现在有两格：
 *  - `recordedLine` ＝ **当时的结算**：「我按的那一下生效了吗」——按下去就成立；
 *  - `recheck` ＝ **后续确认**：「系统怎么看」——它带自己的 `decidedAt`。
 *
 * 不做成后台 job + 立即回执：那样屏上那颗按钮就变成一个**能被按的重复动作**，
 * §16.22 的死循环立刻有了新入口。保留等待，只把**回执的形状**拆开。
 *
 * 复核结论与理由**仍然**由 `GET …/disputes` 交回（界面那张便签在念它，
 * `assessmentDisputeSurfaceCopyV2`）——这一发多带的那一格是给"刚才那一下"的即时回执，
 * 不是替代读侧，两边同源（同一份 `disputeReceiptLinesV2`）。
 *
 * 复核失败也**不**把开争议判成失败：争议已经落库，用户随时能补充说明或结束并
 * 暂不安排（§14.2 的出口）；报成 500 只会让用户以为"没记下来"，那正是 §13.4 要防的假失败。
 */
import type { FastifyInstance } from "fastify";
import {
  disputeReceiptLinesV2,
  type OpenAssessmentDisputeRecheckReceiptV2,
} from "@ailearn/shared/assessment-dispute-rules-v2";
import type { DisputeRecheckResultV2 } from "./dispute-recheck.ts";
import { requireSession } from "../../identity/middleware.ts";
import { currentApiWorkspaceTransaction, scopeOfSession, withWorkspaceTransaction } from "../../../db/client.ts";
import { logger } from "../../../lib/logger.ts";
import {
  closeAssessmentDisputeV2,
  completeDisputeRecheckV2,
  getAssessmentDisputeViewV2,
  markCorrectionAppliedV2,
  openAssessmentDisputeV2,
  recordAssessmentCorrectionV2,
  submitDisputeSupplementV2,
  AssessmentDisputeAlreadyOpenV2,
  AssessmentDisputeClosedV2,
  AssessmentDisputeNotFoundV2,
  AssessmentDisputeRecheckExhaustedV2,
  AssessmentCorrectionAlreadyRecordedV2,
  AssessmentCorrectionShapeV2,
} from "./run-disputes.ts";
import { readDisputeRecheckAnchorV2, runDisputeRecheckV2 } from "./dispute-recheck.ts";
import {
  closeAssessmentDisputeV2Schema,
  completeDisputeRecheckV2Schema,
  openAssessmentDisputeV2Schema,
  recordAssessmentCorrectionV2Schema,
  submitDisputeSupplementV2Schema,
} from "@ailearn/shared/assessment-dispute-rules-v2";

/** 领域错误 → HTTP。抽出来是因为下面五个入口共用同一张表。 */
function disputeErrorStatus(error: unknown): { status: number; code: string; message: string } | null {
  if (error instanceof AssessmentDisputeNotFoundV2) {
    return { status: 404, code: "not_found", message: "这次判定不存在或不属于你" };
  }
  if (error instanceof AssessmentDisputeAlreadyOpenV2) {
    return { status: 409, code: "already_disputed", message: "这次判定已经有一份争议了" };
  }
  if (error instanceof AssessmentDisputeRecheckExhaustedV2) {
    return { status: 409, code: "recheck_already_performed", message: "这次判定已经复核过一次了" };
  }
  if (error instanceof AssessmentCorrectionAlreadyRecordedV2) {
    return { status: 409, code: "correction_already_recorded", message: "这次更正已经写过了" };
  }
  if (error instanceof AssessmentDisputeClosedV2) {
    return { status: 409, code: "dispute_closed", message: "这份争议已经结束了" };
  }
  if (error instanceof AssessmentCorrectionShapeV2) {
    return { status: 422, code: "invalid", message: "补答这一档要指明补充后的那次作答" };
  }
  return null;
}

/**
 * `runDisputeRecheckV2` 的三档结果 → 回执里那一格「后续确认」。
 *
 * **三档都保留**：跳过与失败不是同一句话（跳过＝这件事在当前条件下做不了，
 * 例如没配 provider；失败＝配了但这次没成）。而"没跑成"**不是**"没有结论"——
 * `outcome` 在那两档是 `null` 而不是 `undetermined`，因为 `undetermined` 是一个
 * **真结论**（复核跑了，但两说并存）；把"没跑"说成它就是 §14.2 最反对的那种含糊。
 */
function recheckToReceiptV2(
  recheck: DisputeRecheckResultV2 | null,
): OpenAssessmentDisputeRecheckReceiptV2 {
  const decidedAt = new Date().toISOString();
  if (!recheck) {
    return { stage: "supplementary", status: "skipped", decidedAt, outcome: null, reason: null, reasonCode: "recheck_not_allowed" };
  }
  if (recheck.status === "committed") {
    return {
      stage: "supplementary",
      status: "committed",
      decidedAt,
      outcome: recheck.outcome,
      reason: recheck.reason,
      reasonCode: null,
    };
  }
  return { stage: "supplementary", status: recheck.status, decidedAt, outcome: null, reason: null, reasonCode: recheck.reasonCode };
}

export async function learningDisputeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  const sessionOf = (req: { session: { workspaceId: string; userId: string } }) => (scopeOfSession(req.session));

  app.post<{ Params: { assessmentId: string }; Body: unknown }>(
    "/learning/assessments/:assessmentId/disputes",
    async (req, reply) => {
      const parsed = openAssessmentDisputeV2Schema.safeParse({ assessmentId: req.params.assessmentId, ...(req.body as object) });
      if (!parsed.success) {
        return reply.code(400).send({ error: "validation", message: "争议请求参数非法" });
      }
      try {
        // 争议落库与"读出这一次复核的锚"在**同一段短事务**里：锚就是争议行上冻结的
        // `artifact_id`／`artifact_payload_hash`（§14.2「关联原产物和版本」），
        // 正好是内核任务上下文 `inputSnapshotRef` 那一格要的东西。
        const opened = await withWorkspaceTransaction(sessionOf(req), async (tx) => {
          const result = await openAssessmentDisputeV2(tx, {
            ...sessionOf(req),
            assessmentId: parsed.data.assessmentId,
            kind: parsed.data.kind,
            statement: parsed.data.statement,
            at: new Date(),
          });
          const anchor = await readDisputeRecheckAnchorV2(tx, {
            ...sessionOf(req),
            assessmentId: parsed.data.assessmentId,
          });
          return { result, anchor };
        });
        // ── 事务已释放（连接已归还）。下面这一段是**事务外**的 ──────────────
        // §14.2 的那一次重新检查在这里真的发生：一次独立的模型调用，产出
        // 维持／修正／仍无法判断之一，理由由上面那个 GET 念给用户。
        let recheck: DisputeRecheckResultV2 | null = null;
        if (opened.anchor?.allowed) {
          recheck = await runDisputeRecheckV2(
            { currentActiveTransaction: currentApiWorkspaceTransaction },
            {
              ...sessionOf(req),
              assessmentId: parsed.data.assessmentId,
              artifactId: opened.anchor.artifactId,
              artifactPayloadHash: opened.anchor.artifactPayloadHash,
            },
          );
          if (recheck.status !== "committed") {
            // 如实留一条痕。**不**改回执：用户要读的是"这份异议记下了没有"，
            // 复核没跑成是另一件事（屏上会说"复核还没做"），把它混进同一个状态码
            // 就会让用户以为异议没记下来。
            logger.warn(
              {
                scope: "assessment-dispute-recheck",
                assessmentId: parsed.data.assessmentId,
                status: recheck.status,
                reasonCode: recheck.reasonCode,
                detail: recheck.detail,
              },
              "争议的这一次重新检查没有落库（§14.2 的出口仍是用户自己结束争议）",
            );
          }
        }
        // ── 第二步的形状（§10.3：区分「当时的结算」与「后续确认」）────────
        // 这一发**等**复核跑完（真模型实测 2.8–3.0 秒），所以两步都在这一个响应里，
        // 但它们是**两句话**：先回答"我按的那一下生效了吗"，再回答"系统怎么看"。
        // 不做成后台 job 是有理由的：挂成能按的按钮，§16.22 的死循环就有了一个新入口。
        const receipt = recheckToReceiptV2(recheck);
        const lines = disputeReceiptLinesV2({ created: opened.result.created, recheck: receipt });
        return reply.header("Cache-Control", "private, no-store")
          .code(opened.result.created ? 201 : 200)
          .send({
            version: 2 as const,
            disputeId: opened.result.dispute.id,
            status: opened.result.dispute.status,
            created: opened.result.created,
            recordedLine: lines.first,
            recheck: receipt,
          });
      } catch (error) {
        const mapped = disputeErrorStatus(error);
        if (mapped) return reply.code(mapped.status).send({ error: mapped.code, message: mapped.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { assessmentId: string }; Body: unknown }>(
    "/learning/assessments/:assessmentId/disputes/supplement",
    async (req, reply) => {
      const parsed = submitDisputeSupplementV2Schema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "validation", message: "补充说明参数非法" });
      }
      try {
        const result = await withWorkspaceTransaction(sessionOf(req), (tx) => submitDisputeSupplementV2(tx, {
          ...sessionOf(req),
          assessmentId: req.params.assessmentId,
          supplement: parsed.data.supplement,
          at: new Date(),
        }));
        return reply.header("Cache-Control", "private, no-store")
          .send({ version: 2 as const, disputeId: result.dispute.id, accepted: true });
      } catch (error) {
        const mapped = disputeErrorStatus(error);
        if (mapped) return reply.code(mapped.status).send({ error: mapped.code, message: mapped.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { assessmentId: string }; Body: unknown }>(
    "/learning/assessments/:assessmentId/disputes/recheck",
    async (req, reply) => {
      const parsed = completeDisputeRecheckV2Schema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "validation", message: "复核结论参数非法" });
      }
      try {
        const result = await withWorkspaceTransaction(sessionOf(req), (tx) => completeDisputeRecheckV2(tx, {
          ...sessionOf(req),
          assessmentId: req.params.assessmentId,
          outcome: parsed.data.outcome,
          reason: parsed.data.reason,
          reportHash: parsed.data.reportHash,
          at: new Date(),
        }));
        return reply.header("Cache-Control", "private, no-store").send({
          version: 2 as const,
          disputeId: result.dispute.id,
          status: result.dispute.status,
          outcome: result.outcome,
        });
      } catch (error) {
        const mapped = disputeErrorStatus(error);
        if (mapped) return reply.code(mapped.status).send({ error: mapped.code, message: mapped.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { assessmentId: string }; Body: unknown }>(
    "/learning/assessments/:assessmentId/disputes/correction",
    async (req, reply) => {
      const parsed = recordAssessmentCorrectionV2Schema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "validation", message: "更正记录参数非法" });
      }
      try {
        const result = await withWorkspaceTransaction(sessionOf(req), (tx) => recordAssessmentCorrectionV2(tx, {
          ...sessionOf(req),
          assessmentId: req.params.assessmentId,
          kind: parsed.data.kind,
          reason: parsed.data.reason,
          supplementArtifactId: parsed.data.supplementArtifactId ?? null,
          correctedRubricResults: parsed.data.correctedRubricResults,
          at: new Date(),
        }));
        return reply.header("Cache-Control", "private, no-store")
          .code(result.created ? 201 : 200)
          .send({ version: 2 as const, correctionId: result.correction.id, kind: result.correction.kind });
      } catch (error) {
        const mapped = disputeErrorStatus(error);
        if (mapped) return reply.code(mapped.status).send({ error: mapped.code, message: mapped.message });
        throw error;
      }
    },
  );

  /**
   * 把更正标记为已应用，并交回**该由谁去重算日程**。
   *
   * §9.6："需要重新计算时仍经唯一调度服务，基于全部适用事实和当前授权给出一次明确
   * 回执。没有调度变化也应说明原因。" 所以这一发**不插排期**——它只交回
   * `scheduleImpactHint`，由结算那侧拿全部事实去走 `review-schedule-boundary.ts`。
   */
  app.post<{ Params: { assessmentId: string } }>(
    "/learning/assessments/:assessmentId/disputes/correction/apply",
    async (req, reply) => {
      try {
        const result = await withWorkspaceTransaction(sessionOf(req), (tx) => markCorrectionAppliedV2(tx, {
          ...sessionOf(req),
          assessmentId: req.params.assessmentId,
          at: new Date(),
        }));
        return reply.header("Cache-Control", "private, no-store").send({ version: 2 as const, ...result });
      } catch (error) {
        const mapped = disputeErrorStatus(error);
        if (mapped) return reply.code(mapped.status).send({ error: mapped.code, message: mapped.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { assessmentId: string }; Body: unknown }>(
    "/learning/assessments/:assessmentId/disputes/close",
    async (req, reply) => {
      const parsed = closeAssessmentDisputeV2Schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "validation", message: "结束争议参数非法" });
      }
      try {
        const result = await withWorkspaceTransaction(sessionOf(req), (tx) => closeAssessmentDisputeV2(tx, {
          ...sessionOf(req),
          assessmentId: req.params.assessmentId,
          holdObjective: parsed.data.holdObjective,
          note: parsed.data.note,
          at: new Date(),
        }));
        return reply.header("Cache-Control", "private, no-store").send({
          version: 2 as const,
          disputeId: result.dispute.id,
          status: result.dispute.status,
          outcome: result.outcome,
          // "点下去要看得见的后果"：撤下了几条此刻排着的待办要报给界面，
          // 否则那颗"暂不安排"按钮看起来像什么也没做。
          dismissedPendingSchedules: result.dismissedPendingSchedules,
        });
      } catch (error) {
        const mapped = disputeErrorStatus(error);
        if (mapped) return reply.code(mapped.status).send({ error: mapped.code, message: mapped.message });
        throw error;
      }
    },
  );

  app.get<{ Params: { assessmentId: string } }>(
    "/learning/assessments/:assessmentId/disputes",
    async (req, reply) => {
      const view = await withWorkspaceTransaction(sessionOf(req), (tx) => getAssessmentDisputeViewV2(tx, {
        ...sessionOf(req),
        assessmentId: req.params.assessmentId,
      }));
      // 没有争议是正常状态而不是错误：界面要先问一句"有没有得吵"才决定显不显示入口。
      if (!view) return reply.header("Cache-Control", "private, no-store").send({ version: 2 as const, dispute: null });
      return reply.header("Cache-Control", "private, no-store").send({ version: 2 as const, dispute: view });
    },
  );
}
