/** Account-shared persona routes (当前 / 待生效); relationship metrics remain workspace-local. */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { companionPersonaPatchV1Schema } from "@astella/shared/companion-memory-desktop-contracts";
import { requireSession } from "../identity/middleware.ts";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import { companionPetProfileChangedTotal } from "../../lib/metrics.ts";
import {
  activatePetProfilePendingRevision,
  getDefaultPersonaPreset,
  getPetProfileState,
  getPresetById,
  listPetProfileVersions,
  PET_PERSONA_PRESETS,
  resetPetProfile,
  restorePetProfileVersion,
  stagePetProfileRevision,
  upsertPetProfile,
  PetProfileCasConflictError,
  type PetPersonaPreset,
} from "./pet-profile-service.ts";
import { isPetProfileEnabled } from "../../config/learning-companion-flags.ts";

// REST and desktop IPC share the same complete-document schema so partial writes
// cannot silently clear examples or boundary settings.
const petProfileBodySchema = companionPersonaPatchV1Schema;

/**
 * 「排队 → 生效」这两步的错误映射（40 §4.8.4 / A50）。
 *
 * 两类都是**客户端手上的状态已经不是服务端的状态**：
 *   * CAS 过期 → 别的写入把当前版本推走了；
 *   * 没有排队的那一版 → 界面拿的是一个还没排队的旧状态。
 * 所以都收成 409（与既有 patch/restore/reset 的 CAS 口径一致），而不是 404：
 * 404 在这个文件里是「那一版历史版本不存在」的专有含义。
 */
function casConflict(reply: FastifyReply, currentRevision: number, error: string, message: string) {
  return reply.code(409).send({ error, message, currentRevision });
}

