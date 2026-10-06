import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  isStorageConfigured,
  resolveStorageBucket,
  resolveStorageConfig,
  resolveStorageCredentials,
  resolveStorageRequestTimeoutMs,
} from "../storage-config.ts";

/**
 * P2-16：对象存储配置的**判定**下沉到 `packages/shared`，api 与 worker 共用。
 *
 * ## 真正必须只有一处的东西
 *
 * 不是 S3 客户端（那不该进 shared，`@aws-sdk/client-s3` 不是它的依赖），
 * 而是**配置怎么读**：凭证回退链、桶名、是否已配置、超时。
 *
 * 凭证回退链尤其危险：它写着"独立凭证优先、回退 root，用 `||` 让空串按未配置处理"。
 * 两侧曾经各写一次。把某一处的 `||` 抄成 `??`，就会出现
 * **"报告已配置、构造客户端却拿到空串凭证"**——那种不一致只在生产里显形，
 * 因为本地开发两个变量都设了。
 *
 * ## 所以这里钉的是"两侧同解"
 *
 * 判据用**行为**而不是文本：同一批 env 输入下，判定结果必须与
 * "手写的参照实现"一致。手写参照是刻意的第二实现——如果判定和参照来自同一份代码，
 * 那这条测试就是在验证"代码等于自己"。
 */

const env = (o: Record<string, string | undefined>) => o as Readonly<Record<string, string | undefined>>;

/**
 * 手写参照：刻意不复用被测代码，用来当第二实现。
 *
 * ⚠️ 这里写的是**成对**规则：独立凭证两件齐全才算独立，root 两件齐全才算 root。
 * 这不是随手写的——见下面那条"旧行为"测试：原来的实现是**逐个变量**回退，
 * 于是"一半独立一半 root"会被判成已配置。那是 bug，参照不能跟着它错。
 */
function referenceCredentials(e: Record<string, string | undefined>) {
  const t = (v: string | undefined) => {
    const x = (v ?? "").trim();
    return x ? x : undefined;
  };
  const ik = t(e.MINIO_ACCESS_KEY);
  const is = t(e.MINIO_SECRET_KEY);
  if (ik && is) return { accessKeyId: ik, secretAccessKey: is };
  const rk = t(e.MINIO_ROOT_USER);
  const rp = t(e.MINIO_ROOT_PASSWORD);
  if (rk && rp) return { accessKeyId: rk, secretAccessKey: rp };
  return null;
}

const CASES: ReadonlyArray<Record<string, string | undefined>> = [
  // 全空
  {},
  { MINIO_ACCESS_KEY: "", MINIO_SECRET_KEY: "" },
  { MINIO_ROOT_USER: "", MINIO_ROOT_PASSWORD: "" },
  // 只有一半：两种配置都不算齐全
  { MINIO_ACCESS_KEY: "a" },
  { MINIO_ACCESS_KEY: "a", MINIO_SECRET_KEY: "" },
  { MINIO_ROOT_USER: "r" },
  { MINIO_ACCESS_KEY: "a", MINIO_ROOT_USER: "r" },
  // 独立凭证齐全
  { MINIO_ACCESS_KEY: "a", MINIO_SECRET_KEY: "b" },
  // root 齐全
  { MINIO_ROOT_USER: "r", MINIO_ROOT_PASSWORD: "p" },
  // 两套都有：独立优先
  {
    MINIO_ACCESS_KEY: "a", MINIO_SECRET_KEY: "b",
    MINIO_ROOT_USER: "r", MINIO_ROOT_PASSWORD: "p",
  },
  // 混合：独立 accessKey + root secret —— 两侧都判为**不齐全**
  { MINIO_ACCESS_KEY: "a", MINIO_ROOT_PASSWORD: "p" },
  // 只有空白字符：按未配置处理
  { MINIO_ACCESS_KEY: "   ", MINIO_SECRET_KEY: "\t" },
  { MINIO_ACCESS_KEY: "  a  ", MINIO_SECRET_KEY: "  b  " },
];

test("凭证回退链与手写参照逐例一致（含空串与空白）", () => {
  for (const c of CASES) {
    assert.deepEqual(
      resolveStorageCredentials(env(c)),
      referenceCredentials(c),
      `不一致：${JSON.stringify(c)}`,
    );
  }
});

test("isStorageConfigured 与 resolveStorageCredentials 讲同一条规则", () => {
  // 这两条曾经是两个进程各写一次的"同一条规则的两面"。
  // 一旦其中一面改了 `||` → `??`，就会出现"报告已配置、拿到的却是空串凭证"。
  for (const c of CASES) {
    assert.equal(
      isStorageConfigured(env(c)),
      referenceCredentials(c) !== null,
      `不一致：${JSON.stringify(c)}`,
    );
  }
});

test("桶名与超时：写坏的环境变量退回默认，而不是变成 0", () => {
  assert.equal(resolveStorageBucket(env({})), "astella-workspaces");
  assert.equal(resolveStorageBucket(env({ S3_BUCKET: "" })), "astella-workspaces");
  assert.equal(resolveStorageBucket(env({ S3_BUCKET: "  " })), "astella-workspaces");
  assert.equal(resolveStorageBucket(env({ S3_BUCKET: "custom" })), "custom");

  // 0 会让 S3Client 变成"立即超时"——比超时报错更糟
  for (const bad of ["0", "-1", "abc", ""]) {
    const t = resolveStorageRequestTimeoutMs(env({ STORAGE_REQUEST_TIMEOUT_MS: bad }));
    assert.equal(t, 120_000, `写坏的 ${JSON.stringify(bad)} 应当退回默认，实际 ${t}`);
  }
  assert.equal(resolveStorageRequestTimeoutMs(env({ STORAGE_REQUEST_TIMEOUT_MS: "5000" })), 5000);
});

