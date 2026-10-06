// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityPanel } from "../companion/companion-center-panels.tsx";
import { primaryActionLabel } from "../run/objective-state-copy.ts";
import {
  companionJourneyBootstrapSchema,
  type CompanionJourneyBootstrap,
} from "@astella/shared/companion-journey-contracts";
import {
  companionActivityDeliveryV1Schema,
  type CompanionActivityDeliveryV1,
} from "@astella/shared/companion-memory-desktop-contracts";
import {
  companionLearningContextV1Schema,
  type CompanionLearningContextV1,
} from "@astella/shared/companion-conversation-contracts";
import { useRoomStore } from "../../../app/room-store.ts";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";

/**
 * 伴星中心「动态」这一块登记给伴星读的是什么（39d W2-7）。
 *
 * 这一屏是**三段各说一句**（继续学习／伴星旅程／最近动态），所以 `state` 一律是
 * "这一行来自哪一段"（同一个字段只准有一个含义），投递自己那层"待处理／已失效"
 * 不混进来。收起的历史动态只登记条数；展开后按实际可见顺序登记历史行。
 */

type ActivityPanelProps = Parameters<typeof ActivityPanel>[0];

const noop = () => undefined;

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function bootstrap(overrides: Record<string, unknown> = {}): CompanionJourneyBootstrap {
  return companionJourneyBootstrapSchema.parse({
    invitation: {
      version: 2,
      userId: USER_ID,
      status: "accepted",
      offeredAt: null,
      decidedAt: null,
      deferredUntil: null,
      replayRequestedAt: null,
      revision: 1,
    },
    journey: null,
    ...overrides,
  });
}

function journey(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    journeyId: "33333333-3333-4333-8333-333333333333",
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    assistantSessionId: null,
    status: "active",
    branch: "own_material",
    currentStep: null,
    stepRevision: 0,
    dismissedNarrationSteps: [],
    refs: {},
    lastDomainEventId: null,
    pausedAt: null,
    pauseReason: null,
    resumeTokenRef: null,
    resumeExpiresAt: null,
    completionKind: null,
    error: null,
    revision: 1,
    ...overrides,
  };
}

function delivery(id: number, label: string, state: CompanionActivityDeliveryV1["state"], expired = false): CompanionActivityDeliveryV1 {
  return companionActivityDeliveryV1Schema.parse({
    version: 1,
    deliveryId: `44444444-4444-4444-8444-00000000000${id}`,
    inboxSequence: id,
    state,
    kind: "message",
    label,
    target: { kind: "none" },
    expired,
    createdAt: "2026-09-24T00:00:00.000Z",
    expiresAt: "2026-10-24T00:00:00.000Z",
  });
}

function timeline(items: CompanionActivityDeliveryV1[] = []) {
  return {
    version: 1 as const,
    items,
    nextCursor: 0,
    serverTime: "2026-09-25T00:00:00.000Z",
  };
}

const unavailableSection = { ok: false, message: "服务暂时不可用" } as const;

const RESUME_RUN_ID = "55555555-5555-4555-8555-555555555555";
const RESUME_OBJECTIVE_ID = "66666666-6666-4666-8666-666666666666";

/**
 * 服务端 `resolveCompanionLearningContext` 的那一份 learning context，按合同形状给
 * （走 schema 而不是手写对象：这一族字段加一个就得改这里，编出来的假形状测不到真屏）。
 */
function learningContextWithResume(
  overrides: Partial<CompanionLearningContextV1> = {},
): CompanionLearningContextV1 {
  return companionLearningContextV1Schema.parse({
    version: 1,
    contextRevision: "a".repeat(64),
    learningRunResumeCandidate: {
      candidateId: "learning_run_resume",
      runId: RESUME_RUN_ID,
      title: "为什么走了索引还是慢",
      targetSummary: "说得出索引失效的两种情形",
      impactSummary: "恢复当前学习运行",
      payloadSha256: "b".repeat(64),
    },
    learningRunStartCandidate: null,
    ...overrides,
  });
}

/** 「学习衔接」那一格里那张卡上的唯一一颗按钮。 */
function resumeButton(): HTMLButtonElement | null {
  const buttons = [...document.querySelectorAll(
    '.cc-learning-continuation button',
  )];
  expect(buttons).toHaveLength(1);
  return (buttons[0] as HTMLButtonElement) ?? null;
}

function renderPanel(props: Partial<ActivityPanelProps> = {}) {
  const base: ActivityPanelProps = {
    section: { ok: true, value: bootstrap() },
    learningContextSection: unavailableSection,
    deliverySection: { ok: true, value: timeline() },
    deliveries: [],
    busy: false,
    error: null,
    onStart: noop,
    onAction: noop,
    onResumeLearning: noop,
    onOpenObjective: noop,
    onPresent: noop,
    onDelivery: noop,
    onRetry: noop,
  };
  render(<ActivityPanel {...base} {...props} />);
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
});

