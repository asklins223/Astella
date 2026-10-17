// @vitest-environment jsdom
/**
 * 速看纸签的等待口径（2026-10-16 线上：一次速看单发 242 s，纸面从头到尾只写
 * 「正在整理整篇笔记」——用户看不出是在走还是死了，也没有出路）。
 *
 * 钉住三件事：等待时长要看得见；慢档只说实话不催动作；久档才给"重来一份"，
 * 而在那之前不给——服务端会挡下重复发起，先放按钮等于放一个按不动的按钮。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NOTE_TASK_SLOW_MS, NOTE_TASK_STALL_MS, TaskSlip } from "../generation/task-slip.tsx";

const START = "2026-10-16T11:32:06.000Z";

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** 把"现在"设到开始后的第 ms 毫秒。 */
function waited(ms: number) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.parse(START) + ms));
}

it("正在整理时说出已经等了多久，并保留「可以继续读」", () => {
  waited(10_000);
  render(<TaskSlip kind="overview" status="running" runningSince={START} />);
  expect(screen.getByText("正在整理整篇笔记")).toBeTruthy();
  expect(screen.getByText("可以继续读或离开，回来仍能在这里查看结果。")).toBeTruthy();
  expect(screen.getByText("已等 10 秒")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重新整理" })).toBeNull();
});

it("计时器自己往前走，纸面不必每秒重渲", () => {
  waited(0);
  render(<TaskSlip kind="overview" status="running" runningSince={START} />);
  expect(screen.getByText("已等 0 秒")).toBeTruthy();
  act(() => { vi.advanceTimersByTime(3_000); });
  expect(screen.getByText("已等 3 秒")).toBeTruthy();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(screen.getByText("已等 1 分 3 秒")).toBeTruthy();
});

it("超过慢档就直说比平时久，但这一档不催用户做任何事", () => {
  waited(NOTE_TASK_SLOW_MS + 1_000);
  render(<TaskSlip kind="overview" status="running" runningSince={START} />);
  expect(screen.getByText("这次比平时久。可以继续读或离开，结果出来仍会留在这里。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重新整理" })).toBeNull();
});

it("久到不像还在正常干活时，给出重来一份的出路", () => {
  waited(NOTE_TASK_STALL_MS + 1_000);
  const onRetry = vi.fn();
  render(<TaskSlip kind="overview" status="running" runningSince={START} onRetry={onRetry} />);
  expect(screen.getByText("这次等得太久了。正文没有受影响，可以重新整理一份。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新整理" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it("没给开始时间的动作一个字都不变（讲解／拓展／演示的纸签行为保持原样）", () => {
  render(<TaskSlip kind="annotation" status="running" />);
  expect(screen.getByText("正在把这句话讲清楚")).toBeTruthy();
  expect(screen.getByText("可以继续读或离开，回来仍能在这里查看结果。")).toBeTruthy();
  expect(screen.queryByText(/已等/)).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

it("失败档仍是原来的一键重试", () => {
  const onRetry = vi.fn();
  render(<TaskSlip kind="overview" status="failed" failureReason="unknown" onRetry={onRetry} />);
  expect(screen.getByText("这次没整理出来")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "再试一次" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});
