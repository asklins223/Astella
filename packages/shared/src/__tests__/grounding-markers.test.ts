import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUNDING_MARKERS_V1, isGroundingMarkerV1, evidenceQuoteMatchesBlockV1 } from "../note-dynamic-artifact/round-artifact-measure.ts";

/**
 * 表格竖线是排版骨架，不是文字——模型引的每一句表格行都得核得回去。
 *
 * 实测（2026-10-14，37 万字符长文的脑图）：提示里给模型看的是原始 markdown
 * （整行 `| 当前交流 | 当前请求… |`），核对用的却是渲染后的正文，而
 * `noteBlockRenderedTextV1` 把竖线去掉了——于是表格行的引文必然逐字对不上，
 * 两发（含带被拒那版的 repair）全部判死，用户只看到"这次生成没有完成"。
 * 同一条链上四份核对实现都从这一处取判据，所以补在声明这里。
 */
test("竖线在标记集里：引文带竖线、块里不带（或反过来）仍然算同一句", () => {
  assert.ok(isGroundingMarkerV1("|"), "竖线必须在 GROUNDING_MARKERS_V1 里，四条生成链共用");
  for (const char of ["`", "*", "_", "~", "|"]) assert.ok(isGroundingMarkerV1(char), `${char} 应当不参与比较`);

  // 渲染后的表格行（竖线已去掉），与模型按原始 markdown 引的那一句。
  const rendered = "当前交流当前请求、相关记忆与方法明确长期要求、具体纠正、有来源的共同事件";
  const quoted = "当前交流 | 当前请求、相关记忆与方法 | 明确长期要求、具体纠正、有来源的共同事件";
  assert.ok(evidenceQuoteMatchesBlockV1(rendered, quoted), "带竖线的引用要能在渲染后的正文里核到");

  // 反向：块里带竖线、引文按渲染后写，同样算数（同一条判据，两个方向）。
  assert.ok(evidenceQuoteMatchesBlockV1(quoted, rendered));

  // 该拒的照拒：编出来的句子不会因为跳过竖线就变真。
  assert.equal(evidenceQuoteMatchesBlockV1(rendered, "当前交流 | 当前请求、相关记忆与方法 | 从未被记录的另一件事"), false);
  // 竖线也不能替一个词凑出内容。
  assert.equal(GROUNDING_MARKERS_V1.includes("交"), false);
});
