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
 *  - `maxModelCalls: 8`——一轮的**总额**，不是每题配额：规划一次、每个任务评估一次、
 *    留两次给瞬时故障的自动重试（`task_kernel` 的 `maxAutoRetries`）。
 *  - `maxWallClockSeconds: 900`——这是**失控上界**，不是给用户的承诺，也不是倒计时：
 *    §3.3 原话"用户的时间意愿只影响本轮建议量，不变成倒计时、考核或强制承诺"。
 */
export const DEFAULT_ROUND_BUDGETS_V1: RoundBudgetsV1 = {
  maxModelCalls: 8,
  maxWallClockSeconds: 900,
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
