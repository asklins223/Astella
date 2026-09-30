/**
 * LIKE/ILIKE 模式转义的行为测试。
 *
 * 2026-09-29（P1-12）。为什么这条要单独立一个测试文件：它修的是一个**静默**缺陷——
 * `continuous-history-service.ts` 此前把用户输入原样拼进 `ILIKE '%...%'`，
 * 搜 `%` 等于"匹配一切"，而 GIN trigram 索引对纯通配符失效，还会顺带把全表扫描打出来。
 * 那种缺陷不会让任何测试变红，只会安静地返回错结果。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeLikePattern } from "../lib/like-escape.ts";

describe("escapeLikePattern", () => {
  it("普通查询词原样通过（不引入多余转义）", () => {
    assert.equal(escapeLikePattern("复利效应"), "复利效应");
    assert.equal(escapeLikePattern("hello world"), "hello world");
    assert.equal(escapeLikePattern(""), "");
  });

  it("转义 % ——否则它会匹配任意多字符", () => {
    assert.equal(escapeLikePattern("%"), "\\%");
    assert.equal(escapeLikePattern("100%"), "100\\%");
    // 连续通配符要逐个转义，不能只转第一个。
    assert.equal(escapeLikePattern("%%"), "\\%\\%");
  });

  it("转义 _ ——否则它会匹配任意单字符", () => {
    assert.equal(escapeLikePattern("_"), "\\_");
    assert.equal(escapeLikePattern("a_b"), "a\\_b");
  });

  it("转义反斜杠本身（否则会吃掉后面那个字符的转义）", () => {
    // 反斜杠未转义时，`\%` 会被解析成"被转义的 %"，即字面 % ——看似对，
    // 但 `\\` 之后的字符归属会整体错位。转义后语义才是确定的。
    assert.equal(escapeLikePattern("\\"), "\\\\");
    assert.equal(escapeLikePattern("a\\b"), "a\\\\b");
  });

  it("混合输入逐字符处理，不吞字符", () => {
    assert.equal(escapeLikePattern("50%_off\\now"), "50\\%\\_off\\\\now");
  });

  /**
   * 分母自证：转义必须真的改变字符串。
   * 上面任何一条如果实现退化成恒等函数，第一条会红；如果实现截断，第一条也会红。
   * 这条额外钉住"纯通配符输入一定被改变"这个性质本身。
   */
  it("纯通配符输入一定被改变（恒等实现会被这条抓住）", () => {
    for (const raw of ["%", "_", "%%", "__", "\\"]) {
      assert.notEqual(
        escapeLikePattern(raw),
        raw,
        `${JSON.stringify(raw)} 原样返回了——它会被当成通配符，GIN trigram 索引也会失效`,
      );
    }
  });
});
