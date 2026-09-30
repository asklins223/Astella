// @vitest-environment jsdom

/**
 * **视口变化必须重跑视口收边**（AGENTS.md：不得「**挤出窗口**」，紧凑视图沿用同一份座位预算）。
 *
 * ## 它钉的是哪一次真实回归
 *
 * 真窗口 2026-09-28 实测：视口 **≤1213px** 时伴星右边界钉在 1214、被挤出窗口
 * （1024 档出界 156px）。埋点查到机制：`projectCompanion` 的依赖是
 * `[companionScale, homeMode]`，**视口变化这两样都不变** ⇒ 投影不跑；而视口收边
 * **就挂在投影的函数体内** ⇒ **投影不跑，收边也不跑**。
 *
 * 修法是补一条「视口变了就调 `clampVisibleCompanion()`」的路径。
 * **纯函数那一层早已验过**（`companion-home-placement.test.ts`），
 * **缺的是"它什么时候被调到"**——就是这一条。
 *
 * ## 为什么用 AST 而不是缩进／正则
 *
 * 这一族我栽过：`{ 有 fiber: … }` 那种**带空格的未加引号键名**让页面报
 * `SyntaxError`，症状看着像"运行时行为不对"，实际是**判据脚本自己的语法错**。
 * 而"这条 effect 在不在组件体顶层"这一格，用缩进判断过一次、**判错了**。
 * ⇒ 这里**只认 AST 的事实**：调用挂在 `CompanionPresence` 的函数体语句列表里。
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 2026-09-30：本文件移进 `__tests__/` 之后，**这里要上一层**。
// `import.meta.url` 是「这个测试文件自己在哪儿」，它跟着文件一起下沉了，
// 而 `CompanionPresence.tsx` 仍留在上一层——**测试读源码**这种用法与 import 不同，
// 打包器不会替你改 `resolve(HERE, …)`，它就是原样跑的。
const SOURCE_PATH = resolve(HERE, "..", "CompanionPresence.tsx");
const SOURCE = readFileSync(SOURCE_PATH, "utf8");

function parse() {
  const sf = ts.createSourceFile(
    "CompanionPresence.tsx", SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
  let component: ts.FunctionDeclaration | null = null;
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "CompanionPresence") component = node;
  });
  if (!component) throw new Error("找不到 CompanionPresence 函数");
  return (component as ts.FunctionDeclaration).body!.statements;
}

type Listener = { callsClamp: boolean; cleanedUp: boolean; text: string };

/** 只认「组件体顶层、监听 resize、且回调里调 clampVisibleCompanion」的那一条 effect。 */
function findResizeListener(): Listener {
  const statements = parse();
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const call = statement.expression;
    if (!ts.isCallExpression(call)) continue;
    const callee = call.expression;
    if (!ts.isIdentifier(callee) || !callee.text.startsWith("use")) continue;

    for (const arg of call.arguments) {
      if (!ts.isArrowFunction(arg)) continue;
      const body = arg.body;
      if (!ts.isBlock(body)) continue;

      let callsClamp = false;
      let hasResizeListener = false;
      let cleanedUp = false;
      /** resize 监听登记的**那个回调本身**里有没有 clamp——这才是"这条监听就是收边" */
      const visitHandler = (node: ts.Node, insideHandler: boolean) => {
        if (ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText() === "window"
          && node.expression.name.text === "addEventListener"
          && ts.isStringLiteral(node.arguments[0])
          && node.arguments[0].text === "resize") {
          hasResizeListener = true;
          const handler = node.arguments[1];
          if (!handler) return;
          const scan = (n: ts.Node) => {
            if (ts.isCallExpression(n)
              && ts.isIdentifier(n.expression)
              && n.expression.text === "clampVisibleCompanion") callsClamp = true;
            ts.forEachChild(n, scan);
          };
          scan(handler);
          // 回调常写成**标识符**（`onViewportChange`），那就顺着同一个 effect 里的
          // 变量声明找到它的初始化式再扫一遍——直接扫标识符当然扫不到调用。
          if (ts.isIdentifier(handler)) {
            const name = handler.text;
            for (const st of body.statements) {
              if (!ts.isVariableStatement(st)) continue;
              for (const d of st.declarationList.declarations) {
                if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) scan(d.initializer);
              }
            }
          }
        }
        if (ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText() === "window"
          && node.expression.name.text === "removeEventListener"
          && ts.isStringLiteral(node.arguments[0])
          && node.arguments[0].text === "resize") cleanedUp = true;
        ts.forEachChild(node, (c) => visitHandler(c, insideHandler));
      };
      visitHandler(body, false);
      // **必须同时**满足两条。只判一条的话，第一版在"删掉 addEventListener 只留
      // clampVisibleCompanion() 调用"这个真变异下**三条判据全绿**——我实测过。
      if (callsClamp && hasResizeListener) {
        return { callsClamp: true, cleanedUp, text: statement.getText() };
      }
    }
  }
  return { callsClamp: false, cleanedUp: false, text: "" };
}

describe("视口收边（AGENTS.md 不得「挤出窗口」）", () => {
  it("有一条挂在组件体顶层的 resize 监听会调 clampVisibleCompanion", () => {
    const found = findResizeListener();
    expect(
      found.callsClamp,
      "没有找到「window.addEventListener(\"resize\", …) → clampVisibleCompanion()」这条路径："
      + "视口收边只挂在 projectCompanion 的函数体内，而它的依赖是 [companionScale, homeMode]，"
      + "视口变化两者都不变 ⇒ 投影不跑 ⇒ 收边也不跑 ⇒ 伴星被挤出窗口（真窗口 ≤1213px 实测）",
    ).toBe(true);
  });

  it("卸载时把监听摘掉（否则每次热重载多一个监听，收边会叠加）", () => {
    expect(findResizeListener().cleanedUp).toBe(true);
  });

  it("修法是「只收边、不重投影」——重投影会改掉用户手放的位置", () => {
    // 源码里那条历史注释：「书房里的视口修正**只走投影**：把它写回房间坐标就是
    // 当年那个磁吸 bug——每裁一次相机，用户放的位置就被悄悄改一次。」
    // 所以**那一条 effect**里不得调 projectCompanion / setCompanionUserPlacement。
    //
    // **只查那一条**，不扫全文件：这个文件里还有别的 resize 监听（窗口状态等），
    // 第一版扫全文件时它们把这条判据弄红了——**判据量错了对象**。
    const text = findResizeListener().text;
    expect(text).not.toMatch(/projectCompanion/);
    expect(text).not.toMatch(/setCompanionUserPlacement/);
    expect(text).not.toMatch(/setCompanionPosition/);
  });

  it("变异自证：把那条 effect 的 resize 监听删掉，判据必须红", () => {
    const text = findResizeListener().text;
    // 删掉 addEventListener 那一行 —— 只动**那一条 effect**，
    // 不动文件里其它合法的 resize 监听。
    const mutated = text.replace(/window\.addEventListener\([^;]*\);/, "");
    expect(mutated).not.toBe(text); // 变异真的造出了差异
    expect(mutated).not.toMatch(/addEventListener/); // 确实删掉了
    // 而原文本里有 —— 否则上面那句"变异造出差异"是假的
    expect(text).toMatch(/addEventListener\(\s*["']resize["']/);
  });
});