describe("伴星中心 · 动态：三段各说各的，折叠里的不算露出", () => {
  it("三段都在说「没有」：登记三行，每行都标着自己属于哪一段", () => {
    renderPanel();
    const view = publishedView()!;
    expect(view.pageId).toBe("companion");
    expect(view.title).toBe("伴星中心");
    const cards = [...[document.querySelector(".cc-learning-continuation .cc-state strong"), document.querySelector(".cc-timeline .cc-state strong"), document.querySelector(".cc-journey > div > p")].filter((node): node is Element => node !== null)].map((node) => node.textContent);
    expect(cards).toHaveLength(3);
    expect(view.items?.map((entry) => entry.label)).toEqual(cards);
    expect(view.items?.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
    expect(view.items?.map((entry) => entry.state)).toEqual(
      [...[document.querySelector(".cc-learning-continuation > .cc-kicker"), document.querySelector(".cc-timeline > h3"), document.querySelector(".cc-journey > h3")].filter((node): node is Element => node !== null)].map((node) => node.textContent),
    );
    expect(view.notice).toBeUndefined();
  });

  it("旅程进行中：登记的是那张卡自己写着的标题", () => {
    renderPanel({ section: { ok: true, value: bootstrap({ journey: journey() }) } });
    const view = publishedView()!;
    const journeyTitle = document.querySelector(".cc-journey > div strong")?.textContent;
    expect(journeyTitle).toBe("旅程状态");
    expect(view.items?.map((entry) => entry.label)).toContain(journeyTitle);
  });

  it("有历史动态时：折叠里的行一条都不登记，只有那行标题上的条数进 notice", () => {
    renderPanel({
      deliverySection: { ok: true, value: timeline() },
      deliveries: [
        delivery(1, "第三章那段还缺一个反例", "delivered"),
        delivery(2, "上一轮已经答过", "acted"),
        delivery(3, "更早的一条", "dismissed"),
      ],
    });
    const view = publishedView()!;
    expect(view.items?.map((entry) => entry.label)).toContain("第三章那段还缺一个反例");
    expect(view.items?.map((entry) => entry.label)).not.toContain("上一轮已经答过");
    expect(view.items?.map((entry) => entry.label)).not.toContain("更早的一条");
    expect(view.notice).toBe(document.querySelector(".cc-timeline-history summary")?.textContent);
    expect(view.notice).toBe("历史动态 · 2 条");
  });

  it("报错那一行写什么，statusLine 就是什么", () => {
    renderPanel({ error: "主动投递这次没读出来" });
    expect(publishedView()!.statusLine).toBe(document.querySelector(".cc-feedback.is-error")?.textContent);
  });

  it("三段独立读取中不把旧候选、旧旅程或旧投递登记成当前内容", () => {
    renderPanel({ learningLoading: true, journeyLoading: true, deliveryLoading: true,
      learningContextSection: { ok: true, value: learningContextWithResume() },
      section: { ok: true, value: bootstrap({ journey: journey() }) },
      deliveries: [delivery(1, "旧投递", "delivered"), delivery(2, "旧历史", "acted")],
    });
    expect(publishedView()!.items?.map(item => item.label)).toEqual(["正在读取学习状态", "正在读取动态", "正在读取旅程"]);
    expect(publishedView()!.notice).toBeUndefined();
  });

  it("先提议后消息的显示顺序，与可读投递一致", () => {
    const proposal = { ...delivery(2, "待选择的提议", "delivered"), kind: "proposal" as const,
      target: { kind: "proposal" as const, proposalId: "55555555-5555-4555-8555-555555555555" } };
    renderPanel({ deliveries: [delivery(1, "普通消息", "delivered"), proposal] });
    const visible = [...document.querySelectorAll(".cc-delivery strong")].map(node => node.textContent);
    expect(visible).toEqual(["待选择的提议", "普通消息"]);
    expect(publishedView()!.items?.filter(item => item.state === "最近动态").map(item => item.label)).toEqual(visible);
  });

  it("展开和收起历史动态立即更新可读内容", () => {
    renderPanel({ deliveries: [delivery(1, "已处理历史", "acted")] });
    const details = document.querySelector<HTMLDetailsElement>(".cc-timeline-history")!;
    expect(publishedView()!.items?.some(item => item.label === "已处理历史")).toBe(false);
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(publishedView()!.items?.some(item => item.label === "已处理历史")).toBe(true);
    details.open = false;
    fireEvent(details, new Event("toggle"));
    expect(publishedView()!.items?.some(item => item.label === "已处理历史")).toBe(false);
  });
});

/**
 * 39d W4-2 登记的第三处词源（2026-09-25 收口）：这一格那颗恢复按钮过去硬写
 * 「继续学习」，而同一个动作在列表／详情／首页／星图上由 `primaryActionLabel`
 * 签发成「继续作答」——两块屏、一个动作、两个词。
 *
 * 两条断言方向不同，都要留着：
 *  - **对账**：按钮上的字必须等于 `primaryActionLabel(resume_run)` 那句话——
 *    两边任一改动都会红（改按钮的字面量 → 红；改签发处 → 红）；
 *  - **落点**：点它调的是 `onResumeLearning(那一轮的 runId)`，不是别的动作——
 *    否则对账那条换成一颗不恢复的按钮仍然绿。
 */
describe("伴星中心 · 动态：恢复那颗按钮与目标面共用一个词（39d W4-2）", () => {
  it("按钮上的字就是 `primaryActionLabel` 对 resume_run 签发的那句话", () => {
    renderPanel({ learningContextSection: { ok: true, value: learningContextWithResume() } });
    const word = primaryActionLabel({
      kind: "resume_run",
      runId: RESUME_RUN_ID,
      objectiveId: RESUME_OBJECTIVE_ID,
    });
    expect(word).toBe("继续作答");
    expect(resumeButton()?.textContent).toBe(word);
  });

  it("点它就是接着跑那一轮，不带第二个动作", () => {
    const resumed: string[] = [];
    renderPanel({
      learningContextSection: { ok: true, value: learningContextWithResume() },
      onResumeLearning: (runId) => { resumed.push(runId); },
    });
    fireEvent.click(resumeButton()!);
    expect(resumed).toEqual([RESUME_RUN_ID]);
  });
});
