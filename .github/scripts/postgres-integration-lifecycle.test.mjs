import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const integrationRoots = [
  "apps/api/src/integration-tests",
  "workers/ai-worker/src/integration-tests",
];

describe("PostgreSQL integration test lifecycle", () => {
  it("closes every locally-created postgres client", () => {
    for (const integrationRoot of integrationRoots) {
      const directory = join(repositoryRoot, integrationRoot);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;

        const path = join(directory, entry.name);
        const source = readFileSync(path, "utf8");
        const clientDeclarations = [
          ...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*postgres\s*\(/g),
        ];

        for (const declaration of clientDeclarations) {
          const clientName = declaration[1];
          assert.match(
            source,
            new RegExp(`\\b${clientName}\\.end\\s*\\(`),
            `${relative(repositoryRoot, path)} creates ${clientName} without closing it`,
          );
        }
      }
    }
  });

  it("uses postgres.js JSON parameters instead of storing JSON strings", () => {
    for (const integrationRoot of integrationRoots) {
      const directory = join(repositoryRoot, integrationRoot);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;

        const path = join(directory, entry.name);
        const source = readFileSync(path, "utf8");
        const lines = source.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes("${JSON.stringify(")) continue;
          // `::jsonb` casts are explicit JSON storage and are safe.
          if (line.includes("::jsonb")) continue;
          // `${...}` 里是 **JS 表达式，不是 SQL**。挖掉插值再找 SQL 关键字——
          //
          // 2026-10-05 实测的误报：下面这行是一个纯 throw，被判成了 INSERT
          //   throw new Error(`presence 没写成 ${values.presence}：${JSON.stringify(back[0].presence)}`);
          // 原因是 `\bVALUES\b` 带 `/i`，而 `${values.presence}` 里 `values` 前面是 `{`、
          // 后面是 `.`，两侧都构成词边界 ⇒ 一个普通变量名被当成了 SQL 的 VALUES 子句。
          //
          // 真正该命中的形状不受影响：`VALUES (..., ${JSON.stringify(x)})` 里
          // VALUES 在插值**之外**，挖掉插值后照样能匹配上。
          const sqlSide = line.replace(/\$\{[^}]*\}/g, " ");
          if (!/\b(INSERT|UPDATE|VALUES|SELECT|DELETE)\b/i.test(sqlSide)) continue;
          assert.fail(
            `${relative(repositoryRoot, path)}:${i + 1} inserts serialized JSON instead of a JSON value`,
          );
        }
      }
    }
  });
});
