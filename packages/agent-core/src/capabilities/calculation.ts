/**
 * Agent 的真实基础计算能力：一个**纯函数**表达式求值器。
 *
 * ## 合同里这一层是什么
 *
 * 方案 42 §7.2：联网、文件、计算这类基础能力「按实际产品需求接入，各自提供真实执行
 * 环境、资源范围和可验证回执」。计算这一层不该由模型自己口算，也不该由宿主去拼
 * `eval`——所以它是一个有界、可测、**不执行任何宿主代码**的表达式求值器：
 * 宿主把它当普通能力调用，拿到一个确定值和一份可回放的输入。
 *
 * ## 为什么不用 eval / Function
 *
 * 表达式来自对话，也就是**用户输入**。`eval` 会让它同时拿到宿主作用域、构造函数和
 * 全局对象——`x + (()=>process)` 在数值求值器里不该有任何意义。这里走
 * tokenizer + 递归下降：只有登记过的记号、只有登记过的函数，语法树之外的一切
 * （属性访问、字符串、赋值、模板、逗号运算符、括号函数调用）都在**词法阶段**
 * 就被拒绝，根本不会变成可执行的东西。
 *
 * 顺带的好处是求值顺序是**我们自己定的**，不依赖语言实现的细节：
 * 幂右结合、`-2^2 = -4`、一元负号优先级低于幂——这几条在 `eval` 下由引擎决定，
 * 换个宿主就可能不一样，而它们是学习场景里用户会直接质疑的地方。
 */

export interface AgentExpressionVariable {
  readonly name: string;
  readonly value: number;
}

export interface AgentExpressionResult {
  readonly value: number;
  readonly expression: string;
  readonly variables: readonly AgentExpressionVariable[];
}

/** 输入非法或求值不成立时抛出。消息写的是**哪一条规则**，不是内部实现。 */
export class AgentCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCalculationError";
  }
}

/** 资源边界。超限一律显式抛错，不截断——半截结果比报错更糟。 */
export const AGENT_EXPRESSION_LIMITS = {
  /** 表达式长度上限（含空白）。 */
  maxExpressionLength: 500,
  /** 变量个数上限。 */
  maxVariables: 20,
  /** 括号 / 函数调用的嵌套深度上限。 */
  maxDepth: 32,
  /** 记号数与求值步数上限，两者共用同一个预算。 */
  maxSteps: 256,
} as const;

/**
 * 允许的函数。名称与运算完全分开：变量名不许与它们冲突。
 *
 * 统一成 `(...values: number[]) => number`：`Math.abs` 是单参、`Math.min` 是变参，
 * 混在一个对象里会让 `FUNCTIONS[name](...args)` 过不了类型检查（元数不一致的
 * 联合类型不可展开调用）。真正的元数要求在 `parseCall` 里显式判。
 */
const FUNCTIONS: Readonly<Record<string, (...values: number[]) => number>> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  min: Math.min,
  max: Math.max,
};

type FunctionName = keyof typeof FUNCTIONS;

/** ASCII 标识符。不接受 Unicode 字母，避免全角/零宽字符混进变量名。 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * 标识符的**续接字符**。必须与 IDENTIFIER 分开：IDENTIFIER 带 `^$`，拿它去测单个
 * 字符时数字（`x0` 的 `0`）会被判成"不是标识符字符"，于是 `v0` 被切成 `v` 和 `0`。
 */
const IDENTIFIER_PART = /[A-Za-z0-9_]/;

const isFunctionName = (name: string): name is FunctionName =>
  Object.prototype.hasOwnProperty.call(FUNCTIONS, name);

type Token =
  | { kind: "number"; value: number }
  | { kind: "identifier"; name: string }
  | { kind: "operator"; operator: "+" | "-" | "*" | "/" | "%" | "^" }
  | { kind: "leftParen" }
  | { kind: "rightParen" }
  | { kind: "comma" };

interface Budget {
  steps: number;
  depth: number;
}

