import { calculateAgentExpression } from "@astella/agent-core";

/**
 * A general arithmetic mismatch check.
 *
 * This deliberately does not look for request words such as "算" or "核".
 * It parses an actual expression from the user's message and asks the calculator
 * for the value. The check only fires when the reply states a different number;
 * a reply that repeats the operands without a result is not a claim.
 */
export interface CompanionArithmeticMismatch {
  readonly expression: string;
  readonly expected: number;
  readonly claimed: string;
}

const OPERATOR_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/乘以|乘|×|✕|✖/gu, "*"],
  [/加上|加/gu, "+"],
  [/减去|减/gu, "-"],
  [/除以|除|÷/gu, "/"],
];

function normalizeOperators(text: string): string {
  let value = text.normalize("NFKC");
  for (const [pattern, operator] of OPERATOR_WORDS) value = value.replace(pattern, operator);
  // 10,063 is one number, not two.
  return value.replace(/(?<=\d),(?=\d{3}(?!\d))/gu, "");
}

function candidateExpressions(text: string): string[] {
  // A bare slash or hyphen in everyday prose ("1/2 杯", "3-4 小时") is not a
  // request to calculate. Only unambiguous arithmetic operators qualify.
  const original = text.normalize("NFKC");
  if (!/[×✕✖*^%]|乘以|乘|加上|加|减去|减|除以|除/u.test(original)) return [];
  const normalized = normalizeOperators(text);
  return (normalized.match(/[0-9().+\-*/^%\s]+/gu) ?? [])
    .map(candidate => candidate.trim())
    .filter(candidate => {
      if (!/\d/u.test(candidate) || !/[+\-*/^%]/u.test(candidate)) return false;
      // One number with a sign ("增加了 3 个") is not an expression either.
      if ((candidate.match(/\d+(?:\.\d+)?/gu) ?? []).length < 2) return false;
      // Dates, ranges and version strings are not one arithmetic expression.
      if (/^\d{4}-\d{1,2}-\d{1,2}$/u.test(candidate)) return false;
      if (/^\d+(?:\.\d+)?-\d+(?:\.\d+)?$/u.test(candidate)) return false;
      if (/^\d+(?:\.\d+)+$/u.test(candidate)) return false;
      return true;
    });
}

function numbers(text: string): number[] {
  return [...text.matchAll(/\d+(?:\.\d+)?/gu)].map(match => Number(match[0]))
    .filter(value => Number.isFinite(value));
}

function hasValue(values: readonly number[], expected: number): boolean {
  return values.some(value => Math.abs(value - expected) < 1e-9 * Math.max(1, Math.abs(expected)));
}

export function companionArithmeticMismatch(userText: string, replyText: string): CompanionArithmeticMismatch | null {
  for (const expression of candidateExpressions(userText)) {
    let expected: number;
    try {
      expected = calculateAgentExpression(expression).value;
    } catch {
      continue;
    }
    // Negative results need signed extraction from prose; skip them rather than
    // mistake a hyphenated date or range for a claim.
    if (!Number.isFinite(expected) || expected < 0) continue;
    const replyNumbers = numbers(normalizeOperators(replyText));
    if (hasValue(replyNumbers, expected)) return null;
    const inputNumbers = new Set(numbers(expression).map(value => String(value)));
    const extra = replyNumbers.filter(value => !inputNumbers.has(String(value)));
    if (extra.length === 0) continue;
    return { expression, expected, claimed: String(extra[0]) };
  }
  return null;
}
