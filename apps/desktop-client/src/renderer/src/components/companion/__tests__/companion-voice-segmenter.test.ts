// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CompanionVoiceSegmenter } from "../companion-voice-segmenter";

const RATE = 16_000;
/** 一帧 50ms（800 样本），与录音器 worklet 的节拍同一量纲。 */
const frame = (value: number, samples = 800) => new Float32Array(samples).fill(value);

describe("CompanionVoiceSegmenter", () => {
  it("没有开口之前攒的都只是环形缓冲，切不出段", () => {
    const segmenter = new CompanionVoiceSegmenter();
    segmenter.push(frame(0.001), RATE);
    segmenter.push(frame(0.001), RATE);
    expect(segmenter.drain()).toBeNull();
  });

  it("开口之后的帧进当前段，drain 一次就关门", () => {
    const segmenter = new CompanionVoiceSegmenter();
    segmenter.openSegment();
    for (let index = 0; index < 5; index += 1) segmenter.push(frame(0.2), RATE);
    expect(segmenter.drain()?.length).toBe(4000);
    expect(segmenter.isOpen).toBe(false);
    expect(segmenter.drain()).toBeNull();
  });

  /**
   * 每个字的首音不能被截掉。
   *
   * 电平是 20Hz 的采样，判定"开始说话"时人声早就开始了；不垫那一段，第一拍辅音
   * 就没了——识别出来的是另一个词，而用户明明说的是这个。
   */
  it("开门时把环形里垫着的开头接进段里，而且只接一次", () => {
    const segmenter = new CompanionVoiceSegmenter({ preRollMs: 200 });
    for (let index = 0; index < 6; index += 1) segmenter.push(frame(0.001), RATE);
    segmenter.openSegment();
    segmenter.push(frame(0.2), RATE);
    // 6 帧里环形只留得住最近 200ms（4 帧）→ 4×800 垫头 + 1×800。
    expect(segmenter.drain()?.length).toBe(4000);
    // 环形已经交出去了：第二次开门不会再把同一段垫两遍。
    segmenter.openSegment();
    for (let index = 0; index < 5; index += 1) segmenter.push(frame(0.2), RATE);
    expect(segmenter.drain()?.length).toBe(4000);
  });

  it("半口气不值得送去识别，也不留在段里污染下一句", () => {
    const segmenter = new CompanionVoiceSegmenter({ minSegmentMs: 220 });
    segmenter.openSegment();
    segmenter.push(frame(0.2, 400), RATE); // 25ms
    expect(segmenter.drain()).toBeNull();
    segmenter.openSegment();
    for (let index = 0; index < 5; index += 1) segmenter.push(frame(0.2), RATE);
    expect(segmenter.drain()?.length).toBe(4000);
  });

  it("pendingDurationMs 说得出这一段攒了多久", () => {
    const segmenter = new CompanionVoiceSegmenter();
    segmenter.openSegment();
    for (let index = 0; index < 10; index += 1) segmenter.push(frame(0.2), RATE);
    expect(segmenter.pendingDurationMs).toBe(500);
  });

  /** 48kHz 的声卡帧要自己降下来：识别引擎只认 16kHz，段与段之间也不能混采样率。 */
  it("把 48kHz 的帧降到 16kHz 再攒", () => {
    const segmenter = new CompanionVoiceSegmenter();
    segmenter.openSegment();
    segmenter.push(new Float32Array(2400).fill(0.2), 48_000); // 50ms
    expect(segmenter.pendingDurationMs).toBe(50);
    for (let index = 0; index < 4; index += 1) segmenter.push(new Float32Array(2400).fill(0.2), 48_000);
    expect(segmenter.drain()?.length).toBe(4000);
  });

  it("reset 把段与环形都清干净", () => {
    const segmenter = new CompanionVoiceSegmenter();
    segmenter.openSegment();
    for (let index = 0; index < 5; index += 1) segmenter.push(frame(0.2), RATE);
    segmenter.reset();
    expect(segmenter.isOpen).toBe(false);
    expect(segmenter.pendingDurationMs).toBe(0);
    segmenter.openSegment();
    for (let index = 0; index < 5; index += 1) segmenter.push(frame(0.2), RATE);
    // 清干净之后环形不残留上一次的半句话：段里就是这 5 帧。
    expect(segmenter.drain()?.length).toBe(4000);
  });
});