/**
 * 词法分析。任何字符级的不合法输入都在这里停下。
 *
 * 科学计数 `1e-3` 与 `1E+3` 都接受；数字解析用 `Number(...)` 而不是手写状态机，
 * 这样 `1e`、`0x10`、`1_0` 这些会被 `Number` 判成 `NaN` 而**不是**被悄悄截断
 * 成 `1`——"把 `0x10` 当成 0" 是一种比报错更难发现的错误。
 */
function tokenize(expression: string): Token[] {
  if (expression.length > AGENT_EXPRESSION_LIMITS.maxExpressionLength) {
    throw new AgentCalculationError(
      `表达式长度 ${expression.length} 超过上限 ${AGENT_EXPRESSION_LIMITS.maxExpressionLength}`,
    );
  }

  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index];

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({ kind: "leftParen" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rightParen" });
      index += 1;
      continue;
    }
    // 逗号只有作为 min/max 的参数分隔符才有意义，但它出现在任何位置
    // 都由语法阶段判断（"逗号只能出现在函数参数里"），这里先收下记号。
    if (char === ",") {
      tokens.push({ kind: "comma" });
      index += 1;
      continue;
    }

    if (char === "+" || char === "-" || char === "*" || char === "/" || char === "%" || char === "^") {
      tokens.push({ kind: "operator", operator: char });
      index += 1;
      continue;
    }

    // 标识符。
    if (IDENTIFIER.test(char) || char === "_") {
      const start = index;
      index += 1;
      while (index < expression.length && IDENTIFIER_PART.test(expression[index])) index += 1;
      tokens.push({ kind: "identifier", name: expression.slice(start, index) });
      continue;
    }

    if (char >= "0" && char <= "9") {
      const start = index;
      while (index < expression.length && /[0-9]/.test(expression[index])) index += 1;
      // 小数点：只有后面确实跟着数字才算小数，`1.` 与 `1..2` 交给 Number 判失败。
      if (expression[index] === ".") {
        index += 1;
        while (index < expression.length && /[0-9]/.test(expression[index])) index += 1;
      }
      // 指数：`e` / `E` 后可带正负号。
      if (expression[index] === "e" || expression[index] === "E") {
        const mark = index;
        index += 1;
        if (expression[index] === "+" || expression[index] === "-") index += 1;
        const digitsStart = index;
        while (index < expression.length && /[0-9]/.test(expression[index])) index += 1;
        // `1e` / `1e+` 没有有效数字 ⇒ 让 Number 去判失败，不退回成 `1`。
        if (index === digitsStart) index = mark;
      }

      const raw = expression.slice(start, index);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new AgentCalculationError(`无法解析的数字：${raw}`);
      }
      tokens.push({ kind: "number", value });
      continue;
    }

    throw new AgentCalculationError(
      `不允许的字符 ${JSON.stringify(char)}（位置 ${index}）：表达式只支持数字、变量、括号与 + - * / % ^`,
    );
  }

  if (tokens.length > AGENT_EXPRESSION_LIMITS.maxSteps) {
    throw new AgentCalculationError(
      `记号数 ${tokens.length} 超过上限 ${AGENT_EXPRESSION_LIMITS.maxSteps}`,
    );
  }
  return tokens;
}

/**
 * 递归下降。层序：
 *
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/' | '%') unary)*
 *   unary      := ('+' | '-') unary | power
 *   power      := primary ('^' unary)?          ← 右结合，且左操作数不是一元式
 *   primary    := number | identifier | identifier '(' args ')' | '(' expression ')'
 *
 * `power` 的操作数用 `unary` 而不是 `primary`，所以 `2^-3` 合法；
 * 而 `unary` 在 `power` 之上，所以 `-2^2` 解析成 `-(2^2) = -4`。
 */
