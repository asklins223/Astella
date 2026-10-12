import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Session 表：持久化登录态，替代内存 Map。
 * - token 作为主键，查询 O(1)。
 * - expiresAt 用于过期清理；decodeToken 时一并校验。
 * - V0 单实例足够；未来多实例天然共享（Postgres）。
 * - clientKind（0413）记下这枚凭据签发给了哪一种客户端。正文写入的闸门读**会话行**
 *   而不是请求头：能改请求头的人也能把它抹掉，那就不是 enforcement。
 */
export const sessions = pgTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    userId: uuid("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    clientKind: text("client_kind").default("desktop").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    // 2026-08-12（schema 完整性审计）：0001:9 sessions_user_idx 此前未声明
    userIdx: index("sessions_user_idx").on(t.userId),

    workspaceUserIdx: index("sessions_workspace_user_idx").on(t.workspaceId, t.userId),
    // 2026-08-12（generate 对齐）：0159 定义单列 (expires_at) 索引，支撑过期清理
    // （astella_purge_expired_sessions / 会话扫描），避免全表扫。
    expiresAtIdx: index("sessions_expires_at_idx").on(t.expiresAt),
    // 0413：取值域只有这两种，写进库里就是一道约束而不是一个约定。
    clientKindCheck: check("sessions_client_kind_check", sql`${t.clientKind} IN ('desktop', 'mobile')`),
  }),
);