export async function petProfileRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (_req, reply) => {
    if (!isPetProfileEnabled()) {
            return reply.code(404).send({
        error: "companion_pet_profile_disabled",
        message: "桌宠人格档案当前未开放",
      });
    }
  });

  app.get(
    "/companion/pet-profile",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = scopeOfSession(req.session);
      const state = await withWorkspaceTransaction(scope, (tx) => getPetProfileState(tx, scope));
      const profile = state.profile;
      // 「正在生效的是哪套预设」永远有答案：选了哪套就是哪套，没选就是系统默认人格。
      // 此前这里是 null，于是人格页在没有档案时既认不出当前预设，也把表达分量与
      // 边界三颗开关全部 disable 掉——用户看到的是「还没配置」，而不是「默认是谁」。
      const preset: PetPersonaPreset = getPresetById(profile?.presetId) ?? getDefaultPersonaPreset();
      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        profile,
        profileRevision: state.profileRevision,
        relationship: state.relationship,
        presets: PET_PERSONA_PRESETS,
        activePreset: preset,
      });
    },
  );

  app.patch<{ Body: unknown }>(
    "/companion/pet-profile",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = petProfileBodySchema.safeParse(req.body ?? {});
      if (!body.success) throw app.httpErrors.badRequest("pet profile body 非法");
      const scope = scopeOfSession(req.session);
      let profile: Awaited<ReturnType<typeof upsertPetProfile>>;
      try {
        profile = await withWorkspaceTransaction(scope, (tx) => upsertPetProfile(tx, scope, body.data));
      } catch (err) {
        if (err instanceof PetProfileCasConflictError) {
          return reply.code(409).send({
            error: "PROFILE_CAS_CONFLICT",
            message: "人格档案已被修改，请刷新后重试",
            currentRevision: err.currentRevision,
          });
        }
        throw app.httpErrors.internalServerError("pet profile upsert failed");
      }
      // §9.9：记录人格变更指标
      try {
        companionPetProfileChangedTotal.inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      return reply.header("Cache-Control", "no-store").send({ version: 1, profile, profileRevision: profile.revision });
    },
  );

  app.get(
    "/companion/pet-profile/versions",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = scopeOfSession(req.session);
      const result = await withWorkspaceTransaction(scope, async (tx) => ({
        state: await getPetProfileState(tx, scope),
        versions: await listPetProfileVersions(tx, scope),
      }));
      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        currentRevision: result.state.profileRevision,
        versions: result.versions,
      });
    },
  );

  app.post<{ Body: unknown }>(
    "/companion/pet-profile/restore",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = z.object({
        revision: z.number().int().positive(),
        currentRevision: z.number().int().nonnegative(),
      }).strict().safeParse(req.body ?? {});
      if (!body.success) throw app.httpErrors.badRequest("pet profile restore body 非法");
      const scope = scopeOfSession(req.session);
      try {
        const profile = await withWorkspaceTransaction(scope, (tx) => restorePetProfileVersion(tx, scope, {
          revision: body.data.revision,
          expectedRevision: body.data.currentRevision,
        }));
        if (profile === undefined) return reply.code(404).send({ error: "PROFILE_VERSION_NOT_FOUND" });
        return reply.header("Cache-Control", "no-store").send({
          version: 1,
          profile,
          profileRevision: profile?.revision ?? body.data.currentRevision + 1,
        });
      } catch (err) {
        if (err instanceof PetProfileCasConflictError) {
          return reply.code(409).send({
            error: "PROFILE_CAS_CONFLICT",
            message: "人格档案已被修改，请刷新后重试",
            currentRevision: err.currentRevision,
          });
        }
        throw app.httpErrors.internalServerError("pet profile restore failed");
      }
    },
  );

  app.post<{ Body: unknown }>(
    "/companion/pet-profile/reset",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = z.object({ revision: z.number().int().nonnegative() }).strict().safeParse(req.body ?? {});
      if (!body.success) throw app.httpErrors.badRequest("pet profile reset body 非法");
      const scope = scopeOfSession(req.session);
      let profileRevision: number;
      try {
        profileRevision = await withWorkspaceTransaction(scope, (tx) => resetPetProfile(tx, scope, body.data.revision));
      } catch (err) {
        if (err instanceof PetProfileCasConflictError) {
          return reply.code(409).send({
            error: "PROFILE_CAS_CONFLICT",
            message: "人格档案已被修改，请刷新后重试",
            currentRevision: err.currentRevision,
          });
        }
        throw app.httpErrors.internalServerError("pet profile reset failed");
      }
      // §9.9：记录人格变更指标（重置也是一次变更）
      try {
        companionPetProfileChangedTotal.inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      return reply.header("Cache-Control", "no-store").send({ version: 1, ok: true, profileRevision });
    },
  );

  /**
   * 「当前 / 待生效」一起给出去（A50：待生效版本可见）。
   *
   * 刻意**不**把这些字段塞进 `GET /companion/pet-profile` 的响应：那一份被桌面端
   * 用 `companionPersonaV1Schema`（strictObject）逐字段校验，多一个键就是
   * `unsupported_contract`，人格设置页当场打不开。等契约里补上 pending 字段之后，
   * 这里可以并进主响应；在此之前独立成一条，两边都不欠对方。
   */
  app.get(
    "/companion/pet-profile/pending",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = scopeOfSession(req.session);
      const state = await withWorkspaceTransaction(scope, (tx) => getPetProfileState(tx, scope));
      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        currentRevision: state.profileRevision,
        pending: state.pending,
      });
    },
  );

  /**
   * 排队一版修订：写下内容，**不动当前版本**（40 §4.8.4「模型自改在下一次会话建立时
   * 生效」）。调用方是本人，所以作者固定写 user——作者字段不在 body 里，
   * 免得一个客户端自称是模型。
   */
  app.post<{ Body: unknown }>(
    "/companion/pet-profile/stage",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = petProfileBodySchema.safeParse(req.body ?? {});
      if (!body.success) throw app.httpErrors.badRequest("pet profile stage body 非法");
      const scope = scopeOfSession(req.session);
      let staged: Awaited<ReturnType<typeof stagePetProfileRevision>>;
      try {
        staged = await withWorkspaceTransaction(scope, (tx) => stagePetProfileRevision(
          tx,
          scope,
          body.data,
          new Date(),
          { author: "user", reason: "Staged a companion persona revision from account settings." },
        ));
      } catch (err) {
        if (err instanceof PetProfileCasConflictError) {
          return casConflict(reply, err.currentRevision, "PROFILE_CAS_CONFLICT", "人格档案已被修改，请刷新后重试");
        }
        throw app.httpErrors.internalServerError("pet profile stage failed");
      }
      // §9.9：排队也是一次人格变更（只是还没生效），指标照记。
      try {
        companionPetProfileChangedTotal.inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        pendingRevision: staged.pendingRevision,
        profileRevision: staged.profileRevision,
      });
    },
  );

  app.post<{ Body: unknown }>(
    "/companion/pet-profile/activate",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = z.object({ revision: z.number().int().nonnegative() }).strict().safeParse(req.body ?? {});
      if (!body.success) throw app.httpErrors.badRequest("pet profile activate body 非法");
      const scope = scopeOfSession(req.session);
      let activation: Awaited<ReturnType<typeof activatePetProfilePendingRevision>>;
      try {
        activation = await withWorkspaceTransaction(scope, (tx) =>
          activatePetProfilePendingRevision(tx, scope, { expectedRevision: body.data.revision }));
      } catch (err) {
        if (err instanceof PetProfileCasConflictError) {
          return casConflict(reply, err.currentRevision, "PROFILE_CAS_CONFLICT", "人格档案已被修改，请刷新后重试");
        }
        throw app.httpErrors.internalServerError("pet profile activate failed");
      }
      if (!activation) {
        return casConflict(reply, body.data.revision, "PROFILE_NO_PENDING_REVISION", "没有待生效的人格版本");
      }
      try {
        companionPetProfileChangedTotal.inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        ok: true,
        profile: activation.profile,
        profileRevision: activation.revision,
      });
    },
  );
}
