import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db, withActorTransaction } from "./client.ts";
import { users, workspaces, workspaceMembers } from "@astella/shared/db-schema/identity";

const DEMO_OWNER_EMAIL = "owner@astella.local";
const DEMO_OWNER_PASSWORD = "astella_owner";
const DEMO_WORKSPACE_NAME = "Personal Beta";

function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

function required(name: "OWNER_EMAIL" | "OWNER_PASSWORD"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Production seeding never uses a default owner account.`,
    );
  }
  return value;
}

function resolveSeedConfig() {
  const isProduction = process.env.NODE_ENV === "production";
  const demoSeed = process.env.SEED_DEMO_DATA === "true";

  if (isProduction && demoSeed) {
    throw new Error(
      "SEED_DEMO_DATA is disabled in production. Set OWNER_EMAIL and OWNER_PASSWORD explicitly.",
    );
  }
  if (isProduction && !process.env.DATABASE_URL_API?.trim()) {
    throw new Error("DATABASE_URL_API is required for production seeding.");
  }

  const ownerEmail = demoSeed
    ? process.env.OWNER_EMAIL?.trim() || DEMO_OWNER_EMAIL
    : required("OWNER_EMAIL");
  const ownerPassword = demoSeed
    ? process.env.OWNER_PASSWORD || DEMO_OWNER_PASSWORD
    : required("OWNER_PASSWORD");
  const workspaceName =
    process.env.OWNER_WORKSPACE?.trim() ||
    (demoSeed ? DEMO_WORKSPACE_NAME : "Personal Workspace");
  // PROFILE-01: 支持 displayName 和 avatarUrl 环境变量
  const displayName = process.env.OWNER_DISPLAY_NAME?.trim() || null;
  const avatarUrl = process.env.OWNER_AVATAR_URL?.trim() || null;

  if (!ownerEmail.includes("@")) {
    throw new Error("OWNER_EMAIL must be a valid email address.");
  }
  if (ownerPassword.length < 12) {
    throw new Error("OWNER_PASSWORD must contain at least 12 characters.");
  }

  return { demoSeed, ownerEmail, ownerPassword, workspaceName, displayName, avatarUrl };
}

async function main() {
  console.log("Seeding…");

  const { demoSeed, ownerEmail, ownerPassword, workspaceName, displayName, avatarUrl } = resolveSeedConfig();

  // 存在性检查不能走裸 `db.query.users`：api 连接角色是 NOBYPASSRLS 的，
  // 没有 `app.user_id` 上下文时它**看不见任何别人的行**，这个检查会永远返回空，
  // 于是第二次 seed 会拿唯一索引去撞。`astella_find_user_by_email` 是注册/邀请
  // 那条路本来就用的 SECURITY DEFINER 查找。
  const found = await db.execute<{ id: string }>(
    sql`select id from astella_find_user_by_email(${ownerEmail})`,
  );
  if (found.length > 0) {
    console.log(`Owner already exists: ${ownerEmail}`);
    return;
  }

  const ownerId = randomUUID();
  // 写入包在 actor 事务里：`sec02_users_self_insert` 只放行
  // `app.user_id` 等于新行 id 的插入，而 actor 上下文允许"还没有空间"
  // ——那正是 workspaces / workspace_members 守卫让开的分支（迁移 0257）。
  await withActorTransaction({ userId: ownerId, workspaceId: null }, async (tx) => {
    const [owner] = await tx
      .insert(users)
      .values({
        id: ownerId,
        email: ownerEmail,
        passwordHash: hashPassword(ownerPassword),
        role: "owner",
        ...(displayName ? { displayName } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      })
      .returning();

    const [ws] = await tx
      .insert(workspaces)
      .values({
        ownerId: owner.id,
        name: workspaceName,
        workspaceType: "personal",
      })
      .returning();

    await tx.insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: owner.id,
      role: "owner",
    });

    // PROFILE-01: 设置用户的 personal_workspace_id
    await tx
      .update(users)
      .set({ personalWorkspaceId: ws.id })
      .where(eq(users.id, owner.id));

    console.log(`Seeded ${demoSeed ? "demo " : ""}owner: ${ownerEmail}`);
    console.log(`Workspace: ${workspaceName} (${ws.id})`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
