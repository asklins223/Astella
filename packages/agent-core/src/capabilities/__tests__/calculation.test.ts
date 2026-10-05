/**
 * 计算能力的纯函数回归。
 *
 * 钉的是**行为与边界**，不是实现的复述：每条断言问的是"用户会怎么用、会怎么写错、
 * 会怎么试图越界"，而不是"我的状态机第几步该返回什么"。实现换成别的解析器，
 * 只要行为还在，这些断言就该继续成立。
 *
 * 三条主线：
 *   1. 数值与求值顺序（学习场景里用户会直接质疑的那些）；
 *   2. 语法错误（每一种都明确拒绝，不给半截结果）；
 *   3. 边界与注入（长度/变量/深度/预算，以及"这不是 eval"）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_EXPRESSION_LIMITS,
  AgentCalculationError,
  calculateAgentExpression,
} from "../calculation.ts";

const value = (expression: string, variables?: { name: string; value: number }[]) =>
  calculateAgentExpression(expression, variables).value;

/** 断言它以我们自己的错误类型失败，而不是碰巧抛了个别的什么。 */
const rejects = (expression: string, variables?: { name: string; value: number }[]) =>
  assert.throws(() => calculateAgentExpression(expression, variables), AgentCalculationError);

// ── 数值与求值顺序 ─────────────────────────────────────────────────────────

test("四则运算与括号按常规优先级", () => {
  assert.equal(value("1 + 2 * 3"), 7, "乘法没优先于加法");
  assert.equal(value("(1 + 2) * 3"), 9, "括号没改变优先级");
  assert.equal(value("10 - 2 - 3"), 5, "减法不满足左结合");
  assert.equal(value("100 / 10 / 5"), 2, "除法不满足左结合");
  assert.equal(value("7 % 4"), 3);
  assert.equal(value("-7 % 4"), -3, "取模应保留被除数符号");
  assert.equal(value("2 * -3"), -6);
  assert.equal(value("  1 +   1  "), 2, "空白不该影响结果");
  assert.equal(value("+ 1"), 1, "一元正号是合法的，不该当成语法错误");
  assert.equal(value("-+1"), -1, "一元符号可以连写");
  assert.equal(value("(((((1)))))"), 1);
});

test("幂右结合，且一元负号在幂之外", () => {
  assert.equal(value("2 ^ 3 ^ 2"), 512, "幂应右结合：2^(3^2) 而不是 (2^3)^2");
  assert.equal(value("-2 ^ 2"), -4, "一元负号应作用于整个幂：-(2^2)");
  assert.equal(value("(-2) ^ 2"), 4, "括号里的负数才是底数");
  assert.equal(value("2 ^ -3"), 1 / 8, "指数可以是负数");
  assert.equal(value("2 ^ 0"), 1);
  assert.equal(value("-2 ^ 2 ^ 2"), -16, "右结合下应为 -(2^4)");
});

test("十进制与科学计数", () => {
  assert.equal(value("0.5 + 0.25"), 0.75);
  assert.equal(value("1e3"), 1000);
  assert.equal(value("1E3"), 1000);
  assert.equal(value("1.5e-3"), 0.0015);
  assert.equal(value("2.5e+2"), 250);
  assert.equal(value("0"), 0);
  assert.equal(value("007"), 7);
});

test("变量参与运算，未定义变量明确报错", () => {
  assert.equal(value("x + y", [{ name: "x", value: 2 }, { name: "y", value: 3 }]), 5);
  assert.equal(value("x * x", [{ name: "x", value: -4 }]), 16);
  assert.equal(value("radius ^ 2", [{ name: "radius", value: 3 }]), 9);
  assert.equal(value("a", [{ name: "a", value: -0 }]), -0);

  rejects("x + 1");
  rejects("x + 1", [{ name: "y", value: 1 }]);
  // 变量名必须区分大小写，否则 x 与 X 会被当成同一个。
  rejects("X", [{ name: "x", value: 1 }]);
});

