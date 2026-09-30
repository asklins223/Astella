import { it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import * as ts from "typescript";

// 用 AST 拿**精确区间**——行号算术在这份文件上栽了两次：
// 一次把 JSDoc 的 `/**` 留在原文件，一次把区间短成「只有那段 JSDoc」。
// `node.getStart()` / `node.getEnd()` 不会。
it("spans", () => {
  const P = "src/renderer/src/app/companion-chat-session.tsx";
  const src = readFileSync(P, "utf8");
  const sf = ts.createSourceFile("i.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const MOVE = new Set([
    "desktopRouteFromAgentRoute", "companionMessageText", "applyRouteToRoom",
    "navChipSharesTarget", "navChipsStillOutsideMessages", "readCompleteCompanionHistory",
    "isCompanionRunConflict", "companionTurnErrorMessage",
  ]);
  const out: [number, number, string][] = [];
  const walk = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && MOVE.has(n.name.text)) {
      // `getStart()` 默认**会带上 JSDoc**——正好，我们要连注释一起搬
      out.push([n.getStart(sf), n.getEnd(), n.name.text]);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  out.sort((a, b) => a[0] - b[0]);
  const line = (o: number) => src.slice(0, o).split("\n").length;
  writeFileSync("/tmp/r52-spans.json", JSON.stringify(out.map(([a, b, n]) => [a, b, n])));
  for (const [a, b, n] of out) {
    console.log(`S ${n.padEnd(30)} ${line(a)}-${line(b)}`);
  }
  console.log(`S 共 ${out.length} 个 / 区间重叠 ${
    out.slice(1).filter((c, i) => c[0] < out[i][1]).length} 处`);
});