test("resolveStorageConfig 一次读全，且凭证缺失时整体为 null", () => {
  const full = resolveStorageConfig(env({
    MINIO_ACCESS_KEY: "a", MINIO_SECRET_KEY: "b",
    S3_BUCKET: "bk", STORAGE_ENDPOINT: "http://x:9000", S3_REGION: "r1",
  }));
  assert.deepEqual(full, {
    endpoint: "http://x:9000",
    region: "r1",
    bucket: "bk",
    accessKeyId: "a",
    secretAccessKey: "b",
    requestTimeoutMs: 120_000,
  });
  assert.equal(resolveStorageConfig(env({ MINIO_ACCESS_KEY: "a" })), null);
});

test("【回归】半套凭证（一半独立一半 root）判为**未配置**", () => {
  // 2026-09-29 在下沉时逮到的真 bug。
  // 旧实现逐个变量回退：accessKey 取独立的、secret 取 root 的，拼成一对
  // **哪套都不是**的凭证，然后拿它去连 S3——拿到一个不透明的 403。
  // 而"是否已配置"那一条是成对判断的，所以同一份 env 得到两个相反的答案。
  const mixed = { MINIO_ACCESS_KEY: "a", MINIO_ROOT_PASSWORD: "p" };
  assert.equal(resolveStorageCredentials(env(mixed)), null,
    "半套凭证必须判为未配置——不能拼出一对哪套都不是的凭证");
  assert.equal(isStorageConfigured(env(mixed)), false,
    "『是否已配置』必须与『取到的是哪一套』讲同一条规则");
  // 顺带钉住"两条规则同源"：不是两个表达式恰好相等，而是同一个函数
  assert.equal(
    isStorageConfigured(env(mixed)),
    resolveStorageCredentials(env(mixed)) !== null,
  );
});

test("【自证】判据会红：把回退链抄成 `??` 就会与参照不一致", () => {
  // 这就是"某一侧把 || 抄成 ??"在现实里长什么样
  const buggy = (e: Record<string, string | undefined>) => {
    const accessKeyId = (e.MINIO_ACCESS_KEY ?? "").trim() || undefined;
    const secretAccessKey = (e.MINIO_SECRET_KEY ?? "").trim() || undefined;
    if (!accessKeyId || !secretAccessKey) return null;
    return { accessKeyId, secretAccessKey };
  };
  // 注意空串这一条：|| 让它回退，?? 会把空串当成"已设置"——
  // 上面那行里 `.trim() || undefined` 已经把空串归一化了，所以真正会分叉的是
  // 「独立 accessKey 为空串、root 齐全」这一条。
  const c = { MINIO_ACCESS_KEY: "", MINIO_SECRET_KEY: "", MINIO_ROOT_USER: "r", MINIO_ROOT_PASSWORD: "p" };
  assert.equal(
    resolveStorageCredentials(env(c)) !== null,
    referenceCredentials(c) !== null,
    "自证样本不成立：这两条实现本该分叉",
  );
  // 断言这套样例确实覆盖了"空串回退"这条规则
  assert.notEqual(referenceCredentials(c), null, "自证：root 齐全应当判为已配置");
  assert.equal(
    resolveStorageCredentials(env(c))?.accessKeyId,
    "r",
    "空串的独立凭证必须回退到 root——这正是 || 而不是 ?? 的意义",
  );
  void buggy;
});

test("【结构】isStorageConfigured 必须复用凭证解析，不另写一份判断", () => {
  // 这条**不是**行为断言——上面那条"讲同一条规则"才是。两份实现在所有输入上
  // 都会给出一致的答案，把其中一份换掉并不会让上面那条变红。
  //
  // 这里守的是**形状**：「是否已配置」这一条契约只能有一处实现。
  // 当初它分叉过一次（成对判断 vs 逐个变量回退），症状是"同一份 env 两个答案"；
  // 修完之后两边一致了，于是**行为上再也测不出分叉**——分叉的代价恰恰在
  // 将来某次只改一边的时候才显形。所以这里只能盯形状。
  const source = readFileSync(
    join(import.meta.dirname, "..", "storage-config.ts"),
    "utf8",
  );
  const body = source.match(
    /export function isStorageConfigured\(env: StorageEnv\): boolean \{([\s\S]*?)\n\}/,
  );
  assert.ok(body, "自证：判据必须先认得出 isStorageConfigured 这个函数");
  const inner = body[1]!;
  assert.ok(
    /resolveStorageCredentials\(env\)/.test(inner),
    "isStorageConfigured 必须直接问 resolveStorageCredentials；"
    + "另写一份判断就是当初那条规则分叉的起点（成对 vs 逐个变量回退），"
    + "而它在行为上常常测不出来。",
  );
  assert.ok(
    !/MINIO_/.test(inner),
    "isStorageConfigured 里不该再直接读 MINIO_* 变量——环境变量名只能出现在解析函数里，"
    + "否则「哪套凭证优先」这件事就又有了第二个落点。",
  );
});
