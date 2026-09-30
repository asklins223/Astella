/**
 * 一项轮次预算的**唯一一份起点值**（39d W4-5 第三刀；D1 §3.2 要求"三件缺一不可"，
 * 0282 用"NOT NULL 且没有 DEFAULT"落地，值由这里签发）。
 *
 * 为什么在服务端而不是调用方：这三件事决定"一轮最多花多少模型调用、最多排几道题、
 * 墙钟走到哪里算失控"。让它们由那个可能已经显示着旧屏、也可能被改过参数的客户端来定，
 * §6.2 那句"自动扩展受每轮时间/调用预算约束"就没人负责了。
 *
 * 为什么仍然可覆盖：§18.4 把这些起点值列为**试用前冻结**项——它们是产品参数，
 * 不是物理常数。环境变量是给那一次冻结留的口，**不是**界面设置项（用户界面里没有这一格）。
 * 坏值回落默认并要求一轮，而不是让创建失败：一轮开不出来是可感知的故障，
 * 而一个写错的 env 不该造成那种故障。
 *
 * 触顶行为三件都是同一句（§6.2）：保留已完成内容，说明可以继续阅读／稍后再试／先结束，
 * **不把资源限制说成用户能力不足**。这一刀只签发值与读出来，触顶的执行在计划与
 * 教学那一层（W4-6）。
 */

export type RoundBudgetsV1 = {
  maxModelCalls: number;
  maxWallClockSeconds: number;
  maxTasks: number;
};

/**
 * 起点值（每个都带理由，改的时候连理由一起改）：
 *  - `maxTasks: 6`——§4.3 明写"试用默认可从 2–4 个相关要点起步"，再加一次"插入一个
 *    必要前置"与一次"更换练习"的余量；这一项就是 §3.2 里"本轮不再自动加题"那个刹车。
 *  - `maxModelCalls: 16`——一轮的**总额**，不是每题配额。见下面那一段的分解。
 *  - `maxWallClockSeconds: 1800`——这是**失控上界**，不是给用户的承诺，也不是倒计时：
 *    §3.3 原话"用户的时间意愿只影响本轮建议量，不变成倒计时、考核或强制承诺"。
 */
export const DEFAULT_ROUND_BUDGETS_V1: RoundBudgetsV1 = {
  /**
   * 16 = **三轮**生成 ＋ 每轮一次自动重试：
   *
   *   - 讲解 2（1 ＋ 内核那一次自动重试）
   *   - 依据核对 2（同上；核查者与讲解是**两次独立**调用，不许合成一次）
   *   - 动态演示 2（同上；2026-09-28 起产物是模型整份写的一页，量级与前两段同级）
   *   - 用户说「换一种讲解」再走一轮（前三段）＝ 6
   *   - 余量 4
   *
   * **为什么从 8 抬到 16**：8 那个值是在"产物是一小段 steps JSON"的时候定的。真窗口实测
   * （2026-09-28）连撞两堵墙：先撞 200s 的单次墙钟（讲解 ＋ 核对就吃掉 163s，产物分到
   * 36.6s 超时），抬到 420s 之后又撞调用数——讲解 2 ＋ 核对 2 ＋ 产物 2 已经 6，用户在
   * 界面上点一次「换一种讲解」就 8 用完了，于是**讲解成功、产物缺席**，界面上只看得到
   * "没有演示"。§6.1 把动态讲解定成第一阶段必交付的教学能力，预算就得装得下它连同一次
   * 重试与一次重讲。
   *
   * 抬预算不等于放松：内核的类别表、检查点、租约与 deadline 一条没动，超出的照样按
   * `round_budget_exhausted` 触顶（保留已完成内容，不把资源限制说成用户能力不足）。
   */
  maxModelCalls: 16,
  /**
   * 1800 同样从 900 抬上来：一轮**顺利**跑完要 讲解 ≈ 90s ＋ 核对 ≈ 90s ＋ 整页产物
   * ≈ 120s，900 只够四发；而 16 次调用按每次 ~120s 算是 1920s。两个数不配平的话先撞的
   * 永远是墙钟，于是"调用还有余量"这件事变得毫无意义。
   */
  maxWallClockSeconds: 1_800,
  maxTasks: 6,
};

/** 每一项对应的环境变量名（前缀统一，避免 `MAXTASKS` 这种谁都不会设、也读不到的裸名）。 */
const ENV_BY_BUDGET: Record<keyof RoundBudgetsV1, string> = {
  maxModelCalls: "NOTE_ROUND_MAX_MODEL_CALLS",
  maxWallClockSeconds: "NOTE_ROUND_MAX_WALL_CLOCK_SECONDS",
  maxTasks: "NOTE_ROUND_MAX_TASKS",
};

/**
 * `0` 是**合法值**，而且是有意留的档：把 `maxTasks` 设成 0 就是"这一轮不排任何自动题"，
 * 用来对照"改了预算之后行为确实跟着变"。只有负数与非整数才按坏值处理。
 */
function readBudget(name: keyof RoundBudgetsV1): number {
  const raw = process.env[ENV_BY_BUDGET[name]]?.trim();
  if (!raw) return DEFAULT_ROUND_BUDGETS_V1[name];
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_ROUND_BUDGETS_V1[name];
  return parsed;
}

export function roundBudgetsV1(): RoundBudgetsV1 {
  return {
    maxModelCalls: readBudget("maxModelCalls"),
    maxWallClockSeconds: readBudget("maxWallClockSeconds"),
    maxTasks: readBudget("maxTasks"),
  };
}