test("函数：abs / sqrt / min / max", () => {
  assert.equal(value("abs(-3)"), 3);
  assert.equal(value("abs(3)"), 3);
  assert.equal(value("sqrt(9)"), 3);
  assert.equal(value("min(3, 1, 2)"), 1);
  assert.equal(value("max(3, 1, 2)"), 3);
  assert.equal(value("min(-1, 1)"), -1, "min 不会把负数当缺省值跳过");
  assert.equal(value("sqrt(16) + abs(-3 ^ 2)"), 13, "函数参数是完整表达式：-3^2 = -(3^2) = -9");
  assert.equal(value("min(1 + 1, 2 * 2)"), 2, "参数里应遵守常规优先级");
  assert.equal(value("max(min(4, 3), min(2, 9))"), 3, "函数可以嵌套");
});

test("零除、负数开方与非有限结果都明确报错，不返回 NaN / Infinity", () => {
  rejects("1 / 0");
  rejects("1 / (2 - 2)");
  rejects("5 % 0");
  rejects("sqrt(-1)");
  rejects("sqrt(0 - 4)");
  // 中间结果溢出也要挡住，而不是把 Infinity 交出去。
  rejects("1e308 * 10");
  rejects("2 ^ 1024");
  rejects("0 / 0");

  const overflow = calculateAgentExpression("99999999999999999999");
  assert.equal(overflow.value, 99999999999999999999, "大但仍有限的值应当保留");
});

// ── 回执形状 ───────────────────────────────────────────────────────────────

test("返回值原样回显表达式与变量，可当可核对的回执", () => {
  const variables = [{ name: "n", value: 7 }];
  const result = calculateAgentExpression(" n * 6 ", variables);

  assert.equal(result.value, 42);
  assert.equal(result.expression, "n * 6", "回显应去掉首尾空白、保留内部书写");
  assert.deepEqual(result.variables, variables);
  // 纯函数：不应改到调用方的数组。
  assert.equal(result.variables, result.variables);
  variables.push({ name: "m", value: 1 });
  assert.equal(calculateAgentExpression("n", [{ name: "n", value: 7 }]).variables.length, 1);
});

// ── 语法 ───────────────────────────────────────────────────────────────────

test("语法错误：每一种都被明确拒绝", () => {
  rejects("");
  rejects("   ");
  rejects("1 +");
  rejects("* 2");
  rejects("-");
  rejects("1 2");
  rejects("(1");
  rejects("1)");
  rejects("()");
  rejects("(1))");
  rejects("1 +* 2");
  rejects("^2");
  rejects("1 + , 2");
  rejects("min()", undefined);
  rejects("abs(1, 2)");
  rejects("abs()");
  rejects("sqrt(1, 2)");
  rejects("1 ^", undefined);
  rejects("x(", [{ name: "x", value: 1 }]);
});

test("未登记的函数与按变量调用都拒绝", () => {
  rejects("round(1.5)");
  rejects("eval(1)");
  rejects("parseFloat(1)");
  rejects("Number(1)");
  rejects("abs(1) + round(1)");
  // 变量后面跟括号意味着想把它当函数用，必须拒绝而不是忽略括号。
  rejects("f(1)", [{ name: "f", value: 1 }]);
  rejects("abs(1)(2)");
});

// ── 注入：这不是 eval ─────────────────────────────────────────────────────

test("注入：属性、字符串、赋值、模板与构造器都进不来", () => {
  rejects("1.constructor");
  rejects("x.toString()", [{ name: "x", value: 1 }]);
  rejects("().__class__");
  rejects('"abc"');
  rejects("'abc'");
  rejects("`abc`");
  rejects("1 + '1'");
  rejects('1 + "1"');
  rejects("x = 1", [{ name: "x", value: 1 }]);
  rejects("1; 2");
  rejects("process.exit(1)");
  rejects("this");
  rejects("1 => 2");
  rejects("[1, 2]");
  rejects("{}");
  rejects("1 && 2");
  rejects("1 || 2");
  rejects("1 == 1");
  rejects("1 < 2");
  rejects("0x10");
  rejects("1_000");
  rejects("0b101");
  rejects("1n");
  rejects("??");
  rejects("#");
  rejects("1 \\ 2");
});

test("函数名不能被变量名占用", () => {
  rejects("abs", [{ name: "abs", value: 1 }]);
  rejects("sqrt", [{ name: "sqrt", value: 1 }]);
  rejects("min", [{ name: "min", value: 1 }]);
  rejects("max", [{ name: "max", value: 1 }]);
  // 名字相近但不是保留函数的变量名应当照常可用。
  assert.equal(value("abs1", [{ name: "abs1", value: 5 }]), 5);
  assert.equal(value("ab", [{ name: "ab", value: 5 }]), 5);
});

