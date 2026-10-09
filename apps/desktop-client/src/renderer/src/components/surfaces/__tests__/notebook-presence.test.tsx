// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRoomStore } from "../../../app/room-store";
import { NotebookPresence, NotebookPresenceReaders } from "../notebook/notebook-presence.tsx";

/**
 * 「谁开着这一篇」那一排印章（共享空间的在场）。
 *
 * 每一条各守一种说谎方式：
 *  - 一个人时凭空长出一排头像，或者整排消失让人以为功能没做；
 *  - 对端没报名字时那一位悄悄少掉（人数和头像对不上）；
 *  - 名字只写在悬停里，键盘和读屏用户拿不到；
 *  - 通道坏了却照旧说"只有你在看"——那会把故障读成独处；
 *  - 列表那一行跟着算一个自己那份的人数——同一天两个版本的人数。
 *
 * 夹具里的 `block: null` = 对端报了"在场但不在任何块里"。这一页只画人、不画
 * "他在写哪一段"（那一句在正文里，见 notebook-surface 的 coWriters），所以这里给 null；
 * `NoteDocPeer` 要求这两个字段，别为了省事把它们删掉——少了它们，`npm run typecheck`
 * 会在 renderer 工程里报 TS2741。
 */

const stamps = () => [...document.querySelectorAll(".notebook-presence__peer")];
const letters = () => stamps().map((n) => n.textContent);
const labels = () => stamps().map((n) => n.getAttribute("aria-label"));
const text = () => document.body.textContent ?? "";

afterEach(() => { cleanup(); useRoomStore.setState({ accountIdentity: null, accountAvatar: null }); });

describe("笔记页的在场印章", () => {
  it("还没有身份时不出现（那时连'你'都说不出是谁）", () => {
    const { container } = render(<NotebookPresence peers={[]} selfName={null} selfMode="reading" />);
    expect(container.textContent).toBe("");
    expect(stamps()).toHaveLength(0);
  });

  it("只有你一个人时也出现，并说「只有你在看」", () => {
    render(<NotebookPresence peers={[]} selfName="Asklins" selfMode="reading" />);
    expect(letters()).toEqual(["A"]);
    expect(text()).toContain("只有你在看");
    expect(text()).not.toContain("人在看");
  });

  it("自己排在最前，人数把两枚都算进去，档位跟着名字说", () => {
    render(<NotebookPresence peers={[{ clientId: 7, name: "小琳", mode: "editing", block: null }]} selfName="Asklins" selfMode="reading" />);
    expect(letters()).toEqual(["A", "小"]);
    expect(labels()).toEqual(["Asklins（你） · 在读", "小琳 · 在写"]);
    expect(text()).toContain("2 人在看 · 1 人在写");
  });

  it("独自编辑时说在写，不能把编辑态说成在看", () => {
    render(<NotebookPresence peers={[]} selfName="Asklins" selfMode="editing" />);
    expect(text()).toContain("只有你在写");
    expect(text()).not.toContain("只有你在看");
  });

  it("没报名字的对端仍占一枚印章，并说清是没留下名字", () => {
    render(<NotebookPresence peers={[{ clientId: 8, name: null, mode: "reading", block: null }]} selfName="Asklins" selfMode="reading" />);
    expect(letters()).toEqual(["A", "?"]);
    expect(text()).toContain("2 人在看");
    expect(labels()[1]).toBe("没留下名字的人 · 在读");
  });

  it("通道没连上时说的是没连上，不是「只有你在看」", () => {
    render(<NotebookPresence peers={[]} selfName="Asklins" selfMode="reading" failure="connection_lost" />);
    expect(text()).toContain("协同没连上");
    expect(text()).not.toContain("只有你在看");
  });
});

describe("笔记列表那一行的在场", () => {
  it("没人在看时那一行不多出任何东西", () => {
    const { container } = render(<NotebookPresenceReaders viewers={[]} />);
    expect(container.textContent).toBe("");
  });

  it("只说别人是谁在读在写，不跟着报人数（人数归点开以后的顶栏）", () => {
    render(<NotebookPresenceReaders viewers={[
      { id: "u1", name: "小琳", mode: "editing" },
      { id: "u2", name: "阿斯", mode: "reading" },
    ]} />);
    expect(letters()).toEqual(["小", "阿"]);
    // 纸上那一行只放得下一句短话（238px 的纸，四个人时全名列实测撑到三行）：
    // 先说最该知道的那一个，后面如实报数；全名在 title 与 aria-label 里，一个都不丢。
    expect(text()).toContain("小琳 在写 · 还有 1 人");
    expect(text()).not.toContain("人在看");
    const line = document.querySelector(".notebook-note-list__readers");
    expect(line?.getAttribute("title")).toBe("小琳 在写 · 阿斯 在读");
    expect(line?.getAttribute("aria-label")).toBe("小琳 在写 · 阿斯 在读");
  });

  it("只有一个人时不说「还有几人」", () => {
    render(<NotebookPresenceReaders viewers={[{ id: "u4", name: "小琳", mode: "reading" }]} />);
    expect(text()).toContain("小琳 在读");
    expect(text()).not.toContain("还有");
  });

  it("没留下名字的人画一枚问号并写出那句话", () => {
    render(<NotebookPresenceReaders viewers={[{ id: "u3", name: null, mode: "reading" }]} />);
    expect(letters()).toEqual(["?"]);
    expect(text()).toContain("没留下名字的人 在读");
  });
});

describe("笔记中的账户头像", () => {
  it("与账户头像一起更新，清除后回到首字母", () => {
    useRoomStore.setState({ accountIdentity: { email: "me@example.test", displayName: "Asklins" },
      accountAvatar: { email: "me@example.test", src: "data:image/png;base64,OLD" } });
    render(<NotebookPresence peers={[]} selfName="Asklins" selfMode="reading" compact />);
    const avatar = () => document.querySelector(".notebook-presence__peer img");
    expect(avatar()?.getAttribute("src")).toBe("data:image/png;base64,OLD");
    act(() => useRoomStore.getState().setAccountAvatar({ email: "me@example.test", src: "data:image/png;base64,NEW" }));
    expect(avatar()?.getAttribute("src")).toBe("data:image/png;base64,NEW");
    expect(labels()).toEqual(["Asklins（你） · 在读"]);
    act(() => useRoomStore.getState().setAccountAvatar({ email: "me@example.test", src: "" }));
    expect(avatar()).toBeNull();
    expect(letters()).toEqual(["A"]);
  });
  it("切换账号后不显示上一位的头像", () => {
    useRoomStore.setState({ accountIdentity: { email: "new@example.test", displayName: "新人" },
      accountAvatar: { email: "old@example.test", src: "data:image/png;base64,OLD" } });
    render(<NotebookPresence peers={[]} selfName="新人" selfMode="reading" />);
    expect(document.querySelector(".notebook-presence__peer img")).toBeNull();
    expect(letters()).toEqual(["新"]);
  });
});
