import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * compose 的 init 顺序契约：**授权必须重跑在迁移之后。**
 *
 * `roles.sql` 里有一批"对象存在才修"的块（drizzle journal 的 SELECT、几个
 * SECURITY DEFINER 函数的 EXECUTE），而 role bootstrap 又**必须**跑在 migrate
 * 之前——迁移自己就要 `GRANT EXECUTE TO astella_worker`。两头夹住的结果是：
 * 全新卷上第一次起来时，api 对业务表一条 SELECT 都没有，`/ready` 报
 * "business schema is incomplete" 并一直 unhealthy，只有再 `make up` 一次
 * （init 容器被删掉重跑）才碰巧补上。dev 栈就长期停在这个形状上。
 *
 * 生产 compose 早就用 `role-grants` 这个一次性服务把后半程接上了；2026-10-06
 * 给 dev 补上同一个服务。这份守卫盯的就是"别再退回一半"：
 *
 *   1. 两份 compose 都得有一个跑 `apply-roles.sh` 且排在 migrate 之后的服务；
 *   2. 直连数据库的运行时服务必须门控在它上面，**不许**直接门控 migrate；
 *   3. dev 的 `make up` 必须等它跑完（否则 `docker wait` 那一段会漏掉它）。
 *
 * 用文本解析而不是引 YAML 依赖：这里只关心"谁在谁之后"，不值得为此多一个包。
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (path) => readFileSync(join(repositoryRoot, path), "utf8");

/** 运行时直连数据库、因此需要迁移后授权的服务。 */
const DATABASE_CONSUMERS = ["api", "worker"];

/** 把 `services:` 下的顶层服务块切成 `{ name: body }`（两空格缩进是服务名）。 */
function parseServices(compose) {
  const body = compose.slice(compose.indexOf("\nservices:"));
  const blocks = {};
  let current = null;
  for (const line of body.split("\n")) {
    const name = /^ {2}([a-z0-9][a-z0-9_-]*):\s*(?:#.*)?$/.exec(line);
    if (name) {
      current = name[1];
      blocks[current] = "";
      continue;
    }
    if (current && !/^\S/.test(line)) blocks[current] += `${line}\n`;
  }
  return blocks;
}

/** 一个块里 `depends_on:` 列出的服务名。 */
function dependsOn(block) {
  const match = /\n {4}depends_on:\n((?: {6}\S+\n(?: {8}\S+.*\n)*)+)/.exec(block);
  if (!match) return [];
  return [...match[1].matchAll(/^ {6}([a-z0-9][a-z0-9_-]*):/gm)].map((m) => m[1]);
}

function findGrantStep(blocks) {
  return Object.entries(blocks)
    .filter(([, block]) => block.includes("apply-roles.sh") && dependsOn(block).includes("migrate"))
    .map(([name]) => name);
}

describe("compose init 顺序契约", () => {
  for (const file of ["docker-compose.yml", "docker-compose.dev.yml"]) {
    describe(file, () => {
      const blocks = parseServices(read(file));

      it("解析到了服务清单（守卫本身别静默失效）", () => {
        assert.ok(Object.keys(blocks).length > 3, `${file} 没解析出服务块`);
        assert.ok(blocks.migrate, `${file} 缺少 migrate 服务`);
      });

      it("migrate 之前有 role bootstrap（迁移要 GRANT EXECUTE 给 worker）", () => {
        assert.deepEqual(dependsOn(blocks.migrate).filter((s) => s.includes("role")), ["role-bootstrap"]);
      });

      it("迁移之后重跑一次授权", () => {
        assert.deepEqual(findGrantStep(blocks), ["role-grants"],
          "必须恰好有一个跑 apply-roles.sh 且排在 migrate 之后的一次性服务");
      });

      for (const consumer of DATABASE_CONSUMERS) {
        it(`${consumer} 门控在 role-grants 上，而不是 migrate`, () => {
          assert.ok(blocks[consumer], `${file} 缺少 ${consumer} 服务`);
          const deps = dependsOn(blocks[consumer]);
          assert.ok(deps.includes("role-grants"),
            `${consumer} 只等 migrate 的话，全新卷上它拿不到迁移建出来的表的授权`);
          assert.ok(!deps.includes("migrate"),
            `${consumer} 不该再直接依赖 migrate——role-grants 已经排在它后面`);
        });
      }
    });
  }

  it("dev 的 make up 会等 role-grants 跑完", () => {
    const makefile = read("Makefile");
    const initServices = /^INIT_SERVICES\s*:?=(.*)$/m.exec(makefile)?.[1] ?? "";
    assert.match(initServices, /\brole-bootstrap\b/);
    assert.match(initServices, /\bmigrate\b/);
    assert.match(initServices, /\brole-grants\b/,
      "漏了它，`make up` 的 docker wait 循环就不会等授权重跑，api 可能先起");
  });
});
