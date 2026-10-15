import { test } from "node:test";
import assert from "node:assert/strict";
import { projectCompanionVisible } from "../companion-dialogue-stream.ts";
import { validateCompanionOutput } from "../companion-dialogue-content.ts";
import { containsCompanionToolProtocol, withholdPartialCompanionToolProtocol } from "../companion-tool-protocol-output.ts";

test("an incomplete control prefix is withheld while complete Markdown examples remain readable", () => {
  assert.equal(withholdPartialCompanionToolProtocol("解释。<tool_ca"), "解释。");
  assert.equal(containsCompanionToolProtocol("解释。<tool_call>"), true);
  const example = "例如 `<tool_call>` 是代码。";
  assert.equal(containsCompanionToolProtocol(example), false);
  assert.equal(withholdPartialCompanionToolProtocol(example), example);
});

test("native tool markup is withheld at every chunk boundary and rejected before publication", () => {
  for (const marker of ["<tool_call><parameter=agent_calculate>", "<FUNCTION_CALL name='calculate'>",
    "<function=agent_calculate>", "<parameter =expression>", "</tool_call>"]) {
    const prefix = "先核对当前问题。";
    const output = prefix + marker + "1+1</parameter></function></tool_call>";
    let rejected = false;
    for (let through = 1; through <= output.length; through++) {
      const projected = projectCompanionVisible(output.slice(0, through));
      if (projected.kind === "rejected") { assert.equal(projected.reason, "tool_protocol_leak"); rejected = true; break; }
      if (projected.kind === "visible") assert.ok(prefix.startsWith(projected.text), `leaked prefix: ${projected.text}`);
    }
    assert.ok(rejected);
    assert.deepEqual(validateCompanionOutput(output), { ok: false, reason: "tool_protocol_leak" });
  }
});

test("explicit Markdown code examples remain valid even when protocol tags arrive before the closing delimiter", () => {
  for (const output of ["语法示例：`<tool_call>`。", "示例：\n```xml\n<tool_call><parameter=expression>1+1</parameter></tool_call>\n```",
    "~~~xml\n<function_call>示例</function_call>\n~~~", "跨行代码：`example\n<tool_call>`。"] ) {
    for (let through = 1; through <= output.length; through++)
      assert.notEqual(projectCompanionVisible(output.slice(0, through)).kind, "rejected", output.slice(0, through));
    assert.equal(validateCompanionOutput(output).ok, true);
  }
  assert.equal(validateCompanionOutput("没闭合的行内代码：`example\n<tool_call>").ok, false);
});

test("comparison signs and unrelated tag names are not mistaken for tool invocation", () => {
  assert.equal(validateCompanionOutput("a < b，并且 b > 0。").ok, true);
  assert.equal(validateCompanionOutput("<tool_callback> 是一个不同的标签名。").ok, true);
});
