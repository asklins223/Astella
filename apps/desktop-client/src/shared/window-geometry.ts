/**
 * 原生内容窗口的尺寸约束（2026-10 放开最大化时收缩到只剩下限）。
 *
 * 这里曾经还有一整套比例锁：`HOME_WINDOW_WORLD_SIZE`、`HOME_WINDOW_ASPECT_RATIO`、
 * `HOME_WINDOW_RATIO_TOLERANCE`、`isHomeWindowAspectRatio`，以及
 * `homeWindowSizeProblems` 里"必须接近 16:9"那条分支。它们描述的是
 * `window.setAspectRatio(...)` + `maximizable: false` 这条已经拆掉的原生锁比。
 * 锁比拆掉后，"不露边、底图不变形"由渲染层的 cover 摆位承担
 * （`styles.css` 的 `.scene-reference-frame[data-scene-fit="cover"]` 与
 * `.room-backplate` 的 `object-fit: cover`），比例不再是窗口的能力边界，
 * 继续留着这套断言只会让验收矩阵拒绝用户真实能摆出来的尺寸。
 *
 * 仍然成立、也仍然只有原生窗口能保证的，是尺寸下限：小于此值纸面正文与伴星
 * 座位会挤到一起。这是这里唯一剩下的规则。
 */

export const HOME_WINDOW_INITIAL_CONTENT_SIZE = Object.freeze({ width: 1440, height: 810 });
export const HOME_WINDOW_MINIMUM_SIZE = Object.freeze({ width: 1280, height: 720 });

/**
 * Acceptance sizes must be at least `HOME_WINDOW_MINIMUM_SIZE` and positive
 * finite numbers. Returns one human-readable problem per violated rule, and an
 * empty array when the size is a reachable content size.
 *
 * Off-ratio sizes are accepted on purpose: the window is no longer ratio-locked,
 * so `1024x700` is reachable only in the sense that it is below the minimum, and
 * a maximised ultrawide size is both reachable and expected.
 */
export function homeWindowSizeProblems(width: number, height: number): string[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return [`Home window content size ${width}x${height} is not a positive finite size`];
  }

  if (width < HOME_WINDOW_MINIMUM_SIZE.width || height < HOME_WINDOW_MINIMUM_SIZE.height) {
    return [
      `Home window content size ${width}x${height} is below the locked `
      + `${HOME_WINDOW_MINIMUM_SIZE.width}x${HOME_WINDOW_MINIMUM_SIZE.height} minimum`,
    ];
  }

  return [];
}