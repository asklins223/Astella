/**
 * 伴星语音的**本地就绪态**（client 侧）。
 *
 * ## 为什么这一条要有
 *
 * 2026-10-02 排查「一直提示语音合成失败」时，事实是：
 *
 *  - qwen 引擎可用（合成出 15137 字节 mp3）；
 *  - edge-tts 引擎可用（合成出 12528 字节 mp3）；
 *  - `voice.segment.ready` 事件在正常产出，载荷与摘要都对；
 *  - **服务端日志里一条 TTS 错误都没有。**
 *
 * 零服务端错误 + 客户端每次都失败，只有一个解释：请求**根本没发出去**。
 * 音频图（AudioContext + 环境床）只在第一次 `pointerdown`/`keydown` 时建一次，
 * 那一次失败后 `graphRef` 永远是 null，而两条合成路第一行就
 * `if (!speakApi || !graph) throw` —— 于是一个请求都发不出去。
 *
 * 而建图失败那处当时写的是 `catch {}`：原因被吞掉，只剩用户那句提示。
 * 那种"哪儿都查不到原因"的形态，比建图失败本身更贵。
 *
 * 所以这里钉两件事：**失败要留下痕迹**、**失败不该是终态**。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const SRC = resolve(
  import.meta.dirname, "..", "..", "..", "components", "home-v2", "HomeV2AudioController.tsx",
);
const raw = readFileSync(join(SRC), "utf8");
/**
 * 剥掉注释再判。
 *
 * 这一条守卫的注释里**写着**「这里以前是 `catch {}`」——不剥注释的话，
 * 它会读到自己那句话，然后把"没退化成静默"判成"退化了"。同一个坑这一轮
 * 会话已经栽过两次，所以这里写清楚，免得下一个人以为判据坏了。
 */
const source = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

test("建图失败不再被 `catch {}` 吞掉", () => {
  const unlock = source.slice(source.indexOf("const prepare"), source.indexOf("const unlock"));
  expect(unlock).toMatch(/catch\s*\(err\)/);
  // 必须留下痕迹，否则"客户端每次失败、服务端零日志"这个形态无法自查。
  expect(unlock).toMatch(/console\.(warn|error)/);
  expect(unlock).not.toMatch(/catch\s*\{\s*\}/);
});

test("合成路按需建图：一次解锁失败不该让整轮会话没有声音", () => {
  expect(source).toMatch(/const ensureGraph = useCallback\(/);
  // ensureGraph 必须真的会在缺图时建，而不是只读。
  const body = source.slice(source.indexOf("const ensureGraph"), source.indexOf("const synthesizeVoice"));
  expect(body).toMatch(/if \(existing\) return existing/);
  expect(body).toMatch(/buildAmbientGraph\(\)/);
  expect(body).toMatch(/graphRef\.current = built/);
});

test("两条合成路都走 ensureGraph，不再各自要 `graphRef.current` 非空", () => {
  for (const [name, marker] of [
    ["synthesizeVoice", "const synthesizeVoice = useCallback"],
    ["synthesizeVoiceSegment", "const synthesizeVoiceSegment = useCallback"],
  ] as const) {
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\n  }, [", start));
    expect(body, `${name} 没有走 ensureGraph`).toMatch(/ensureGraph\(\)/);
    // 缺图时直接抛的那句要收窄成"真的没有 API 通道"，不再拿它挡图。
    expect(body).not.toMatch(/if \(!speakApi \|\| !graph\)/);
    expect(body).toMatch(/if \(!speakApi\)/);
  }
});

test("【自证】判据认得出「catch {} 静默吞掉」这个真实退化", () => {
  // 退化形状：回到那个查不出原因的写法。
  const degraded = "try { graphRef.current = build(); } catch { }";
  const unlock = source.slice(source.indexOf("const prepare"), source.indexOf("const unlock"));
  expect(unlock).not.toMatch(/catch\s*\{\s*\}/);  // 真代码里没有空 catch
  expect(degraded).toMatch(/catch\s*\{\s*\}/);  // 自证样本确实是那个退化
});

test("【自证】判据认得出「继续在合成路里要求图已存在」这个退化", () => {
  const degraded = "if (!speakApi || !graph) throw new Error('语音通道还没准备好');";
  expect(degraded).toMatch(/!speakApi \|\| !graph/);  // 自证样本确实是旧写法
  expect(source).not.toMatch(/!speakApi \|\| !graph/);  // 真代码里已经没有了
});
