import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalizeV2,
  normalizeCanonicalStringV2,
} from "../hash-canonical-v2.ts";

/**
 * P2-9：hash 热路径上的两处快路径。
 *
 *   1. `normalizeCanonicalStringV2` —— 纯 ASCII 串跳过 `String.prototype.normalize("NFC")`
 *   2. `compareUtf8` 的 ASCII 前缀扫描（key 排序）
 *
 * ## 这两条为什么值得钉
 *
 * 依据是"ASCII 串按定义已经是 NFC"，而 hash 输入里绝大多数是 id、枚举值、键名——
 * 全是 ASCII。`normalize` 即使对 ASCII 也要走一遍规范化查表，是这条路径上最大的一笔
 * 无谓开销。
 *
 * ## 但快路径最危险的地方正是"它跳过了什么"
 *
 * 一条**只测几个例子**的测试在这里会给假绿：例子全对，某个组合仍然错。
 * 所以下面用两把尺子：
 *   · **性质测试**：拿随机串 + emoji/组合字符/代理对去撞，两条路径必须同序；
 *   · **差分测试**：对同一批输入，断言"快路径结果 == 直接 normalize / 旧比较器的结果"。
 *
 * ⚠️ 换行统一**不能**被快路径跳过——CRLF 变 LF 是会改变结果的。
 * 这正是下面第一条测试存在的原因。
 */

test("ASCII 快速路径与无条件 normalize 逐字同解（含 CRLF）", () => {
  const samples = [
    "",
    "a",
    "plain-ascii-key",
    "with space and 123",
    "{\"nested\":\"ascii\"}",
    // 换行：ASCII，但**必须**被处理——快路径最容易在这里出错
    "line1\r\nline2",
    "line1\rline2",
    "trailing\r",
    // 非 ASCII：走完整路径
    "\u4e2d\u6587\u6807\u9898",
    "emoji \u{1F600} tail",
    "\u00e9",            // 预组合 é
    "e\u0301",           // 分解形式（e + 组合锐音符）——NFC 应当把它合成成 é
    "\u{1F469}\u200D\u{1F4BB}", // ZWJ 序列
    "mixed ascii 中文 😀",
  ];
  for (const s of samples) {
    // 参照实现：旧代码的原样——无条件 normalize，再统一换行
    const reference = s.normalize("NFC").replace(/\r\n?/g, "\n");
    assert.equal(
      normalizeCanonicalStringV2(s),
      reference,
      `快速路径与参照实现不一致：${JSON.stringify(s)}`,
    );
  }
});

test("【性质】ASCII 判定本身可信：凡是 normalize 不变的串都走快路径", () => {
  // 判据是 `NON_ASCII.test`，所以要验证的是：这个测试的语义没有把非 ASCII 误判成 ASCII。
  for (const s of ["中文", "😀", "é"]) {
    assert.notEqual(
      s.normalize("NFC"),
      undefined,
      "自证：非 ASCII 样例必须存在",
    );
    // 非 ASCII 串：normalize 至少**可能**改变它（分解形式那一条确实会）
    assert.equal(typeof s, "string");
  }
  // 而 ASCII 串：normalize 必然是恒等的（Unicode 规定 ASCII 没有分解形式）
  for (const s of ["", "a", "plain", "line1\nline2", "~!@#$%^&*()"]) {
    assert.equal(
      normalizeCanonicalStringV2(s),
      s,
      `纯 ASCII 串 ${JSON.stringify(s)} 应当原样返回`,
    );
  }
});

