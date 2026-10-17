/** Normal reasoning and generation time; call-count and error guards remain separate. */
export const DEFAULT_AI_PROVIDER_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_AI_TASK_TIMEOUT_MS = 30 * 60_000;

/**
 * 模型档案**没有**声明输出额度时，整个平台共用的那一个兜底值。
 *
 * 它同时是"这一发最多能写多少"和"从窗口里预留多少"——两处必须同一个数，
 * 否则就会出现预留按 A、实际按 B 那种把输出砍成半截话的错配。
 *
 * 数值依据：拿不到声明时宁可问得多。实测最长的一次真实产出是互动演示整页
 * 43197 output token（2026-10-12，deepseek-v4.1-flash + high 思考，其中思考 34793），
 * 早先那个 16384 兜底（按某一款模型 15442 token 自停校准）会把这一发直接截断；
 * 同一批实测也表明这类端点接受十万级 `max_tokens`（真实下发过 384000）。
 *
 * 档案声明了就以声明为准（这一条只在拿不到声明时走）。任务 handler 不再各自写一个
 * `maxTokens: 3800`——档案缺失时那些数就是真实天花板，会把长输出砍成半截话。
 */
export const AI_UNDECLARED_OUTPUT_TOKENS = 65_536;