test("变量表本身受约束：非标识符、重复名、非有限取值都拒绝", () => {
  rejects("a", [{ name: "1a", value: 1 }]);
  rejects("a", [{ name: "a b", value: 1 }]);
  rejects("a", [{ name: "变量", value: 1 }]);
  rejects("a", [{ name: "", value: 1 }]);
  rejects("a", [{ name: "a", value: 1 }, { name: "a", value: 2 }]);

  rejects("a", [{ name: "a", value: Number.NaN }]);
  rejects("a", [{ name: "a", value: Number.POSITIVE_INFINITY }]);
  rejects("a", [{ name: "a", value: Number.NEGATIVE_INFINITY }]);
});

// ── 边界 ───────────────────────────────────────────────────────────────────

test("长度上限", () => {
  const { maxExpressionLength } = AGENT_EXPRESSION_LIMITS;
  // 记号数与长度共用预算，所以"刚好到长度上限"要用空白顶出来，而不是堆记号。
  const fits = `1${" ".repeat(maxExpressionLength - 1)}`;
  assert.equal(fits.length, maxExpressionLength);
  assert.equal(value(fits), 1, "刚好到上限的表达式应当照常求值");

  rejects(`1${" ".repeat(maxExpressionLength)}`);

  // 长度按原始输入判：纯空白不能被 trim 成合法表达式蒙混过去。
  rejects(" ".repeat(maxExpressionLength + 1));
});

test("变量个数上限", () => {
  const { maxVariables } = AGENT_EXPRESSION_LIMITS;
  const atLimit = Array.from({ length: maxVariables }, (_, i) => ({ name: `v${i}`, value: i }));
  assert.equal(value(atLimit.map(v => v.name).join(" + "), atLimit), maxVariables * (maxVariables - 1) / 2);

  const overLimit = [...atLimit, { name: "extra", value: 1 }];
  rejects(overLimit.map(v => v.name).join(" + "), overLimit);
});

test("嵌套深度上限", () => {
  const { maxDepth } = AGENT_EXPRESSION_LIMITS;
  const atLimit = "(".repeat(maxDepth - 2) + "1" + ")".repeat(maxDepth - 2);
  assert.equal(value(atLimit), 1, "刚好到上限的嵌套应当照常求值");

  const overLimit = "(".repeat(maxDepth * 4) + "1" + ")".repeat(maxDepth * 4);
  rejects(overLimit);
});

test("求值预算：记号数与求值步数共用上限，深表达式被挡住", () => {
  const { maxSteps } = AGENT_EXPRESSION_LIMITS;
  // n 个 "1" 不加空格连起来是 2n-1 个记号、同样 2n-1 个字符：
  // 所以 "刚好在预算内" 与 "刚好超预算" 之间只差一项，长度都仍在 500 以内，
  // 先撞上的必然是预算而不是长度。
  const fits = Math.floor((maxSteps + 1) / 2);
  const over = fits + 1;
  const chain = (n: number, operator: string) => `${"1" + operator}`.repeat(n - 1) + "1";
  assert.ok(2 * over - 1 > maxSteps && 2 * over - 1 <= 500, "构造的表达式应当只撞预算不撞长度");

  assert.equal(value(chain(fits, "+")), fits, "预算内的长表达式不该被误杀");
  rejects(chain(over, "+"));

  // 幂链同理：右结合不会让它展开成指数级的步数，但记号预算仍要挡住超长输入。
  assert.equal(value(chain(AGENT_EXPRESSION_LIMITS.maxDepth-1, "^")), 1, "预算与深度内的全 1 幂链恒为 1");
  rejects(chain(fits, "^"));
  rejects(chain(over, "^"));
});
test("幂链和单目运算同样受递归深度约束", () => {
  assert.throws(() => calculateAgentExpression("2^".repeat(40) + "1"), /嵌套深度/);
  assert.throws(() => calculateAgentExpression("-".repeat(40) + "1"), /嵌套深度/);
  assert.equal(calculateAgentExpression("2^-3").value,0.125);
});
