/**
 * 桌面测试必须解析到 `packages/shared` 的**实时源码**（doc 34 L41）。
 *
 * 为什么钉在配置文件上而不是钉在结果上：pnpm 对 `file:` 依赖是**安装期快照**——
 * 没编辑过的文件是硬链接（内容跟着源码走），编辑过的文件在 `node_modules` 里
 * 留下的是编辑**之前**的那一份。于是"改了合同，桌面测试还是绿的"，而且
 * `npm run typecheck`（tsconfig paths → 源码）和 `npm test`（node_modules → 快照）
 * 读的不是同一份代码，两边可以各自全绿。
 * 2026-09-23 的真实代价：一个新导出的函数在快照里是 `undefined`，调用即抛，
 * 被点击处理器的 `void` 吞掉，测试只报"某个 spy 调用 0 次"——排了三轮才找到根。
 *
 * 修法已经落地（`shared-alias.ts` 一份，构建与测试共用），这条门禁保证它不会被
 * 谁在改配置时悄悄摘掉：摘掉的那一秒它就是红的，而不是等到某次"看不见的红"。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

import { sharedAlias } from "../../../shared-alias.ts";

// 这个文件在 src/main/ 下，包根要往上两层（少一层就会去读 src/vitest.config.ts 然后 ENOENT）。
  // 2026-09-30：本文件移进 `src/main/__tests__/` 之后，**这条路径要再上一层**。
  // `__dirname` / `import.meta.dirname` 是「这个文件自己在哪儿」，它跟着文件一起下沉，
  // 而被读的东西都留在上面——这类「按路径读文件」的写法打包器不会替你改。
const here = resolve(import.meta.dirname, "..", "..", "..");
const vitestConfig = readFileSync(resolve(here, "vitest.config.ts"), "utf8");
const aliasSource = readFileSync(resolve(here, "shared-alias.ts"), "utf8");
const electronConfig = readFileSync(resolve(here, "electron.vite.config.ts"), "utf8");

/** 把别名数组取成可断言的形状（find 是 RegExp，转成它的字面量形式）。 */
// RegExp 变成可断言的形状：去掉首尾斜杠与转义反斜杠，拿到**模式本体**。
// （`String(/x/)` 给的是 `/x/` 而不是 `x` —— 拿它去比子路径会永远不匹配。）
const sharedAliasEntries = (): { find: string; replacement: string }[] =>
  sharedAlias.map((a) => ({
    find: a.find.source.replace(/^\^@astella\/shared\/?/, "").replace(/\$$/, "").replace(/\\\//g, "/"),
    replacement: a.replacement,
  }));
// 判据不复算路径前缀——那等于把「路径怎么算出来的」又抄一遍，
// 而抄错的那一份会让判据在别名完全正确时红。改成看**每一项**是不是
// 真实存在、且位于 packages/shared/src 之下。


describe("桌面测试与构建解析同一份 @astella/shared", () => {
  it("main/preload 和 renderer 的类型检查也解析到实时合同，不能退回安装期快照", () => {
    for (const [configName, entry] of [
      ["tsconfig.node.json", "src/main/desktop-ipc.ts"],
      ["tsconfig.web.json", "src/renderer/src/app/clipboard.ts"],
    ]) {
      const configPath = resolve(here, configName);
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      expect(config.error).toBeUndefined();
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, here);
      for (const contract of ["desktop-ipc-contracts", "companion-conversation-contracts", "companion-memory-desktop-contracts"]) {
        const resolved = ts.resolveModuleName(`@astella/shared/${contract}`, resolve(here, entry), parsed.options, ts.sys);
        expect(resolved.resolvedModule?.resolvedFileName).toBe(resolve(here, `../../packages/shared/src/contracts/${contract}.ts`));
      }
    }
  });

  it("两个配置用的是同一份别名定义（不是各自复制一遍）", () => {
    expect(vitestConfig).toContain("from './shared-alias.ts'");
    expect(electronConfig).toContain("from './shared-alias.ts'");
    // 定义只该有一份：谁再在配置里内联写第二个 alias，就又是两个来源。
    expect(electronConfig).not.toMatch(/const sharedAlias = \[/);
  });

  it("别名确实指向 packages/shared/src，且覆盖 barrel 与子路径两种导入", () => {
    // 2026-09-30：判据从「源码文本里含某个字面量」改成**真的把别名数组取出来看**。
    //
    // 旧写法读 `shared-alias.ts` 的文本，断言里面有 "packages/shared/src" 与两条 find。
    // 别名改成**按 exports 逐条生成**之后，那两个字面量与通配 find 都不该再出现——
    // 于是旧判据红了，而它红的理由与它要抓的东西（别名指没指活源码）毫无关系。
    //
    // 判据的对象是「别名指向 packages/shared/src 且覆盖两种导入」，
    // 不是「某个文件里写着某几个字」。所以这里直接 import 那个数组。
    const aliases = sharedAliasEntries();
    // barrel 与子路径各至少一条
    // barrel：`@astella/shared` 本身；子路径：`@astella/shared/<name>`
    expect(sharedAlias.some((a) => a.find.test("@astella/shared"))).toBe(true);
    expect(sharedAlias.some((a) => a.find.test("@astella/shared/learning-run-v2-contracts"))).toBe(true);
    // 通配那条已被逐条精确匹配取代：带 '/' 的子路径（./db-schema/note）在通配下会拼错
    expect(sharedAlias.every((a) => !a.find.source.includes("(.*)"))).toBe(true);
    // 全部落在 packages/shared/src 之下，且**文件真实存在**
    // （shared-alias.ts 加载时也会查一遍；这里是第二道，防止那个守卫被摘掉）
    for (const a of aliases) {
      expect(a.replacement).toContain("packages/shared/src");
      expect(existsSync(a.replacement)).toBe(true);
    }
  });

  it("vitest 的 alias 数组里两条都在（prosemirror 那条是另一件事，别顺手删）", () => {
    expect(vitestConfig).toMatch(/alias:\s*\[\s*prosemirrorResolve\(\),\s*\.\.\.sharedAlias\s*,?\s*\]/);
  });
});
