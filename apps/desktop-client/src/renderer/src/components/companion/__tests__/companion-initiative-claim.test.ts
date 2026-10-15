// @vitest-environment node

/**
 * **「她主动开口却没人接」在桌面这一侧的两条判据**（2026-10-14）。
 *
 * 库里 16 条主动投递（`assistant_deliveries` kind=system_event、dedupe_key=`initiative:…`）
 * 有 **11 条停在 `queued` 直到过期**——她说了，界面没接。桌面这边占两条独立的路：
 *
 * 1. **设备**：`CompanionPresence` 原来要求投递记录的设备会话与本设备**严格相等**才出声。
 *    那句"发给谁"来自观察那一刻的租约，而他手机上开着的原型页租约比桌面新，
 *    于是 10 条派给 browser 的话**两台设备都不念**——不是少一次，是永久沉默。
 * 2. **"闲下来"的判据**：`use-companion-awareness` 把裸的鼠标移动也算活动，
 *    手放着读同一页时指针飘一下就把安静清零，那道门两天只开过 1 次。
 *
 * 认领窗口那条在 worker 侧（`companion-initiative-delivery-source-guard.test.ts`），
 * 这条消息的落点也在 worker——这里只钉界面上会回退的两处接线。
 * 用源码判据是因为回退的形状是"看着一切正常、她就是不出声"，跑一遍界面发现不了。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (relative: string) => readFileSync(path.resolve(import.meta.dirname, relative), "utf8");

describe("派给别的设备那一句，桌面照样接", () => {
  it("认领不再按设备会话严格相等把人静音，但这句话确实被接走", () => {
    const text = source("../CompanionPresence.tsx");
    expect(text).not.toMatch(/deviceSessionId\s*[!=]==\s*identity\.deviceSessionId/);
    expect(text).toMatch(/await receiveInitiative\(delivery\)/);
  });
});

describe("「闲下来」按停止输入＋页面稳定判", () => {
  it("裸的鼠标移动不再清零——飘一下不算他还在做事", () => {
    const text = source("../../../app/use-companion-awareness.ts");
    expect(text).not.toMatch(/addEventListener\("pointermove"/);
    expect(text).toMatch(/addEventListener\("pointerdown", activity/);
    expect(text).toMatch(/addEventListener\("wheel", activity/);
  });

  it("门槛由 shared 一处声明，不在界面里另算一个时长", async () => {
    const { COMPANION_QUIET_PRESENCE_AFTER_MS } = await import("@astella/shared/companion-awareness-idle");
    expect(COMPANION_QUIET_PRESENCE_AFTER_MS).toBeLessThanOrEqual(3 * 60_000);
    expect(COMPANION_QUIET_PRESENCE_AFTER_MS).toBeGreaterThanOrEqual(60_000);
  });
});
