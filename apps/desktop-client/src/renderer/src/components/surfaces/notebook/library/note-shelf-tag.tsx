import {
  NOTE_SHELF_STAGE_LABEL_V1,
  noteShelfStageDetailV1,
  type NoteShelfStateV1,
} from "@astella/shared/note-shelf-state-contracts";

/** 架上纸签只报告已保存的记录；读不到状态时不画，也不推断掌握度。 */
export function NoteShelfTag(props: {
  readonly state: NoteShelfStateV1 | null | undefined;
  /** 紧凑视图只留主签，副签交给 `title`。 */
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const state = props.state;
  if (!state) return null;
  const detail = noteShelfStageDetailV1(state.facts);
  const label = NOTE_SHELF_STAGE_LABEL_V1[state.stage];
  const versionNote = state.editedAfterLearning
    ? state.facts.latestVersionNumber === null
      ? "这篇后来改过版"
      : `这篇后来改过版（记录停在 v${state.facts.latestVersionNumber}）`
    : "";
  const tooltip = [
    label,
    ...detail,
    versionNote,
  ].filter(Boolean).join(" · ");

  return (
    <span
      className={["note-state-tag", `note-state-tag--${state.stage}`, props.className ?? ""]
        .filter(Boolean).join(" ")}
      data-stage={state.stage}
      data-edited-after-learning={state.editedAfterLearning ? "true" : undefined}
      title={tooltip}
    >
      <span className="note-state-tag__label">{label}</span>
      {state.editedAfterLearning
        ? <span className="note-state-tag__edited">改过版</span>
        : null}
      {props.compact || detail.length === 0
        ? null
        : <span className="note-state-tag__detail">{detail.join(" · ")}</span>}
    </span>
  );
}

/**
 * 纸签的完整读法，供伴星与无障碍树读同一份事实。
 纸面已经把这些话说在屏幕上了，这里不再造第二套说法。
 */
export function noteShelfTagText(state: NoteShelfStateV1): string {
  return [
    NOTE_SHELF_STAGE_LABEL_V1[state.stage],
    ...noteShelfStageDetailV1(state.facts),
    state.editedAfterLearning
      ? state.facts.latestVersionNumber === null
        ? "这篇后来改过版"
        : `这篇后来改过版（记录停在 v${state.facts.latestVersionNumber}）`
      : "",
  ].filter(Boolean).join("，");
}

export type { NoteShelfStateV1 };