function evaluate(tokens: readonly Token[], variables: ReadonlyMap<string, number>, budget: Budget): number {
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const take = (): Token => {
    const token = tokens[position];
    position += 1;
    spend();
    return token;
  };
  const spend = () => {
    budget.steps += 1;
    if (budget.steps > AGENT_EXPRESSION_LIMITS.maxSteps) {
      throw new AgentCalculationError(`求值步数超过上限 ${AGENT_EXPRESSION_LIMITS.maxSteps}`);
    }
  };
  const enter = () => {
    budget.depth += 1;
    if (budget.depth > AGENT_EXPRESSION_LIMITS.maxDepth) {
      throw new AgentCalculationError(`嵌套深度超过上限 ${AGENT_EXPRESSION_LIMITS.maxDepth}`);
    }
  };
  const leave = () => {
    budget.depth -= 1;
  };

  function parseExpression(): number {
    enter();
    try {
      let value = parseTerm();
      for (;;) {
        const token = peek();
        if (token?.kind !== "operator" || (token.operator !== "+" && token.operator !== "-")) return value;
        take();
        const right = parseTerm();
        value = apply(token.operator, value, right);
      }
    } finally {
      leave();
    }
  }

  function parseTerm(): number {
    let value = parseUnary();
    for (;;) {
      const token = peek();
      if (token?.kind !== "operator" || (token.operator !== "*" && token.operator !== "/" && token.operator !== "%")) {
        return value;
      }
      take();
      const right = parseUnary();
      value = apply(token.operator, value, right);
    }
  }

  function parseUnary(): number {
    const token = peek();
    if (token?.kind === "operator" && (token.operator === "+" || token.operator === "-")) {
      take();
      enter();
      try { const value = parseUnary(); return token.operator === "-" ? -value : value; }
      finally { leave(); }
    }
    return parsePower();
  }

  function parsePower(): number {
    const base = parsePrimary();
    const token = peek();
    // 缺左操作数时停在这里：`^2` 由上层报"表达式不完整"，不给它一个隐含的 0。
    if (token?.kind !== "operator" || token.operator !== "^") return base;
    take();
    enter();
    try { const exponent = parseUnary(); return finite(Math.pow(base, exponent)); }
    finally { leave(); }
  }

  function parsePrimary(): number {
    const token = peek();
    if (!token) throw new AgentCalculationError("表达式不完整：读到了末尾");

    if (token.kind === "number") {
      take();
      return token.value;
    }

    if (token.kind === "leftParen") {
      take();
      const value = parseExpression();
      expect("rightParen", ")");
      return value;
    }

    if (token.kind === "identifier") {
      take();
      if (isFunctionName(token.name)) {
        return parseCall(token.name);
      }
      if (!variables.has(token.name)) {
        throw new AgentCalculationError(`未定义的变量：${token.name}`);
      }
      if (peek()?.kind === "leftParen") {
        throw new AgentCalculationError(`变量 ${token.name} 不是函数，不能带参数调用`);
      }
      return variables.get(token.name)!;
    }

    if (token.kind === "operator" && token.operator === "-") {
      throw new AgentCalculationError("表达式不完整：缺少操作数");
    }
    if (token.kind === "operator") {
      throw new AgentCalculationError(`表达式不完整：运算符 ${token.operator} 前缺少操作数`);
    }
    if (token.kind === "comma") {
      throw new AgentCalculationError("逗号只能作为 min/max 的参数分隔符");
    }
    if (token.kind === "rightParen") {
      throw new AgentCalculationError("括号不匹配：多了一个 )");
    }
    throw new AgentCalculationError("表达式不完整");
  }

  function parseCall(name: FunctionName): number {
    expect("leftParen", `函数 ${name}(`);
    const args: number[] = [];
    if (peek()?.kind !== "rightParen") {
      args.push(parseExpression());
      while (peek()?.kind === "comma") {
        take();
        args.push(parseExpression());
      }
    }
    expect("rightParen", ")");

    const arity = args.length;
    if (name === "min" || name === "max") {
      if (arity < 2) throw new AgentCalculationError(`${name} 至少需要两个参数，实际 ${arity} 个`);
    } else if (arity !== 1) {
      throw new AgentCalculationError(`${name} 只接受一个参数，实际 ${arity} 个`);
    }

    // 函数元数是这项能力的明确合同；同时拒绝非有限结果。
    return finite(FUNCTIONS[name](...args));
  }

  function expect(kind: Token["kind"], display: string): Token {
    const token = peek();
    if (token?.kind !== kind) {
      throw new AgentCalculationError(
        token === undefined
          ? `表达式不完整：缺少 ${display}`
          : `此处需要 ${display}`,
      );
    }
    return take();
  }

  const result = parseExpression();
  if (position !== tokens.length) {
    throw new AgentCalculationError("表达式末尾有多余内容");
  }
  return result;
}

