import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  companionLaunchRegisteredAt,
  isCompanionLaunchRegistered,
  markCompanionLaunchRegistered,
  resetCompanionLaunchRegistrationForTests,
  subscribeCompanionLaunchRegistration,
} from "../companion-pages/companion-launch-gate.ts";

/**
 * 展示闸门的存在理由（2026-10-16 真窗口实测）：
 * 服务端在 12:29:42.539 把上一次启动没被看见的问候作废，客户端仍在 12:29:43.4 把它显示了出来
 * —— 它手上是作废之前那次投影读取的负载。服务端收口拦不住已经在路上的字，
 * 所以"这次启动登记过了吗"必须也在展示这一侧判。
 */
describe("主动气泡的展示闸门", () => {
  beforeEach(() => resetCompanionLaunchRegistrationForTests());

  it("登记之前闸门关着，登记之后才开，且记住登记时刻", () => {
    expect(isCompanionLaunchRegistered()).toBe(false);
    expect(companionLaunchRegisteredAt()).toBeNull();
    const at = Date.now();
    markCompanionLaunchRegistered(at);
    expect(isCompanionLaunchRegistered()).toBe(true);
    expect(companionLaunchRegisteredAt()).toBe(at);
  });

  it("只认第一次：后来的重复登记不会把时刻往后推", () => {
    markCompanionLaunchRegistered(1_000);
    markCompanionLaunchRegistered(2_000);
    expect(companionLaunchRegisteredAt()).toBe(1_000);
  });

  it("登记会通知订阅者，退订之后不再收到", () => {
    let notified = 0;
    const unsubscribe = subscribeCompanionLaunchRegistration(() => { notified += 1; });
    markCompanionLaunchRegistered();
    expect(notified).toBe(1);
    unsubscribe();
    resetCompanionLaunchRegistrationForTests();
    markCompanionLaunchRegistered();
    expect(notified).toBe(1);
  });

  it("一个订阅者抛错不拖住其余订阅者", () => {
    let second = 0;
    subscribeCompanionLaunchRegistration(() => { throw new Error("boom"); });
    subscribeCompanionLaunchRegistration(() => { second += 1; });
    expect(() => markCompanionLaunchRegistered()).not.toThrow();
    expect(second).toBe(1);
  });

  /**
   * 接线守卫：闸门本身算得对，不代表真的挂上了。三条线断任何一条，
   * 表现都是"上一次启动的问候又冒充这次的问候"。
   */
  it("登记、重读、展示三个端点都接在同一条闸门上", () => {
    const awareness = readFileSync(new URL("../companion-pages/use-companion-awareness.ts", import.meta.url), "utf8");
    const projection = readFileSync(new URL("../companion-pages/companion-home-projection.tsx", import.meta.url), "utf8");
    const presence = readFileSync(new URL("../../components/companion/bubble/CompanionPresence.tsx", import.meta.url), "utf8");
    // ① 这次启动的 app.started 拿到回执之后才登记。
    expect(awareness).toMatch(/topic: "app\.started"[\s\S]{0,240}markCompanionLaunchRegistered\(\)/);
    // ② 投影提供方在登记时重读一次，并给每份负载打上到手时刻。
    expect(projection).toMatch(/subscribeCompanionLaunchRegistration\(\(\) => reload\(\)\)/);
    expect(projection).toMatch(/projectionFetchedAt: Date\.now\(\)/);
    // ③ 展示前要求"负载到手晚于登记"。
    expect(presence).toMatch(/projectionFetchedAt < launchRegisteredAt\) return;/);
  });
});
