/**
 * 长文覆盖分段：段宽由**这一次实际路由的模型声明预算**决定，分段数由正文长度决定。
 *
 * 这一档要替掉的是各生成任务里各抄一份的写法常量（16000×6、96000、24000、"最多八段"）：
 * 它们与所选模型档案无关，结果是同一篇笔记换个窗口更大的模型也照样只读到前一段，
 * 或者长一点的笔记被整篇拒掉。
 *
 * 规则只有三条：
 * 1. 起点是整篇一段——窗口装得下的材料不该被预先切碎；
 * 2. 某一段的完整请求超出声明预算就对半细分，**分段数不设上限**，
 *    正文长只是多几段，不存在"这篇太长读不完"；
 * 3. 只有细分到连一小段完整段落都装不下才失败，而且报的是这个真原因。
 *
 * 判定"装得下"由调用方提供（它用自己的请求形状走 `governContextPressure` 计量），
 * 这里不猜 token 与字符的换算比例。
 */

/** 细分下界：一段完整段落再小下去就不是材料了，是一地碎片。 */
export const MIN_COVERING_PIECE_CHARS = 512;

export interface CoveringPlanInput<T> {
  /** 按给定段宽把正文切成块；块的内容必须与切法无关（不丢段落）。 */
  build: (pieceChars: number) => T[];
  /** 用真实请求形状计量：全部装得下才返回 true。 */
  fits: (chunks: readonly T[]) => Promise<boolean>;
  /** 仍然装不下时抛哪个错——每个任务保留自己的错误类型与人话文案。 */
  overflow: (pieceChars: number) => Error;
  minPieceChars?: number;
}

export async function planCoveringChunks<T>(input: CoveringPlanInput<T>): Promise<{ chunks: T[]; pieceChars: number }> {
  const floor = input.minPieceChars ?? MIN_COVERING_PIECE_CHARS;
  let pieceChars = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const chunks = input.build(pieceChars);
    if (await input.fits(chunks)) return { chunks, pieceChars };
    if (pieceChars <= floor) throw input.overflow(pieceChars);
    pieceChars = Math.max(Math.floor(pieceChars / 2), floor);
  }
}
