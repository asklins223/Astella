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
 */
import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
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

export async function learningDisputeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  const sessionOf = (req: { session: { workspaceId: string; userId: string } }) => ({
    workspaceId: req.session.workspaceId,
    userId: req.session.userId,
  });

  app.post<{ Params: { assessmentId: string }; Body: unknown }>(
    "/learning/assessments/:assessmentId/disputes",
    async (req, reply) => {
      const parsed = openAssessmentDisputeV2Schema.safeParse({ assessmentId: req.params.assessmentId, ...(req.body as object) });
      if (!parsed.success) {
        return reply.code(400).send({ error: "validation", message: "争议请求参数非法" });
      }
      try {
        const result = await withWorkspaceTransaction(sessionOf(req), (tx) => openAssessmentDisputeV2(tx, {
          ...sessionOf(req),
          assessmentId: parsed.data.assessmentId,
          kind: parsed.data.kind,
          statement: parsed.data.statement,
          at: new Date(),
        }));
        return reply.header("Cache-Control", "private, no-store")
          .code(result.created ? 201 : 200)
          .send({ version: 2 as const, disputeId: result.dispute.id, status: result.dispute.status });
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
