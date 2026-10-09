/**
 * 更新通知的**发声时机**。
 *
 * 判据只有一条，但很要紧：不是所有 phase 都值得打扰用户。
 *
 * - `checking` / `upToDate` / `unreachable` 都不发声。前两个用户没在等结果；
 *   `unreachable` 是"这次没问到"（多半是 GitHub 匿名查询限额），拿它当坏消息
 *   说出去，用户会以为更新坏了——这正是之前主进程相位顺序错误造成的假通知。
 * - `available` / `downloading` / `ready` / `failed` 才发声。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateStateV1 } from "@astella/shared/desktop-ipc-contracts";

const openSettings = vi.fn();
vi.mock("../open-voice-model-settings", () => ({ openVoiceModelSettings: vi.fn() }));
vi.mock("../../../app/room-store", () => ({
  useRoomStore: { getState: () => ({ setSettingsSection: vi.fn(), setSettingsAttention: vi.fn(), invoke: openSettings }) },
}));
vi.mock("../../../app/update-status", () => ({ useUpdateStatus: { getState: () => ({ install: vi.fn() }) } }));

import { useCompanionNotifications } from "../companion-notifications";
import { notifyUpdateAvailable, notifyUpdateDownloading, notifyUpdateFailed, notifyUpdateReady, notifyUpdateInstalled } from "../update-notifications";

function state(patch: Partial<UpdateStateV1>): UpdateStateV1 {
  return {
    phase: "idle",
    currentVersion: "0.1.0",
    availableVersion: null,
    releaseNotes: null,
    releaseName: null,
    releaseDate: null,
    fileSize: null,
    releaseUrl: null,
    percent: null,
    transferred: null,
    total: null,
    message: null,
    installBlockedReason: null,
    checkedAt: null,
    ...patch,
  };
}

const ids = () => useCompanionNotifications.getState().items.map(item => item.id);

beforeEach(() => {
  useCompanionNotifications.setState({ items: [] });
  openSettings.mockReset();
});

describe("更新通知", () => {
  it("启动成功回执带语音、去掉旧提醒，同一版本不会重复投递", () => {
    notifyUpdateReady(state({ phase: "ready", availableVersion: "0.2.0" }));
    const installed = state({ currentVersion: "0.2.0", installedUpdate: { fromVersion: "0.1.0", version: "0.2.0" } });
    notifyUpdateInstalled(installed);
    notifyUpdateInstalled(installed);
    const notices = useCompanionNotifications.getState().items;
    expect(notices).toHaveLength(1);
    expect(notices[0].source).toBe("更新成功");
    expect(notices[0].audio?.text).toContain("更新成功");
    expect(notices[0].delivery).toBe("when-idle");
    expect(notices[0].onShown).toBeTypeOf("function");
  });

  it("只下载或仍在旧版本时不声称更新成功", () => {
    notifyUpdateInstalled(state({ phase: "ready", availableVersion: "0.2.0" }));
    notifyUpdateInstalled(state({ installedUpdate: { fromVersion: "0.1.0", version: "0.2.0" } }));
    expect(ids()).toHaveLength(0);
  });
  it("发现新版本：设备级、闲时投递、不打断", () => {
    notifyUpdateAvailable(state({ phase: "available", availableVersion: "0.2.0" }));
    const [notice] = useCompanionNotifications.getState().items;
    expect(notice.kind).toBe("reminder");
    // 换空间不该把它清掉——更新是这台设备的事，不是某个空间的。
    expect(notice.scope).toBe("device");
    // 正做题时不能抢话。
    expect(notice.delivery).toBe("when-idle");
    expect(ids()).toContain("update-available");
  });

  /**
   * 纸片只有 326px 宽、内部还要滚动，装不下一篇长文；而正文末尾那两段安装说明
   * 与卡片自己那句"可以在设置里下载"说的是同一件事。要点之外的内容留在设置的
   * 「客户端更新」那一格读全文。
   */
  it("正文只带要点：标题与安装说明不进纸片，免得与卡片自己那句话重复", () => {
    notifyUpdateAvailable(state({
      phase: "available",
      availableVersion: "0.2.0",
      releaseNotes: [
        "Astella v0.2.0",
        "· 生成学习卡这类 AI 操作，会在创建任务前确认本人的 AI 同意。",
        "· 伴星把同一话题的连续补充当成一段话理解。",
        "已安装旧版的用户可在客户端检查更新，或下载本次安装包替换原应用。",
      ].join("\n"),
    }));
    const body = useCompanionNotifications.getState().items[0].body;
    expect(body).toContain("· 伴星把同一话题的连续补充当成一段话理解。");
    expect(body).not.toContain("已安装旧版的用户");
    expect(body).not.toContain("Astella v0.2.0");
  });

  it("认不出要点时整段留着——宁可长，也不悄悄把内容裁掉", () => {
    notifyUpdateAvailable(state({ phase: "available", availableVersion: "0.2.0", releaseNotes: "这次只写了一段话。" }));
    expect(useCompanionNotifications.getState().items[0].body).toContain("这次只写了一段话。");
  });

  it("下载中复用同一条 id，进度是就地更新而不是每次多一条", () => {
    notifyUpdateDownloading(state({ phase: "downloading", percent: 10 }));
    notifyUpdateDownloading(state({ phase: "downloading", percent: 60 }));
    expect(ids().filter(id => id === "update-downloading")).toHaveLength(1);
    const [notice] = useCompanionNotifications.getState().items;
    expect(notice.progress?.percent).toBe(60);
  });

  it("下载中的标签带真实字节数——慢连接下百分比会长时间停在 0", () => {
    notifyUpdateDownloading(state({ phase: "downloading", percent: 0, transferred: 5_242_880, total: 209_715_200 }));
    const [notice] = useCompanionNotifications.getState().items;
    expect(notice.progress?.label).toContain("5 MB");
    expect(notice.progress?.label).toContain("200 MB");
  });

  it("下载完成后撤掉下载中与有新版本两条，只留「可以装了」", () => {
    notifyUpdateAvailable(state({ phase: "available", availableVersion: "0.2.0" }));
    notifyUpdateDownloading(state({ phase: "downloading", percent: 100 }));
    notifyUpdateReady(state({ phase: "ready", availableVersion: "0.2.0" }));
    expect(ids()).toContain("update-ready");
    expect(ids()).not.toContain("update-available");
    expect(ids()).not.toContain("update-downloading");
  });

  it("macOS 未签名说的是「手动安装」，不是「更新没能完成」", () => {
    notifyUpdateFailed(state({ phase: "failed", installBlockedReason: "macosUnsigned", message: "这份 macOS 安装包没有代码签名…" }));
    const [notice] = useCompanionNotifications.getState().items;
    expect(notice.title).toContain("手动安装");
    expect(notice.title).not.toContain("没能完成");
  });

  it("「去看看」把人领到数据与维护那一格，而不是设置首页", () => {
    notifyUpdateAvailable(state({ phase: "available", availableVersion: "0.2.0" }));
    const [notice] = useCompanionNotifications.getState().items;
    void notice.actions?.find(action => action.id === "go")?.run?.();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});
