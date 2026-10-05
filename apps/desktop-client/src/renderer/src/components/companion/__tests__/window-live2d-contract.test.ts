import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WINDOW_LIVE2D_ASSETS,
  WINDOW_LIVE2D_MODEL_REGISTRY,
  WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS,
  WindowLive2DPerformanceRotation,
  expressionForWindowLive2DEmotion,
  isApprovedWindowLive2DManifest,
  isWindowLive2DModelId,
  motionForWindowLive2DEmotion,
  motionForWindowLive2D,
  momentCueForWindowLive2D,
  parameterValuesForWindowLive2D,
  presentationForCharacterCueIntent,
  propParameterValuesForWindowLive2D,
} from "../window-live2d-contract.ts";

/** 读一个参数，省掉每个用例都写一遍 find。 */
function parameterValue(
  values: readonly { readonly parameter: string; readonly value: number }[],
  parameter: string,
): number | undefined {
  return values.find((value) => value.parameter === parameter)?.value;
}

describe("window Live2D policy", () => {
  it("uses real head parts from the whale asset and excludes tail/table parts", () => {
    const parts = JSON.parse(readFileSync(
      new URL("../../../../public/assets/companion/live2d-v3/whale/c_0120.cdi3.json", import.meta.url),
      "utf8",
    )).Parts as { Id: string; Name: string }[];
    const headParts = WINDOW_LIVE2D_MODEL_REGISTRY.whale.layoutHeadParts!;
    expect(headParts.length).toBeGreaterThan(0);
    for (const id of headParts) expect(parts.some(part => part.Id === id), id).toBe(true);
    const selected = parts.filter(part => headParts.includes(part.Id));
    expect(selected.some(part => /头发|发型|Hair/.test(part.Name))).toBe(true);
    expect(selected.some(part => /尾巴|桌|Tail|Desk/.test(part.Name))).toBe(false);
  });

  it("fails closed when bundled model license approval is absent", () => {
    const whale = WINDOW_LIVE2D_MODEL_REGISTRY.whale.manifestExpectation;
    const approved = {
      schemaVersion: 1,
      modelId: whale.modelId,
      status: whale.status,
      ownerApproved: { by: "Owner", date: "2026-09-20" },
      modelLicense: {
        name: "《使用须知.txt》",
        acceptanceRequired: true,
        commercialReleaseAllowed: true,
      },
    };
    expect(isApprovedWindowLive2DManifest(approved, whale)).toBe(true);
    // 缺省验收要求 = 默认形态，与显式传入同一个。
    expect(isApprovedWindowLive2DManifest(approved)).toBe(true);
    expect(isApprovedWindowLive2DManifest({ ...approved, ownerApproved: null }, whale)).toBe(false);
    expect(isApprovedWindowLive2DManifest({
      ...approved,
      modelLicense: { ...approved.modelLicense, commercialReleaseAllowed: false },
    }, whale)).toBe(false);
    // 已删除的形态即使带着完整 ownerApproved 也通不过：modelId 对不上就 fail closed。
    expect(isApprovedWindowLive2DManifest({
      ...approved,
      modelId: "companion-live2d-mao-pro-v1",
    }, whale)).toBe(false);
    expect(isApprovedWindowLive2DManifest({
      ...approved,
      modelId: "companion-live2d-seethrough-v2",
      status: "development",
    }, whale)).toBe(false);
  });

  it("only accepts the one registered form and silently falls back off it", () => {
    expect(isWindowLive2DModelId("whale")).toBe(true);
    // 2026-10-04 删除 mao / 小彩 后，旧 localStorage 里的这两个值必须判为非法，
    // 由 room-store 的 merge 静默打回大肥鱼，不能让伴星进不可用状态。
    expect(isWindowLive2DModelId("mao-pro")).toBe(false);
    expect(isWindowLive2DModelId("seethrough")).toBe(false);
    expect(isWindowLive2DModelId("orb")).toBe(false);
    expect(isWindowLive2DModelId(undefined)).toBe(false);
    expect(Object.keys(WINDOW_LIVE2D_MODEL_REGISTRY)).toEqual(["whale"]);
  });

  it("maps whale to its own motion groups and expressions", () => {
    expect(motionForWindowLive2D("idle", "whale")).toEqual({ group: "Idle", index: 0 });
    expect(motionForWindowLive2D("invite", "whale")).toBeNull();
    expect(motionForWindowLive2DEmotion("happy", "whale")).toBeNull();
    expect(expressionForWindowLive2DEmotion("happy", "whale")).toBe("happy");
    expect(expressionForWindowLive2DEmotion("surprised", "whale")).toBe("surprised");
    expect(expressionForWindowLive2DEmotion("neutral", "whale")).toBeNull();
    expect(WINDOW_LIVE2D_MODEL_REGISTRY.whale.lipSyncParameter).toBe("ParamMouthOpenY");
  });

  it("表演池轮播：一袋之内不重复，重洗后不接上一条", () => {
    const pool = ["a", "b", "c", "d", "e", "f"].map((name) => ({
      kind: "expression" as const,
      name,
    }));
    const rotation = new WindowLive2DPerformanceRotation(pool);
    const drawn = Array.from({ length: pool.length + 1 }, () => rotation.next()!);
    const firstBag = drawn.slice(0, pool.length);

    // 抽完整袋 = 全部条目各演一次，不存在"几个月演不到一次"的动作。
    expect(firstBag.map((cue) => (cue.kind === "expression" ? cue.name : ""))
      .sort()).toEqual(pool.map((cue) => cue.name).sort());
    // 上一袋的尾巴和本袋的开头不会是同一条（连着两条一样会被读成"卡带"）。
    expect(drawn[pool.length]).not.toBe(drawn[pool.length - 1]);
    expect(new WindowLive2DPerformanceRotation([]).next()).toBeNull();
  });

  it("表情写过的参数在表情有效期间不再被眨眼/FACS 覆盖", () => {
    const owned = new Set(["ParamEyeLOpen", "ParamEyeROpen", "ParamMouthUp"]);
    const values = parameterValuesForWindowLive2D({
      presentation: "celebrate",
      nowMs: 1_000,
      voiceLevel: 0,
      emotion: { emotion: "happy", intensity: 1 },
      expressionOwnedParameters: owned,
    });

    expect(values.some((value) => value.parameter === "ParamEyeLOpen")).toBe(false);
    expect(values.some((value) => value.parameter === "ParamEyeROpen")).toBe(false);
    expect(values.some((value) => value.parameter === "ParamMouthUp")).toBe(false);
    // 眉毛 FACS 与呼吸不在这张表情里，照常写。
    expect(values.some((value) => value.parameter === "ParamBrowLY")).toBe(true);
    expect(values.some((value) => value.parameter === "ParamBreath")).toBe(true);
    // 说话时口型不放手：嘴要跟着声音动，静态嘴形让位。
    expect(parameterValuesForWindowLive2D({
      presentation: "speak", nowMs: 1_000, voiceLevel: 0.6, expressionOwnedParameters: owned,
    }).some((value) => value.parameter === "ParamMouthUp")).toBe(true);
    // 没有表情时一切照旧。
    expect(parameterValuesForWindowLive2D({
      presentation: "idle", nowMs: 1_000, voiceLevel: 0,
    }).some((value) => value.parameter === "ParamEyeLOpen")).toBe(true);
  });

  it("writes whale lipsync into ParamMouthOpenY instead of ParamA", () => {
    const values = parameterValuesForWindowLive2D({
      presentation: "speak",
      nowMs: 1_000,
      voiceLevel: 0.6,
      lipSyncParameter: WINDOW_LIVE2D_MODEL_REGISTRY.whale.lipSyncParameter,
    });
    expect(values.find((value) => value.parameter === "ParamMouthOpenY")?.value).toBeCloseTo(0.6);
    // whale 的模型里根本没有 ParamA（mao 才有）；写它等于往 Cubism Core 塞野参数。
    expect(values.some((value) => value.parameter === "ParamA")).toBe(false);
    // 缺省口型参数跟随注册表，不是写死的字面量。
    expect(parameterValuesForWindowLive2D({
      presentation: "speak", nowMs: 1_000, voiceLevel: 0.6,
    }).some((value) => value.parameter === "ParamMouthOpenY")).toBe(true);
  });

  it("只声明所有形态共用的运行时；模型自身路径归注册表管", () => {
    expect(Object.keys(WINDOW_LIVE2D_ASSETS)).toEqual(["vendorScripts"]);
    for (const path of WINDOW_LIVE2D_ASSETS.vendorScripts) {
      expect(path).not.toContain("orb");
      expect(path).not.toContain("half-idle");
    }
    // 已删除的形态的资产不许再被任何一处登记。
    const declared = JSON.stringify([
      Object.values(WINDOW_LIVE2D_MODEL_REGISTRY).map((descriptor) => [descriptor.manifest, descriptor.model]),
      WINDOW_LIVE2D_ASSETS.vendorScripts,
    ]);
    expect(declared).not.toContain("live2d-v1");
    expect(declared).not.toContain("live2d-v2");
    expect(declared).not.toContain("mao");
    expect(declared).not.toContain("seethrough");
  });

  it("clamps external voice amplitude before it reaches Cubism Core", () => {
    const values = parameterValuesForWindowLive2D({
      presentation: "speak",
      nowMs: 1_000,
      voiceLevel: 12,
    });

    expect(values.find((value) => value.parameter === "ParamMouthOpenY")?.value).toBe(1);
    expect(values.every((value) => Number.isFinite(value.value))).toBe(true);
  });

  it("lets an emotion own FACS while lipsync still owns the mouth", () => {
    const values = parameterValuesForWindowLive2D({
      presentation: "celebrate",
      nowMs: 1_000,
      voiceLevel: 0.75,
      emotion: { emotion: "concerned", intensity: 0.5 },
    });

    expect(values.find((value) => value.parameter === "ParamMouthUp")?.value).toBeCloseTo(0.15);
    expect(values.find((value) => value.parameter === "ParamMouthOpenY")?.value).toBeCloseTo(0.75);
  });

  it("idle 时口型参数一个字都不写：没张嘴就不该动嘴", () => {
    const values = parameterValuesForWindowLive2D({
      presentation: "idle",
      nowMs: 1_000,
      voiceLevel: 0,
      emotion: null,
    });

    expect(values.some((value) => value.parameter === "ParamMouthOpenY")).toBe(false);
    expect(values.some((value) => value.parameter === "ParamMouthForm")).toBe(false);
    expect(values.some((value) => value.parameter === "ParamMouthUp")).toBe(false);
  });

  describe("「看向手边」（方案 §5 第 9 项）", () => {
    const idleBodyAngleX = (nowMs: number) => Math.sin(nowMs / 2_400) * 2;

    it("没有冲量时 ParamBodyAngleX 逐帧等于静息摇摆（本次改动不改变既有画面）", () => {
      for (const nowMs of [0, 600, 1_000, 2_400, 5_000]) {
        const values = parameterValuesForWindowLive2D({
          presentation: "idle",
          nowMs,
          voiceLevel: 0,
        });
        expect(parameterValue(values, "ParamBodyAngleX")).toBeCloseTo(idleBodyAngleX(nowMs));
      }
    });

    it("工具刚开始执行时侧身 3 度，并在 1.5s 内二次缓出回到静息值", () => {
      const atMs = 0;
      // 起点：冲量满幅，静息摇摆此刻正好是 0。
      expect(parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle", nowMs: 0, voiceLevel: 0, toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX")).toBeCloseTo(-3);

      // 中点：(1 - 0.5)^2 = 0.25，偏移收窄到 -0.75。
      const half = WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS / 2;
      expect(parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle", nowMs: half, voiceLevel: 0, toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX")).toBeCloseTo(idleBodyAngleX(half) - 0.75);
    });

    it("冲量窗口结束时与静息摇摆严丝合缝，不会回弹", () => {
      const atMs = 0;
      const lastFrame = WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS - 1;
      const atEnd = parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle", nowMs: lastFrame, voiceLevel: 0, toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX");
      const afterEnd = parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle",
        nowMs: WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS,
        voiceLevel: 0,
        toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX");

      expect(atEnd).toBeCloseTo(idleBodyAngleX(lastFrame), 3);
      expect(afterEnd).toBeCloseTo(idleBodyAngleX(WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS));
    });

    it("未来时间戳与非有限值都当作没有冲量，不写入非法参数", () => {
      for (const toolAttentionAtMs of [Number.NaN, Number.POSITIVE_INFINITY, 4_000]) {
        const values = parameterValuesForWindowLive2D({
          presentation: "idle", nowMs: 1_000, voiceLevel: 0, toolAttentionAtMs,
        });
        expect(parameterValue(values, "ParamBodyAngleX")).toBeCloseTo(idleBodyAngleX(1_000));
        expect(values.every((value) => Number.isFinite(value.value))).toBe(true);
      }
    });

    it("冲量不与口型/表情抢参数：它只动 ParamBodyAngleX", () => {
      const withImpulse = parameterValuesForWindowLive2D({
        presentation: "speak", nowMs: 0, voiceLevel: 0.6, toolAttentionAtMs: 0,
      });
      expect(parameterValue(withImpulse, "ParamMouthOpenY")).toBeCloseTo(0.6);
      expect(parameterValue(withImpulse, "ParamBodyAngleX")).toBeCloseTo(-3);
    });
  });

  it("每条 cue 的 intent 都落到一个姿势，服务端说的和身体做的不再两套话", () => {
    expect(presentationForCharacterCueIntent("think")).toBe("think");
    expect(presentationForCharacterCueIntent("explain")).toBe("speak");
    expect(presentationForCharacterCueIntent("listen")).toBe("listen");
    expect(presentationForCharacterCueIntent("acknowledge")).toBe("invite");
    expect(presentationForCharacterCueIntent("encourage")).toBe("encourage");
    expect(presentationForCharacterCueIntent("celebrate")).toBe("celebrate");
    expect(presentationForCharacterCueIntent("uncertain")).toBe("uncertain");
    expect(presentationForCharacterCueIntent("warn")).toBe("uncertain");
    expect(presentationForCharacterCueIntent("sleep")).toBe("idle");
    // 协议之外的值不猜姿势。
    expect(presentationForCharacterCueIntent("party" as never)).toBeNull();
    expect(presentationForCharacterCueIntent(null)).toBeNull();
  });

  it("任务时刻各有表演：接活戴眼镜、成功比耶、失败吐魂、等确认冒问号、收工摘眼镜", () => {
    expect(momentCueForWindowLive2D("working", "whale")).toEqual({ costume: "glasses-round" });
    expect(momentCueForWindowLive2D("tool_succeeded", "whale")).toEqual({
      motion: { group: "Bubble", index: 0 },
      overlay: "peace",
      costume: null,
      holdMs: 3_000,
    });
    expect(momentCueForWindowLive2D("tool_failed", "whale")?.overlay).toBe("soul");
    expect(momentCueForWindowLive2D("run_failed", "whale")?.overlay).toBe("soul");
    expect(momentCueForWindowLive2D("awaiting_confirmation", "whale")?.overlay).toBe("question");
    expect(momentCueForWindowLive2D("reminder", "whale")?.overlay).toBe("surprised");
    expect(momentCueForWindowLive2D("task_started", "whale")?.motion)
      .toEqual({ group: "Spray", index: 0 });
    // 一轮说完必须把眼镜摘下来，否则一副圆脸眼镜挂到下一次对话。
    expect(momentCueForWindowLive2D("reply_completed", "whale")).toEqual({ costume: null });
    expect(momentCueForWindowLive2D("space_arrived", "whale")).toEqual({ motion: { group: "Bubble", index: 0 }, costume: null });
  });

  it("道具层：穿着写资产值，脱了写 0，脸部参数与表情自己的参数都不碰", () => {
    const declared = {
      "glasses-round": [{ parameter: "ParamCheek70", value: 1, blend: "Add" }],
      flowers: [{ parameter: "ParamCheek26", value: 360, blend: "Add" }],
      "闭眼式": [{ parameter: "ParamEyeLOpen", value: 0, blend: "Add" }],
      mixed: [{ parameter: "ParamCheek81", value: 1, blend: "Multiply" }],
    };
    const wearing = propParameterValuesForWindowLive2D({
      costume: declared["glasses-round"],
      overlay: declared.flowers,
      declared,
    });
    expect(wearing.find((value) => value.parameter === "ParamCheek70")?.value).toBe(1);
    // 作者写多少就是多少（花是绕圈的旋转参数），不折成 0..1。
    expect(wearing.find((value) => value.parameter === "ParamCheek26")?.value).toBe(360);
    // 闭眼参数永远不进道具层，Multiply 的装饰也不（它要乘的是别人的底值）。
    expect(wearing.some((value) => value.parameter === "ParamEyeLOpen")).toBe(false);
    expect(wearing.some((value) => value.parameter === "ParamCheek81")).toBe(false);

    const naked = propParameterValuesForWindowLive2D({ costume: null, overlay: null, declared });
    // 没穿的写 0：这样才收得回去。
    expect(naked.find((value) => value.parameter === "ParamCheek70")?.value).toBe(0);
    // 脸上那张表情自己写了感叹号，道具层就不抢同一个参数。
    const reserved = propParameterValuesForWindowLive2D({
      costume: null,
      overlay: null,
      declared: { surprised: [{ parameter: "ParamCheek75", value: 1, blend: "Add" }] },
      reservedParameters: new Set(["ParamCheek75"]),
    });
    expect(reserved).toEqual([]);
  });
});
