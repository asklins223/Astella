// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotebookCardEntry } from "../notebook-card-entry";
import { NotebookLearningPage } from "../notebook-learning-page";

afterEach(cleanup);
/**
 * 入口的可见文字是**按下去会去哪**，`aria-label` 里的「学习卡：X」是**阶段**。
 * 两者分开钉：阶段那一半覆盖 14 个状态里的代表值，去处那一半覆盖三种去处。
 *
 * `failed` 这一档过去单说一句「查看失败原因」，现在并进「查看生成进度」——
 * 去处没变（都是那一轮的工位，那里本来就写着失败原因和重试），而状态已经由
 * 旁边那颗状态字和 `aria-label` 说了。入口再说一遍，就把「去哪」和「现在什么
 * 状态」挤进了同一个词里。
 */
it.each([["review_ready", "待激活", "审核学习卡"], ["activated", "已完成", "查看学习卡"], ["failed", "失败", "查看生成进度"], ["queued", "排队中", "查看生成进度"]])("学习卡入口显示真实 %s 状态并可打开任务", (status, label, action) => {
  const open = vi.fn();
  const view = render(<NotebookCardEntry status={status} title="查看这次学习卡任务" onClick={open} />);
  fireEvent.click(view.getByRole("button", { name: `学习卡：${label}` }));
  expect(view.getByRole("status").textContent).toBe(label);
  expect(view.getByText(action)).toBeTruthy();
  expect(open).toHaveBeenCalledOnce();
});
/**
 * 这一叠结束且没保存时，入口是**重新做一份**，不该说成「去查看」。
 *
 * 2026-10-04：这一格只剩一颗按钮，"没在发生任何事"就由**不传 status** 表达，
 * 文字恒为「生成学习卡」——它按下去开的是「这次想怎么练？」，不是某一轮的工位。
 * 落点的完整判据在 `note-card-generation-entry` 的用例里。
 */
it("没有正在发生的那一批时，入口说「生成学习卡」而不是「查看…」", () => {
  const open = vi.fn();
  const view = render(<NotebookCardEntry title="先说这次想怎么练，选完就开始生成" onClick={open} />);
  expect(view.getByText("生成学习卡")).toBeTruthy();
  expect(view.queryByText(/查看/)).toBeNull();
  // 无障碍名直接就是可见文字，不宣称某一轮还开着。
  expect(view.getByRole("button", { name: "生成学习卡" })).toBeTruthy();
});
it("准备页区分读取与生成阶段，首次生成、失败重试、继续阅读各有实际动作", () => {
  const prepare = vi.fn(), retry = vi.fn(), body = vi.fn();
  const props = { kind: "overview" as const, title: "复利", version: 3, onPrepare: prepare, onBody: body, onRetry: retry };
  const view = render(<NotebookLearningPage {...props} state="empty" />);
  expect(view.getByRole("heading", { name: "这篇还没有速看内容" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "生成速看内容" })); expect(prepare).toHaveBeenCalledOnce();
  view.rerender(<NotebookLearningPage {...props} state="queued" />);
  expect(view.getByRole("status").textContent).toContain("等待处理");
  expect(view.queryByRole("button", { name: "生成速看内容" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "继续读原文" })); expect(body).toHaveBeenCalledOnce();
  view.rerender(<NotebookLearningPage {...props} state="loading" />);
  expect(view.getByRole("heading", { name: "正在翻找已有内容" })).toBeTruthy();
  expect(view.getByRole("status").textContent).toContain("已有的内容");
  view.rerender(<NotebookLearningPage {...props} state="failed" error="网络暂时不可用" />);
  expect(view.getByText("网络暂时不可用")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "再试一次" })); expect(retry).toHaveBeenCalledOnce();
});
it.each(["overview", "recall", "expansion"] as const)("%s 的未知失败有可读说明和恢复入口", (kind) => {
  const retry = vi.fn();
  const view = render(<NotebookLearningPage kind={kind} title="复利" version={2} state="failed" error="unknown"
    onPrepare={vi.fn()} onBody={vi.fn()} onRetry={retry} />);
  expect(view.getByText("原文还在，已有内容也会保留。可以重新试一次。")).toBeTruthy();
  expect(view.queryByText("unknown")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "再试一次" }));
  expect(retry).toHaveBeenCalledOnce();
});

it.each(["overview", "recall", "expansion"] as const)("%s 的外发策略拒绝引导去设置，设置完成后仍可重试", (kind) => {
  const settings = vi.fn(), retry = vi.fn();
  const view = render(<NotebookLearningPage kind={kind} title="二分查找" version={2} state="failed" error="ai_data_policy_denied"
    onPrepare={vi.fn()} onBody={vi.fn()} onRetry={retry} onSettings={settings} />);
  expect(view.getByText(/账号的数据外发策略阻止/)).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "去设置" }));
  expect(settings).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "设置好了，再试一次" }));
  expect(retry).toHaveBeenCalledOnce();
});
