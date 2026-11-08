/**
 * 一段收音"像不像一句话"的判定（2026-11-07）。
 *
 * 本机识别模型在**没有语音**的音频上也会给出一个词。实测（`model.int8.onnx` 同一份
 * 模型、同一套解码参数）：
 *
 * | 输入 | 输出 |
 * | --- | --- |
 * | 纯静音 0.6 秒 | 嗯。 |
 * | 纯静音 1.5 秒 / 3 秒 | 그. |
 * | 房间底噪（白噪 0.12） | 그. / I. |
 * | 键盘声 | I. / Yeah. |
 * | 音乐、提示音 | The. / Okay. |
 * | 真人说话 | 正文按字出现，3~5 字/秒 |
 *
 * 能量 VAD 只能证明"这段时间有响声"——风扇、键盘、外放的音乐都算——不能证明"有人
 * 说话"。麦一直开着的时候，背景声攒够一轮就会被当成用户说的话发出去（2026-11-07
 * 用户实测：说完第一轮后，界面自己多出一条「. The. I. The.」）。
 *
 * 所以判定不另起一套声学检测，而是拿模型自己吐出来的正文和这段音频里**有声时长**
 * 对齐：真人说话大约每秒 3~5 个字（实测 17 字 / 3.9 秒；最慢的单字「好」也有
 * 2.4 字/秒），而幻觉是一两个词铺满整段（实测 1 个词 / 1~3 秒，背景音乐里
 * 3 个词 / 数十秒）。只要求平均每个字不超过一秒的有声时长。
 *
 * 为什么不是词表、也不是"这句话读起来像不像话"：那是在拿上一句坏样本写规则
 * （见 AGENTS.md），模型换个词就绕过去了。这里量的是"这段音频里到底有没有那么多
 * 话"，与它具体说了哪个词无关。
 *
 * 判错的方向是明确写出来的：宁可让用户重说一句、并把原因说出来（气泡里写
 * 「只听到背景声」），也不替他把噪声当成他说的话发出去。
 */

/** 每个"字"最多能占的有声时长。真人最慢的单字约 0.42 秒，这里留出一倍余量。 */
export const COMPANION_SPEECH_MS_PER_UNIT = 1000;

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * 转写正文里"听得出的字"有多少：中日韩按字算，拉丁等文字按词算，标点与空白不算。
 *
 * 按词算是因为同样一句话的英文只有几个词：`The.` 是 1 个单位而不是 4 个字符，
 * 否则噪声幻觉在英文里会显得"内容很多"。
 */
export function companionSpokenUnits(text: string): number {
  let units = 0;
  let inWord = false;
  for (const character of text) {
    if (CJK.test(character)) {
      units += 1;
      inWord = false;
      continue;
    }
    if (WORD_CHAR.test(character)) {
      if (!inWord) units += 1;
      inWord = true;
      continue;
    }
    inWord = false;
  }
  return units;
}

/**
 * 这段音频够不够撑起这几个字。
 *
 * `voicedMs` 是 VAD 在这段音频里累计的"有声"时长；为 0 时（调用方没量到）不拦，
 * 因为没有可对照的量时不该替用户做判断。
 */
export function companionSpeechEvidence(units: number, voicedMs: number): boolean {
  if (units <= 0) return false;
  if (voicedMs <= 0) return true;
  return voicedMs <= units * COMPANION_SPEECH_MS_PER_UNIT;
}
