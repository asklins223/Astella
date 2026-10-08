// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readWritingPreferences,
  updateWritingPreferences,
  useWritingPreferences,
  writingPreferenceAttributes,
} from "../note-writing-preferences";

/**
 * 写作偏好此前由编辑工具栏里的组件命令式写回 workspace，而这块 DOM 在阅读／编辑／源码
 * 之间复用：点一次编辑再回阅读，阅读页就突然换一套字号（2026-10-08 用户报）。
 * 现在偏好归书桌自己，宿主渲染时带上，与当前是哪个视图无关。
 */
describe("写作偏好属于书桌，不属于某个视图", () => {
  beforeEach(() => localStorage.clear());

  it("认不出的纸面与字体落回默认，越界的字号行距宽度夹到边界", () => {
    localStorage.setItem("note-writing-preferences", JSON.stringify({ theme: "neon", font: "comic", size: 900, leading: 0, width: -5 }));
    expect(readWritingPreferences()).toMatchObject({ theme: "paper", font: "serif", size: 28, leading: 1.4, width: 520 });
    localStorage.setItem("note-writing-preferences", "{not json");
    expect(readWritingPreferences().size).toBe(18);
  });

  it("改一次偏好，在读的每一张书桌同时跟上，并写回存储", () => {
    const desk = renderHook(() => useWritingPreferences());
    const localFileDesk = renderHook(() => useWritingPreferences());
    act(() => updateWritingPreferences({ ...readWritingPreferences(), size: 21, theme: "night" }));
    expect(desk.result.current).toMatchObject({ size: 21, theme: "night" });
    expect(localFileDesk.result.current).toMatchObject({ size: 21, theme: "night" });
    expect(JSON.parse(localStorage.getItem("note-writing-preferences") ?? "{}")).toMatchObject({ size: 21 });
  });

  it("偏好落成书桌自己的属性与 CSS 变量，纸面与正文都读它", () => {
    expect(writingPreferenceAttributes({ theme: "night", font: "mono", size: 20, leading: 1.6, width: 900, focus: true, typewriter: false })).toMatchObject({
      "data-writing-theme": "night",
      "data-writing-font": "mono",
      "data-writing-focus": "true",
      "data-typewriter": "false",
      style: { "--writing-size": "20px", "--writing-leading": "1.6", "--writing-width": "900px" },
    });
  });

  it.each(["notebook-surface.tsx", "notebook-local-files.tsx"])("%s 的书桌节点自己带上偏好，不再等编辑工具栏挂载", (file) => {
    const source = readFileSync(join(resolve(import.meta.dirname, ".."), file), "utf8");
    expect(source).toContain("writingPreferenceAttributes(");
  });
});
