import { LockKeyhole, UsersRound } from "lucide-react";
import type { NoteShareScopeV1 } from "@astella/shared/note-share-contracts";
import type { NotePresenceModeV1 } from "@astella/shared/note-presence-contracts";
import { SpaceShareButton, noteShareScopeLabel } from "../../space-share-control";
import { WritingPopover } from "./notebook-format-controls";
import { NotebookPresence } from "./notebook-presence";
import type { NoteDocPeer } from "./use-note-doc-live-view";

/** Visibility and the people in this document have one persistent, inspectable entry. */
export function NotebookSharingControl(props: {
  readonly shareScope: NoteShareScopeV1;
  readonly canShare: boolean;
  readonly busy: boolean;
  readonly onShare: (next: NoteShareScopeV1) => void | Promise<void>;
  readonly peers: readonly NoteDocPeer[];
  readonly selfName: string | null;
  readonly selfMode: NotePresenceModeV1;
  readonly failure: string | null;
}) {
  const shared = props.shareScope === "shared";
  const Icon = shared ? UsersRound : LockKeyhole;
  const people = [{ clientId: -1, name: props.selfName, mode: props.selfMode }, ...props.peers];
  return <span className="notebook-sharing">
    <WritingPopover label="共享与协同" className="notebook-sharing-popup" trigger={<>
      <Icon size={15} aria-hidden="true" />
      <span className="notebook-sharing__scope">{shared ? "已共享" : "仅自己可见"}</span>
      {shared ? <span className="notebook-sharing__presence"><NotebookPresence peers={props.peers}
        selfName={props.selfName} selfMode={props.selfMode} failure={props.failure} compact /></span> : null}
    </>}>{() => <>
      <p className="notebook-sharing-popup__scope">{noteShareScopeLabel(props.shareScope)}</p>
      <p className="notebook-sharing-popup__hint">{shared ? "这个空间的成员都能读到这篇正文。" : "这篇正文目前只有你自己看得到。"}</p>
      {shared && !props.failure ? <ul className="notebook-sharing-popup__people" aria-label="此刻在这篇里的人">
        {people.map(person => <li key={person.clientId}><span>{person.name?.trim() || "没留下名字的人"}{person.clientId === -1 ? "（你）" : ""}</span>
          <small>{person.mode === "editing" ? "在写" : "在读"}</small></li>)}
      </ul> : null}
      {shared && props.failure ? <p className="notebook-sharing-popup__failure" role="status">协同没连上，暂时无法确认谁在这篇里。</p> : null}
      <div className="notebook-sharing-popup__actions">
        <SpaceShareButton shareScope={props.shareScope} canShare={props.canShare} isPersonal={false} busy={props.busy} onShare={props.onShare} />
        {!props.canShare ? <p className="notebook-sharing-popup__hint">只有写下这篇的人能修改共享范围。</p> : null}
        {props.busy ? <p role="status">正在更新共享范围…</p> : null}
      </div>
    </>}</WritingPopover>
  </span>;
}
