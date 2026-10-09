import type { NoteDocPeer } from "./use-note-doc-live-view.ts";
import type { NotebookPresenceViewer } from "./use-notebook-note-presence.ts";
import type { NotePresenceModeV1 } from "@astella/shared/note-presence-contracts";
import { useRoomStore } from "../../../app/room-store";

/**
 * 「谁开着这一篇」：一排印章 + 一句人数（共享空间的在场）。
 *
 * 自己那一枚**一直在**（只要这篇已经共享、这条实时通道活着）：只有一个人的时候，
 * 这一排说的是"别人看得见你在这里"，而不是"这一格空着，功能大概没做"。
 * 一篇还没共享出去的笔记不会走到这里——那里本来就没有别人能看见，画出来的
 * 「只有你在看」是废话，界面上说的是旁边那颗「仅自己可见」。
 *
 * 自己的印章使用账户头像，没有头像时回退首字母；姓名保留在 `title` 与 `aria-label`，
 * 因为鼠标悬停不是唯一的到达方式。人数与档位也是同一理由：颜色和小圆点谁都能一眼看到，
 * 但读屏和键盘浏览要有一句文字可对得上这一排印章。
 */
const modeLabel = (mode: NotePresenceModeV1): string => (mode === "editing" ? "在写" : "在读");

/** 印章画首字母；没留下名字的画一枚「?」，位置留着，人数才对得上。 */
const stampOf = (name: string | null): string => (name?.trim() ? name.trim().slice(0, 1).toUpperCase() : "?");
const whoOf = (name: string | null): string => name?.trim() || "没留下名字的人";

export function NotebookPresence({
  peers,
  selfName,
  selfMode,
  failure = null,
  compact = false,
}: {
  readonly peers: readonly NoteDocPeer[];
  readonly selfName: string | null;
  readonly selfMode: NotePresenceModeV1;
  /**
   * 这条实时通道坏掉的那个理由（`noteDocLive.failure`）。非空时这一排说的是"没连上"，
   * 而不是拿一个永远为空的名单说"只有你在看"——那会把故障读成独处。
   */
  readonly failure?: string | null;
  readonly compact?: boolean;
}) {
  // 与账户胶囊读同一份头像，换头像/清头像后立即更新；换账号时不沿用旧字节。
  const selfAvatar = useRoomStore(state => state.accountIdentity
    && state.accountAvatar?.email === state.accountIdentity.email ? state.accountAvatar.src : null);
  if (failure) {
    return <span className="tag" role="status" title={failure}>{compact ? "协同没连上" : "协同没连上，暂时无法确认谁在这篇里"}</span>;
  }
  if (selfName === null && peers.length === 0) return null;
  const everyone = [{ clientId: -1, name: selfName, mode: selfMode }, ...peers];
  const writers = everyone.filter((peer) => peer.mode === "editing").length;
  return (
    <>
      <span className="notebook-presence">
        {(compact ? everyone.slice(0, 3) : everyone).map((peer) => {
          const name = peer.name?.trim() ?? "";
          // 没报名字的落回一枚「?」印章：这一排的位置就是人数的位置，
          // 少画一个会是"界面上找不到那个人"。
          const who = name ? (peer.clientId === -1 ? `${name}（你）` : name) : whoOf(null);
          const label = `${who} · ${modeLabel(peer.mode)}`;
          return (
            <span
              key={peer.clientId}
              className="notebook-presence__peer"
              role="img"
              aria-label={label}
              title={label}
              data-mode={peer.mode}
            >
              {peer.clientId === -1 && selfAvatar
                ? <img src={selfAvatar} alt="" aria-hidden="true" />
                : stampOf(name)}
            </span>
          );
        })}
        {compact && everyone.length > 3 ? <span className="notebook-presence__more" aria-label={`还有 ${everyone.length - 3} 人`}>+{everyone.length - 3}</span> : null}
      </span>
      {peers.length === 0
        ? <span className="tag" title="这篇已经共享给空间，此刻只有你开着它">{selfMode === "editing" ? "只有你在写" : "只有你在看"}</span>
        : <span className="tag" title={`此刻开着这一篇的 ${everyone.length} 个人`}>
          {compact ? `${everyone.length} 人在场` : `${everyone.length} 人在看${writers > 0 ? ` · ${writers} 人在写` : ""}`}
        </span>}
    </>
  );
}

/**
 * 列表那一行用的紧凑版：只画**别人**，说的是名字而不是人数。
 *
 * 为什么不说人数：人数那句话归点开以后的顶栏，那里把你自己也算进去。列表跟着报一个
 * 自己算出来的数，同一天就会有两个版本的人数，而用户正是从列表那一行点进顶栏的。
 * 你自己开着的那一篇，那一行已经有「当前」在说，所以这里也不把你算进"别人"。
 */
export function NotebookPresenceReaders({ viewers }: { readonly viewers: readonly NotebookPresenceViewer[] }) {
  if (viewers.length === 0) return null;
  const names = (mode: NotePresenceModeV1) => viewers.filter((viewer) => viewer.mode === mode).map((viewer) => whoOf(viewer.name));
  const writers = names("editing");
  const readers = names("reading");
  // 悬停与读屏拿全句：谁在写、谁在读，一个名字都不少。
  const everyOne = [
    writers.length ? `${writers.join("、")} 在写` : "",
    readers.length ? `${readers.join("、")} 在读` : "",
  ].filter(Boolean).join(" · ");
  // 屏上那一行只摆得下一句短话（纸宽 238px，实窗量过：全名列四个人要撑三行）。
  // 说的是"最该知道的那一个"+ 还剩几个，而不是把名字切半——被截成"阿斯蒂芬·长名…"
  // 既读不出是谁，也不知道后面还有几个人。
  const first = writers.length ? `${writers[0]} 在写` : `${readers[0]} 在读`;
  const rest = viewers.length - 1;
  const phrase = rest > 0 ? `${first} · 还有 ${rest} 人` : first;
  return (
    <span className="notebook-note-list__readers" title={everyOne} aria-label={everyOne}>
      <span className="notebook-presence" aria-hidden="true">
        {viewers.map((viewer) => (
          <span key={viewer.id} className="notebook-presence__peer">{stampOf(viewer.name)}</span>
        ))}
      </span>
      <span aria-hidden="true">{phrase}</span>
    </span>
  );
}
