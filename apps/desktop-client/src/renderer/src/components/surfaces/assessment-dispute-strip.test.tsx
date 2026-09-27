// @vitest-environment jsdom

/**
 * 判定的异议那张纸签（39 §14.2、§16.11、§16.25）。
 *
 * 这一族用例钉的是**三句用户承诺**——此前服务端六条路由齐了、`server.ts:380`
 * 也注册了，而客户端对这套路由的调用数是 **0**。结果页已经印着「也可以现在结束
 * 争议、把这一项暂不安排」，那句话向用户承诺了一个**点不到的地方**。
 * §16.11（无来源观点与争议答案）、§16.22、§16.25（系统误判与用户补答）三条验收
 * 都要求用户能提出或查看异议，按现状它们不是"没做好"，是**无法验收**。
 *
 * 焦点不在"点了会不会发请求"，而在三处**说出来的话**：
 *  - 理由要念得出来（§14.2 明写"界面要能念出理由"）；
 *  - 读不到**不能说成"你没有异议"**（那会让入口在网络坏掉时消失，而用户以为
 *    系统没记录——§13.4「异常时仍能知道发生了什么」）；
 *  - `hold_unavailable` 不能显示成"已暂不安排"（假回执）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assessmentDisputeViewV2Schema,
  type AssessmentDisputeStatusV2,
} from "@ailearn/shared/assessment-dispute-rules-v2";
import { AssessmentDisputeStrip } from "./assessment-dispute-strip";

const ASSESSMENT_ID = "00000000-0000-4000-8000-0000000000a1";
const DISPUTE_ID = "00000000-0000-4000-8000-0000000000d1";

const disputeView = (over: Record<string, unknown> = {}) => assessmentDisputeViewV2Schema.parse({
  version: 2,
  id: DISPUTE_ID,
  assessmentId: ASSESSMENT_ID,
  artifactId: "00000000-0000-4000-8000-0000000000a2",
  artifactRevision: 1,
  objectiveId: "00000000-0000-4000-8000-0000000000a3",
  kind: "explanation_faulty",
  status: "open",
  statement: "第二步的因果我认为是反的：先读页再定位，不是先定位再读页。",
  supplement: null,
  recheckOutcome: null,
  recheckReason: null,
  corrections: [],
  createdAt: "2026-09-24T09:00:00.000Z",
  resolvedAt: null,
  ...over,
});

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

type Api = {
  get: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  supplement: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

let api: Api;

function stub(dispute: unknown, overrides: Partial<Record<keyof Api, unknown>> = {}) {
  api = {
    get: vi.fn(async () => ok({ version: 2, dispute })),
    open: vi.fn(async () => ok({ version: 2, disputeId: DISPUTE_ID, status: "open", created: true })),
    supplement: vi.fn(async () => ok({ accepted: true })),
    close: vi.fn(async () => ok({
      version: 2,
      disputeId: DISPUTE_ID,
      status: "closed_held",
      outcome: "hold_objective",
      dismissedPendingSchedules: 2,
    })),
    ...overrides,
  } as Api;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).ailearn = { assessmentDispute: api };
}

const renderStrip = () => render(
  <AssessmentDisputeStrip assessmentId={ASSESSMENT_ID} workspaceEpoch={1} />,
);

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  cleanup();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).ailearn;
});

describe("判定的异议", () => {
  it("没有异议时给一颗入口，且理由是必填的", async () => {
    stub(null);
    renderStrip();
    const entry = await screen.findByRole("button", { name: "我不同意这次判定" });
    fireEvent.click(entry);

    // §14.2：没有理由的"我不同意"进不了复核，所以空着提交要**当场**说清楚，
    // 而不是发一次再让服务端回 400。
    fireEvent.click(screen.getByRole("button", { name: "记下这份异议" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("先写一句为什么不同意"));
    expect(api.open).not.toHaveBeenCalled();
  });

  it("提交时带上种类与理由，并按服务端回执重读那一份", async () => {
    stub(null);
    renderStrip();
    fireEvent.click(await screen.findByRole("button", { name: "我不同意这次判定" }));
    fireEvent.click(screen.getByRole("radio", { name: "题目有问题" }));
    fireEvent.change(screen.getByLabelText("为什么不同意（必填）"), {
      target: { value: "题干问的是写时复制，读时复制没被问过。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "记下这份异议" }));

    await waitFor(() => expect(api.open).toHaveBeenCalledTimes(1));
    expect(api.open.mock.calls[0][0].request).toMatchObject({
      assessmentId: ASSESSMENT_ID,
      kind: "item_faulty",
      statement: "题干问的是写时复制，读时复制没被问过。",
    });
    // 写完**重新读服务端那一份**，而不是就地改本地 state——理由是屏上要念的
    // 必须是库里存下来的那一条。
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it("已开的一份把理由逐条念出来（§14.2「界面要能念出理由」）", async () => {
    stub(disputeView({
      status: "recheck_undetermined",
      recheckOutcome: "undetermined",
      recheckReason: "两版评分条件都说得通，无法排除。",
      supplement: "补充：我是按第二个条件写的。",
    }));
    renderStrip();

    expect(await screen.findByText(/第二步的因果我认为是反的/)).toBeTruthy();
    expect(screen.getByText("补充：我是按第二个条件写的。")).toBeTruthy();
    expect(screen.getByText(/两版评分条件都说得通/)).toBeTruthy();
    // 种类与时间也念出来，否则用户不知道自己当初提的是哪一类。
    expect(screen.getByText(/解释不对/)).toBeTruthy();
  });

  it("复核仍无法判断时不得读成「已结束」或「维持原判」（§14.2 末句）", async () => {
    stub(disputeView({ status: "recheck_undetermined", recheckOutcome: "undetermined", recheckReason: "两边都说得通。" }));
    const { container } = renderStrip();
    const text = (await screen.findByText(/未决/)).textContent ?? "";
    expect(text).not.toMatch(/已结束|已关闭/);
    expect(container.querySelector(".assessment-dispute-strip")).toHaveProperty("dataset.status", "recheck_undetermined");
  });

  it("结束并暂不安排：一颗按钮两格，回执把撤下几条念出来", async () => {
    stub(disputeView());
    renderStrip();
    fireEvent.click(await screen.findByRole("button", { name: "结束异议并暂不安排" }));

    await waitFor(() => expect(api.close).toHaveBeenCalledTimes(1));
    expect(api.close.mock.calls[0][0].request).toMatchObject({ assessmentId: ASSESSMENT_ID, holdObjective: true });
    // 撤下几条是这颗按钮**唯一**看得见的副作用，不报它就等于"什么也没做"。
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("撤下了此刻排着的 2 条回访"));
  });

  it("勾掉那一格时只结束争议，不动排期", async () => {
    stub(disputeView());
    renderStrip();
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "结束这份异议" }));
    await waitFor(() => expect(api.close).toHaveBeenCalledTimes(1));
    expect(api.close.mock.calls[0][0].request).toMatchObject({ holdObjective: false });
  });

  /**
   * 第三档是最容易写成假回执的一格：争议**真的结束了**，但排除没落上。
   * 显示成"已暂不安排"就是在告诉用户一件库里没有的事；而 §14.2 的出口是
   * "可结束"，所以也不能因此把整个结束动作卡死。
   */
  it("排除没落上时如实说「没能设成暂不安排」，不假装成功", async () => {
    stub(disputeView(), {
      close: vi.fn(async () => ok({
        version: 2,
        disputeId: DISPUTE_ID,
        status: "closed_held",
        outcome: "hold_unavailable",
        dismissedPendingSchedules: 0,
      })),
    });
    renderStrip();
    fireEvent.click(await screen.findByRole("button", { name: "结束异议并暂不安排" }));

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toMatch(/没能设成「暂不安排」/);
    expect(notice.textContent).toMatch(/仍可能出现在复习里/);
  });

  it("读不到就说读不到，并给重试；绝不显示成「你没有异议」", async () => {
    stub(null, { get: vi.fn(async () => { throw new Error("boom"); }) });
    renderStrip();

    // §13.4：读失败**不能**退化成"没有争议"——那会让入口在网络坏掉时消失，
    // 而用户会以为系统没有记录。
    expect(await screen.findByText("没能读到这次判定的异议记录")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "我不同意这次判定" })).toBeNull();
    expect(screen.getByRole("button", { name: "再读一次" })).toBeTruthy();
  });

  it("修正那一档不再给「补充说明」，避免反复要求用户接受同一判定", async () => {
    const statuses: AssessmentDisputeStatusV2[] = ["recheck_corrected", "closed_held"];
    for (const status of statuses) {
      cleanup();
      stub(disputeView({ status, recheckOutcome: status === "recheck_corrected" ? "corrected" : null }));
      renderStrip();
      await screen.findByText(/修正了原来的判定|已结束/);
      expect(screen.queryByRole("button", { name: "补充说明" })).toBeNull();
      // 收尾之后也不该再有一颗「结束」。
      expect(screen.queryByRole("button", { name: /结束异议/ })).toBeNull();
    }
  });
});