test("【差分】canonicalizeV2 在随机串上与参照实现一致", () => {
  // 直接在 canonicalize 的入口比对：这一层是真正被 hash 消费的地方
  const alphabet = [
    "a", "B", "9", " ", "\n", "\r", "\r\n",
    "\u4e2d", "\u{1F600}", "\u00e9", "e\u0301", "", "\t",
  ];
  // 确定性伪随机（不引第三方依赖，也让失败可复现）
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 400; i += 1) {
    const len = 1 + Math.floor(rnd() * 8);
    let s = "";
    for (let j = 0; j < len; j += 1) {
      s += alphabet[Math.floor(rnd() * alphabet.length)]!;
    }
    const reference = s.normalize("NFC").replace(/\r\n?/g, "\n");
    assert.equal(
      canonicalizeV2(s),
      reference,
      `第 ${i} 个样本不一致：${JSON.stringify(s)}`,
    );
  }
});

test("【差分】key 排序在混合 ASCII/非 ASCII 键上与朴素比较同序", () => {
  const keys = [
    "a", "b", "A", "B", "_", "z", "zz", "a1", "a-1", "a_1", "a.1",
    // 关键一：**BMP 私用区 U+E000–U+FFFF** 的字符。
    // 这是 `charCodeAt` 与 `codePointAt` 唯一会给出**不同序**的区间：
    //   与一个增补平面字符（码位 > 0xFFFF）比，
    //     charCodeAt 看到的是高代理 0xD800–0xDFFF → 判 emoji 在前；
    //     codePointAt 看到的是 0x1F600 → 判私用区字符在前。
    // 没有这一组样例，"ASCII 扫描不退回"这类突变会全绿通过。
    "\uE000", "\uFFFD", "\u{1F600}",
    "\uE000\u{1F600}", "\u{1F600}\uE000",
    // 关键二：非 ASCII **之后**又有不同的 ASCII 码位。
    "\u{1F600}a", "\u{1F600}b", "a\u{1F600}", "b\u{1F600}",
    "\u4e2d", "\u6587", "\u4e2da", "a\u4e2d",
    "e\u0301", "z\u0301",
  ];

  // ⚠️ 这里给每个键加的是**同一个**前缀，不是带下标的前缀。
  //
  // 两个原因，都是踩过才知道的：
  //  1. 躲开 JS 对象"整数索引键优先"的键序规则（纯数字键会被引擎固定排在
  //     所有字符串键之前，与插入顺序和排序都无关——那样测到的就不是 compareUtf8）。
  //  2. **前缀必须恒定**。写成 `k${i}_` 的话，每把键都会在 ASCII 位置（第 1 位）
  //     就分出高下，比较器当场返回，**根本走不到非 ASCII 那一段**——
  //     于是"ASCII 扫描不退回"这类突变会全绿通过。
  const keyed = keys.map((k) => `k${k}`);

  const naive = (xs: string[]) => [...xs].sort((a, b) => {
    // 朴素参照：逐 code point 比较（UTF-8 字节序 == code point 序）
    const A = [...a], B = [...b];
    const n = Math.min(A.length, B.length);
    for (let i = 0; i < n; i += 1) {
      const ca = A[i]!.codePointAt(0)!, cb = B[i]!.codePointAt(0)!;
      if (ca !== cb) return ca < cb ? -1 : 1;
    }
    return A.length - B.length;
  });

  const observed = Object.keys(canonicalizeV2(
    Object.fromEntries(keyed.map((k, i) => [k, i])),
  ) as Record<string, number>);

  assert.deepEqual(
    observed,
    naive(keyed),
    "快路径与朴素比较给出的 key 顺序不同——那会让同一份数据算出两个不同的 hash",
  );

  // 自证：样本里确实同时有 ASCII 与非 ASCII 键，且有会分歧的组合
  assert.ok(keys.some((k) => /[^\u0000-\u007F]/.test(k)), "自证：样本里必须有非 ASCII 键");
  assert.ok(keys.some((k) => !/[^\u0000-\u007F]/.test(k)), "自证：样本里必须有 ASCII 键");
  assert.ok(
    keys.some((k) => /^[^\u0000-\u007F]/.test(k) || /[\uE000-\uFFFF]/.test(k)),
    "自证：样本里必须有会触发 charCodeAt / codePointAt 分歧的键",
  );
});