/** 除法/取模的零除在这里明确拒绝，不返回 Infinity 或 NaN。 */
function apply(operator: "+" | "-" | "*" | "/" | "%" | "^", left: number, right: number): number {
  switch (operator) {
    case "+": return finite(left + right);
    case "-": return finite(left - right);
    case "*": return finite(left * right);
    case "/":
      if (right === 0) throw new AgentCalculationError("除数为 0");
      return finite(left / right);
    case "%":
      if (right === 0) throw new AgentCalculationError("取模的除数为 0");
      return finite(left % right);
    case "^": return finite(Math.pow(left, right));
  }
}

function finite(value: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new AgentCalculationError("计算结果是 NaN");
  }
  if (!Number.isFinite(value)) {
    throw new AgentCalculationError("计算结果超出可表示范围（Infinity）");
  }
  return value;
}

/**
 * 求值。返回原样回显的表达式与变量表，宿主可以直接把它当**可核对的回执**存下来。
 *
 * 变量表按名字去重：同名重复是调用方的 bug，悄悄取最后一个会让"我传的是哪个"
 * 永远答不出来，所以直接拒绝。变量名不许与函数名冲突——否则 `abs` 到底是变量还是
 * 函数要靠上下文猜。
 */
export function calculateAgentExpression(
  expression: string,
  variables: readonly AgentExpressionVariable[] = [],
): AgentExpressionResult {
  if (typeof expression !== "string") {
    throw new AgentCalculationError("表达式必须是字符串");
  }
  // 长度按**原始输入**判，不按 trim 之后的：否则一个几百 KB 的空白串会被悄悄
  // 裁成 1 个字符通过检查，而调用方为这次调用付出的代价已经发生了。
  if (expression.length > AGENT_EXPRESSION_LIMITS.maxExpressionLength) {
    throw new AgentCalculationError(
      `表达式长度 ${expression.length} 超过上限 ${AGENT_EXPRESSION_LIMITS.maxExpressionLength}`,
    );
  }
  if (variables.length > AGENT_EXPRESSION_LIMITS.maxVariables) {
    throw new AgentCalculationError(
      `变量个数 ${variables.length} 超过上限 ${AGENT_EXPRESSION_LIMITS.maxVariables}`,
    );
  }

  const table = new Map<string, number>();
  for (const variable of variables) {
    if (typeof variable?.name !== "string" || !IDENTIFIER.test(variable.name)) {
      throw new AgentCalculationError(
        `变量名 ${JSON.stringify(variable?.name)} 不是 ASCII 标识符`,
      );
    }
    if (isFunctionName(variable.name)) {
      throw new AgentCalculationError(`变量名 ${variable.name} 与内置函数重名`);
    }
    if (table.has(variable.name)) {
      throw new AgentCalculationError(`变量名重复：${variable.name}`);
    }
    if (typeof variable.value !== "number" || !Number.isFinite(variable.value)) {
      throw new AgentCalculationError(
        `变量 ${variable.name} 的取值必须是有限数字，收到 ${String(variable.value)}`,
      );
    }
    table.set(variable.name, variable.value);
  }

  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    throw new AgentCalculationError("表达式为空");
  }

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) {
    throw new AgentCalculationError("表达式里没有可计算的内容");
  }

  const value = evaluate(tokens, table, { steps: 0, depth: 0 });

  return {
    value,
    expression: trimmed,
    variables: variables.map(variable => ({ name: variable.name, value: variable.value })),
  };
}
