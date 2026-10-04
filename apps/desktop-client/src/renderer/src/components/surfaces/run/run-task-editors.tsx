/**
 * 作答台的 8 个题型编辑器与它们的纯函数。
 *
 * ## 为什么从 `learning-run-surface.tsx` 拆出来（2026-09-29）
 *
 * 那个文件 3257 行，其中 `LearningRunBody` 单个函数 1769 行。这一簇（708 行）是里面
 * **耦合最干净**的一大块：全部 props 进、JSX 出，不读任何页面级状态，也不碰网关——
 * 它们只负责「把一道题的当前答案画成可编辑的形状，并把改动报上去」。
 *
 * 行为那一半（围栏、快照重同步、草稿自动保存、活跃租约、提交、结果轮询与返回契约）
 * 仍然留在 `LearningRunBody` 里，两边不共享状态——工作台刻意给每种交互留了自己的
 * 编辑器，而不是把所有题都塞进一个文本作答的壳。
 *
 * ## 搬的时候逐字保留了 JSX 与那几个纯函数
 *
 * `emptyEditor` / `payloadIsReady` / `actionRequestFor` / `repairPreviewItems` 与
 * 8 个组件之间的调用关系是一体的，拆开任何一半都会红。2026-09-29 那次拆 notebook 时
 * 我凭印象重写过一版 `SettingRow`，把类名与无障碍属性都改了——**这类改动任何守卫都
 * 抓不到**（那些类名仍有 CSS 规则，测试也全绿），所以这里坚持逐字。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, GripVertical, Link2, Plus, Trash2, X } from "lucide-react";
import type {
  ArtifactPayload,
  LearningTaskPublic,
  RelationEdgeKindV1,
  RepairOperationV1,
  StructuredPartAnswerV1,
  StructuredPartPublicV1,
} from "@ailearn/shared/learning-run-contracts";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";
import { VoiceTeachbackEditor } from "./run-voice-input.tsx";
import { indexedPublicLabel } from "../../learning-run-labels";

function relationKindLabel(kind: RelationEdgeKindV1): string {
  const labels: Record<RelationEdgeKindV1, string> = {
    causes: "导致",
    depends_on: "依赖",
    part_of: "属于",
    contrasts_with: "对比",
    supports: "支持",
    precedes: "先于",
  };
  return labels[kind];
}

function repairOperationTarget(operation: RepairOperationV1): string | null {
  return operation.op === "insert" ? operation.afterElementId : operation.elementId;
}

function repairPreviewItems({
  elementIds,
  labels,
  replacementOptionIds,
  replacementLabels,
  operations,
}: {
  readonly elementIds: string[];
  readonly labels?: Record<string, string>;
  readonly replacementOptionIds: string[];
  readonly replacementLabels?: Record<string, string>;
  readonly operations: RepairOperationV1[];
}): Array<{ key: string; label: string; changed: boolean }> {
  const original = elementIds.map((id) => ({
    key: `source:${id}`,
    sourceId: id,
    label: indexedPublicLabel(labels, elementIds, id, "元素"),
    changed: false,
  }));

  return operations.reduce((items, operation, operationIndex) => {
    if (operation.op === "remove") {
      return items.filter((item) => item.sourceId !== operation.elementId);
    }
    if (operation.op === "replace") {
      return items.map((item) => item.sourceId === operation.elementId
        ? {
            ...item,
            label: indexedPublicLabel(replacementLabels, replacementOptionIds, operation.replacementOptionId, "替换项"),
            changed: true,
          }
        : item);
    }
    if (operation.op === "move") {
      const fromIndex = items.findIndex((item) => item.sourceId === operation.elementId);
      if (fromIndex < 0) return items;
      const next = [...items];
      const [moved] = next.splice(fromIndex, 1);
      const toIndex = Math.max(0, Math.min(operation.toIndex, next.length));
      next.splice(toIndex, 0, { ...moved!, changed: true });
      return next;
    }
    const inserted = {
      key: `insert:${operationIndex}:${operation.replacementOptionId}`,
      sourceId: `insert:${operationIndex}`,
      label: indexedPublicLabel(replacementLabels, replacementOptionIds, operation.replacementOptionId, "插入项"),
      changed: true,
    };
    if (operation.afterElementId === null) return [inserted, ...items];
    const afterIndex = items.findIndex((item) => item.sourceId === operation.afterElementId);
    if (afterIndex < 0) return [...items, inserted];
    return [...items.slice(0, afterIndex + 1), inserted, ...items.slice(afterIndex + 1)];
  }, original);
}

function structuredPartReady(value: StructuredPartAnswerV1, orderingTouched: boolean): boolean {
  if (value.kind === "ordering") return value.orderedTokenIds.length > 1 && orderingTouched;
  if (value.kind === "relation") return value.edges.length > 0;
  return value.operations.length > 0;
}

export function PartEditor({
  part,
  value,
  onChange,
  labels,
  replacementLabels,
}: {
  readonly part: StructuredPartPublicV1;
  readonly value: StructuredPartAnswerV1;
  readonly onChange: (value: StructuredPartAnswerV1) => void;
  readonly labels?: Record<string, string>;
  readonly replacementLabels?: Record<string, string>;
}) {
  const [relationDraft, setRelationDraft] = useState({ from: "", to: "", edgeKind: "supports" as RelationEdgeKindV1 });

  if (part.kind === "ordering" && value.kind === "ordering") {
    return <OrderingEditor ids={part.publicTokenIds} labels={labels} value={value.orderedTokenIds} onChange={(orderedTokenIds) => onChange({ ...value, orderedTokenIds })} />;
  }

  if (part.kind === "relation" && value.kind === "relation") {
    const selectedEdgeKind = part.allowedEdgeKinds.includes(relationDraft.edgeKind)
      ? relationDraft.edgeKind
      : part.allowedEdgeKinds[0];
    const relationAlreadyExists = value.edges.some((edge) => edge.fromNodeId === relationDraft.from
      && edge.toNodeId === relationDraft.to
      && edge.edgeKind === selectedEdgeKind);
    const canAddRelation = Boolean(relationDraft.from
      && relationDraft.to
      && selectedEdgeKind
      && relationDraft.from !== relationDraft.to
      && !relationAlreadyExists);
    const addEdge = () => {
      if (!canAddRelation) return;
      onChange({ ...value, edges: [...value.edges, { fromNodeId: relationDraft.from, toNodeId: relationDraft.to, edgeKind: selectedEdgeKind! }] });
      setRelationDraft((current) => ({ ...current, from: "", to: "" }));
    };
    return (
      <div className="run-part-editor">
        <div className="run-relation-controls">
          <select aria-label="关系起点" value={relationDraft.from} onChange={(event) => setRelationDraft((current) => ({ ...current, from: event.target.value }))}>
            <option value="">选择起点</option>
            {part.publicNodeIds.map((id) => <option key={id} value={id}>{indexedPublicLabel(labels, part.publicNodeIds, id, "节点")}</option>)}
          </select>
          <select aria-label="关系类型" value={selectedEdgeKind ?? ""} onChange={(event) => setRelationDraft((current) => ({ ...current, edgeKind: event.target.value as RelationEdgeKindV1 }))}>
            {part.allowedEdgeKinds.map((kind) => <option key={kind} value={kind}>{relationKindLabel(kind)}</option>)}
          </select>
          <select aria-label="关系终点" value={relationDraft.to} onChange={(event) => setRelationDraft((current) => ({ ...current, to: event.target.value }))}>
            <option value="">选择终点</option>
            {part.publicNodeIds.map((id) => <option key={id} value={id}>{indexedPublicLabel(labels, part.publicNodeIds, id, "节点")}</option>)}
          </select>
          <button type="button" className="run-icon-button" disabled={!canAddRelation} onClick={addEdge} aria-label="加入关系"><Plus size={16} aria-hidden="true" /></button>
        </div>
        {!canAddRelation && relationDraft.from && relationDraft.to ? (
          <p className="run-editor-guidance" role="status">{relationDraft.from === relationDraft.to ? "起点和终点不能是同一项。" : relationAlreadyExists ? "这条关系已经加入了。" : ""}</p>
        ) : null}
        <ul className="run-relation-list" aria-label="已经创建的关系" aria-live="polite">
          {value.edges.map((edge, index) => (
            <li key={`${edge.fromNodeId}-${edge.toNodeId}-${index}`}>
              <span>{indexedPublicLabel(labels, part.publicNodeIds, edge.fromNodeId, "节点")} {relationKindLabel(edge.edgeKind)} {indexedPublicLabel(labels, part.publicNodeIds, edge.toNodeId, "节点")}</span>
              <button type="button" className="run-icon-button" onClick={() => onChange({ ...value, edges: value.edges.filter((_, edgeIndex) => edgeIndex !== index) })} aria-label="删除这条关系"><Trash2 size={14} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (part.kind === "repair" && value.kind === "repair") {
    const operations = value.operations;
    const previewItems = repairPreviewItems({
      elementIds: part.publicElementIds,
      labels,
      replacementOptionIds: part.replacementOptionIds,
      replacementLabels,
      operations,
    });
    const updateOperation = (elementId: string, op: string) => {
      const next = operations.filter((operation) => repairOperationTarget(operation) !== elementId);
      if (op === "replace") next.push({ op: "replace", elementId, replacementOptionId: part.replacementOptionIds[0] ?? "" });
      if (op === "remove") next.push({ op: "remove", elementId });
      if (op === "move") next.push({ op: "move", elementId, toIndex: part.publicElementIds.indexOf(elementId) });
      if (op === "insert") next.push({ op: "insert", afterElementId: elementId, replacementOptionId: part.replacementOptionIds[0] ?? "" });
      onChange({ ...value, operations: next as RepairOperationV1[] });
    };
    return (
      <div className="run-repair-list">
        <div className="run-repair-list__source">
          {part.publicElementIds.map((elementId) => {
            const operation = operations.find((candidate) => repairOperationTarget(candidate) === elementId);
            return (
              <div className="run-repair-row" key={elementId}>
              <span>{indexedPublicLabel(labels, part.publicElementIds, elementId, "元素")}</span>
              <select aria-label={`${indexedPublicLabel(labels, part.publicElementIds, elementId, "元素")}的修正动作`} value={operation?.op ?? ""} onChange={(event) => updateOperation(elementId, event.target.value)}>
                <option value="">保持不变</option>
                {part.allowedOperationKinds.map((kind) => <option key={kind} value={kind}>{kind === "replace" ? "替换" : kind === "remove" ? "移除" : kind === "move" ? "移动" : "插入"}</option>)}
              </select>
              {operation?.op === "replace" || operation?.op === "insert" ? (
                <select
                  aria-label={`${indexedPublicLabel(labels, part.publicElementIds, elementId, "元素")}的替换内容`}
                  value={operation.replacementOptionId}
                  onChange={(event) => onChange({ ...value, operations: operations.map((candidate) => repairOperationTarget(candidate) === elementId ? { ...candidate, replacementOptionId: event.target.value } : candidate) as RepairOperationV1[] })}
                >
                  {part.replacementOptionIds.map((optionId) => <option key={optionId} value={optionId}>{indexedPublicLabel(replacementLabels, part.replacementOptionIds, optionId, "替换项")}</option>)}
                </select>
              ) : null}
              {operation?.op === "move" ? (
                <select
                  aria-label={`${indexedPublicLabel(labels, part.publicElementIds, elementId, "元素")}的目标位置`}
                  value={operation.toIndex}
                  onChange={(event) => onChange({
                    ...value,
                    operations: operations.map((candidate) => repairOperationTarget(candidate) === elementId
                      ? { ...candidate, toIndex: Number(event.target.value) }
                      : candidate) as RepairOperationV1[],
                  })}
                >
                  {part.publicElementIds.map((id, index) => <option key={id} value={index}>第 {index + 1} 位</option>)}
                </select>
              ) : null}
              </div>
            );
          })}
        </div>
        <aside className="run-repair-preview" aria-live="polite">
          <strong><Check size={15} aria-hidden="true" />修补预览</strong>
          <ol className="run-repair-preview__sequence">
            {previewItems.map((item, index) => (
              <li key={item.key} data-changed={item.changed ? "true" : "false"}>
                <span>{index + 1}</span><b>{item.label}</b>
              </li>
            ))}
          </ol>
          <p>{operations.length ? `已预览 ${operations.length} 处修补。` : "还没有修改；原内容会保持不变。"}</p>
        </aside>
      </div>
    );
  }

  return <p className="run-inline-error">当前结构化部分与任务版本不一致，请重新同步。</p>;
}

export function ChoiceEditor({
  ids,
  labels,
  value,
  onChange,
}: {
  readonly ids: string[];
  readonly labels?: Record<string, string>;
  readonly value: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="run-choice-list" role="radiogroup" aria-label="选择一个答案">
      {ids.map((id, index) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          tabIndex={value === id || (value === undefined && index === 0) ? 0 : -1}
          className={`run-choice-option${value === id ? " is-selected" : ""}`}
          onClick={() => onChange(id)}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            const offset = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
            const nextIndex = (index + offset + ids.length) % ids.length;
            const group = event.currentTarget.parentElement;
            onChange(ids[nextIndex]!);
            window.requestAnimationFrame(() => {
              group?.querySelectorAll<HTMLButtonElement>("[role='radio']")[nextIndex]?.focus();
            });
          }}
        >
          <span className="run-choice-option__mark" aria-hidden="true">
            {value === id ? <Check size={15} strokeWidth={3} /> : null}
          </span>
          {indexedPublicLabel(labels, ids, id, `第 ${index + 1} 个选项`)}
        </button>
      ))}
      {ids.length === 0 ? <p className="run-empty-row">这道题没有给出选项。</p> : null}
    </div>
  );
}

export function TrueFalseEditor({
  proposition,
  value,
  onChange,
}: {
  readonly proposition: string;
  readonly value: boolean | undefined;
  readonly onChange: (value: boolean) => void;
}) {
  const options = [true, false] as const;
  const moveSelection = (current: boolean, key: string, button: HTMLButtonElement) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(key)) return;
    const currentIndex = options.indexOf(current);
    const offset = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + offset + options.length) % options.length;
    onChange(options[nextIndex]!);
    window.requestAnimationFrame(() => {
      button.parentElement?.querySelectorAll<HTMLButtonElement>("[role='radio']")[nextIndex]?.focus();
    });
  };
  return (
    <div className="run-truefalse">
      <p className="run-truefalse__claim">{proposition}</p>
      <div className="run-truefalse__actions" role="radiogroup" aria-label="判断这条说法对不对">
        <button
          type="button"
          role="radio"
          aria-checked={value === true}
          tabIndex={value === true || value === undefined ? 0 : -1}
          className={`button${value === true ? " primary" : ""}`}
          onClick={() => onChange(true)}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            moveSelection(true, event.key, event.currentTarget);
          }}
        >这条说法对</button>
        <button
          type="button"
          role="radio"
          aria-checked={value === false}
          tabIndex={value === false ? 0 : -1}
          className={`button${value === false ? " primary" : ""}`}
          onClick={() => onChange(false)}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            moveSelection(false, event.key, event.currentTarget);
          }}
        >这条说法错</button>
      </div>
      {value === undefined ? <p className="meta">先选一个，再提交。</p> : null}
    </div>
  );
}

export function MatchingEditor({
  leftIds,
  rightIds,
  labels,
  value,
  onChange,
}: {
  readonly leftIds: string[];
  readonly rightIds: string[];
  readonly labels?: Record<string, string>;
  readonly value: Array<{ leftId: string; rightId: string }>;
  readonly onChange: (value: Array<{ leftId: string; rightId: string }>) => void;
}) {
  const [activeLeft, setActiveLeft] = useState<string | null>(null);
  const paired = new Map(value.map((pair) => [pair.leftId, pair.rightId]));

  const connect = (rightId: string) => {
    if (!activeLeft) return;
    // 两端都只保留一条连线：重新选择任意一端都是改答案，不会生成互相冲突的配对。
    onChange([
      ...value.filter((pair) => pair.leftId !== activeLeft && pair.rightId !== rightId),
      { leftId: activeLeft, rightId },
    ]);
    setActiveLeft(null);
  };

  return (
    <div className="run-matching">
      <p className="meta">先点左边一项，再点右边它该连的那一项。</p>
      <div className="run-matching__columns">
        <ul className="run-matching__col" aria-label="左列">
          {leftIds.map((id) => (
            <li key={id}>
              <button
                type="button"
                className={`run-matching__item${activeLeft === id ? " is-active" : ""}`}
                aria-pressed={activeLeft === id}
                onClick={() => setActiveLeft(activeLeft === id ? null : id)}
              >
                {labels?.[id] ?? id}
                {paired.get(id) ? <span className="run-matching__linked" aria-hidden="true">已连</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <ul className="run-matching__col" aria-label="右列">
          {rightIds.map((id) => (
            <li key={id}>
              <button
                type="button"
                className="run-matching__item"
                disabled={!activeLeft}
                aria-label={activeLeft ? `把${labels?.[activeLeft] ?? activeLeft}与${labels?.[id] ?? id}配成一对` : `先选择左侧项目，再连接${labels?.[id] ?? id}`}
                onClick={() => connect(id)}
              >
                {labels?.[id] ?? id}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {value.length > 0 ? (
        <div className="run-matching__result" role="status">
          <div className="run-matching__trail"><Link2 size={14} aria-hidden="true" />已连 {value.length} 对<button type="button" className="text-action" onClick={() => { onChange([]); setActiveLeft(null); }}>全部重连</button></div>
          <ul className="run-matching__pairs" aria-label="已经组成的配对">
            {value.map((pair) => (
              <li key={`${pair.leftId}-${pair.rightId}`}>
                <span>{labels?.[pair.leftId] ?? pair.leftId}</span><ArrowRight size={13} aria-hidden="true" /><span>{labels?.[pair.rightId] ?? pair.rightId}</span>
                <button type="button" className="run-icon-button" aria-label={`撤销${labels?.[pair.leftId] ?? pair.leftId}的配对`} onClick={() => onChange(value.filter((candidate) => candidate.leftId !== pair.leftId))}><X size={13} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function OrderingEditor({
  ids,
  labels,
  value,
  onChange,
}: {
  readonly ids: string[];
  readonly labels?: Record<string, string>;
  readonly value: string[];
  readonly onChange: (value: string[]) => void;
}) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [grabbedIndex, setGrabbedIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("尚未调整顺序");
  const pointerIndexRef = useRef<number | null>(null);

  const moveTo = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= value.length || toIndex >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    onChange(next);
    setAnnouncement(`${indexedPublicLabel(labels, ids, moved!, "排序项")}已移到第 ${toIndex + 1} 位`);
  };
  const move = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= value.length) return;
    moveTo(index, nextIndex);
  };

  return (
    <div className="run-ordering">
      <p className="meta">拖动路标调整顺序；键盘按空格抓取，再用方向键移动。</p>
      <ol className="run-order-list" aria-label="可调整顺序的内容">
        {value.map((id, index) => (
          <li
            key={id}
            data-order-index={index}
            draggable
            data-dragging={draggedIndex === index ? "true" : "false"}
            aria-grabbed={grabbedIndex === index || draggedIndex === index}
            onDragStart={() => setDraggedIndex(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); if (draggedIndex !== null) moveTo(draggedIndex, index); setDraggedIndex(null); }}
            onDragEnd={() => setDraggedIndex(null)}
          >
            <b className="run-order-index">{index + 1}</b>
            <button
              type="button"
              className="run-order-grip"
              aria-pressed={grabbedIndex === index}
              aria-label={`${indexedPublicLabel(labels, ids, id, "排序项")}，当前第 ${index + 1} 位。按空格抓取后用上下方向键移动`}
              onPointerDown={(event) => {
                if (event.pointerType === "mouse" && event.button !== 0) return;
                event.preventDefault();
                pointerIndexRef.current = index;
                setDraggedIndex(index);
                event.currentTarget.setPointerCapture?.(event.pointerId);
                setAnnouncement(`正在拖动第 ${index + 1} 项`);
              }}
              onPointerMove={(event) => {
                const fromIndex = pointerIndexRef.current;
                if (fromIndex === null) return;
                const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest<HTMLElement>("[data-order-index]");
                const toIndex = Number(target?.dataset.orderIndex);
                if (!Number.isInteger(toIndex) || fromIndex === toIndex) return;
                moveTo(fromIndex, toIndex);
                pointerIndexRef.current = toIndex;
                setDraggedIndex(toIndex);
              }}
              onPointerUp={(event) => {
                if (pointerIndexRef.current === null) return;
                event.currentTarget.releasePointerCapture?.(event.pointerId);
                pointerIndexRef.current = null;
                setDraggedIndex(null);
                setAnnouncement("已放下排序项");
              }}
              onPointerCancel={() => {
                pointerIndexRef.current = null;
                setDraggedIndex(null);
                setAnnouncement("已取消拖动");
              }}
              onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  setGrabbedIndex(grabbedIndex === index ? null : index);
                  setAnnouncement(grabbedIndex === index ? "已放下" : `已抓取第 ${index + 1} 项`);
                } else if (event.key === "Escape") {
                  setGrabbedIndex(null);
                  setAnnouncement("已取消移动");
                } else if (grabbedIndex === index && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                  event.preventDefault();
                  const nextIndex = Math.max(0, Math.min(value.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
                  moveTo(index, nextIndex);
                  setGrabbedIndex(nextIndex);
                  window.requestAnimationFrame(() => document.querySelectorAll<HTMLButtonElement>(".run-order-grip")[nextIndex]?.focus());
                }
              }}
            ><GripVertical size={17} aria-hidden="true" /></button>
            <span className="run-order-label">{indexedPublicLabel(labels, ids, id, "排序项")}</span>
            <span className="run-order-controls">
              <button type="button" className="run-icon-button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`将${indexedPublicLabel(labels, ids, id, "排序项")}上移`}><ArrowUp size={14} aria-hidden="true" /></button>
              <button type="button" className="run-icon-button" disabled={index === value.length - 1} onClick={() => move(index, 1)} aria-label={`将${indexedPublicLabel(labels, ids, id, "排序项")}下移`}><ArrowDown size={14} aria-hidden="true" /></button>
            </span>
          </li>
        ))}
        {ids.length === 0 ? <li className="run-empty-row">这道题没有给出可以排序的内容。</li> : null}
      </ol>
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  );
}

type StructuredBundleInteraction = Extract<LearningTaskPublic["activeVariant"]["interaction"], { kind: "structured_bundle" }>;
type StructuredBundlePayload = Extract<ArtifactPayload, { kind: "structured_bundle" }>;

export function StructuredBundleEditor({
  interaction,
  value,
  onChange,
  restoredDraft,
  onReviewStateChange,
}: {
  readonly interaction: StructuredBundleInteraction;
  readonly value: StructuredBundlePayload;
  readonly onChange: (value: StructuredBundlePayload) => void;
  readonly restoredDraft: boolean;
  readonly onReviewStateChange: (ready: boolean) => void;
}) {
  const [activePart, setActivePart] = useState(0);
  const [touchedOrderingParts, setTouchedOrderingParts] = useState<ReadonlySet<string>>(() => new Set(
    restoredDraft
      ? interaction.parts.filter((part) => part.kind === "ordering").map((part) => part.partId)
      : [],
  ));
  useEffect(() => {
    if (!restoredDraft) return;
    setTouchedOrderingParts(new Set(
      interaction.parts.filter((part) => part.kind === "ordering").map((part) => part.partId),
    ));
  }, [interaction.parts, restoredDraft]);
  const reviewing = activePart >= interaction.parts.length;
  const part = interaction.parts[Math.min(activePart, interaction.parts.length - 1)];
  const partValue = value.partAnswers[Math.min(activePart, value.partAnswers.length - 1)];

  const openPart = (index: number) => {
    onReviewStateChange(false);
    setActivePart(index);
  };

  const answerSummary = (item: StructuredPartPublicV1, answer: StructuredPartAnswerV1 | undefined) => {
    if (!answer || item.kind !== answer.kind) return "这个片段还没有有效答案";
    if (item.kind === "ordering" && answer.kind === "ordering") {
      return answer.orderedTokenIds.map((id) => indexedPublicLabel(item.publicTokenLabels, item.publicTokenIds, id, "排序项")).join(" → ");
    }
    if (item.kind === "relation" && answer.kind === "relation") {
      return answer.edges.map((edge) => `${indexedPublicLabel(item.publicNodeLabels, item.publicNodeIds, edge.fromNodeId, "节点")} ${relationKindLabel(edge.edgeKind)} ${indexedPublicLabel(item.publicNodeLabels, item.publicNodeIds, edge.toNodeId, "节点")}`).join("；");
    }
    if (item.kind === "repair" && answer.kind === "repair") {
      return repairPreviewItems({
        elementIds: item.publicElementIds,
        labels: item.publicElementLabels,
        replacementOptionIds: item.replacementOptionIds,
        replacementLabels: item.replacementOptionLabels,
        operations: answer.operations,
      }).map((preview) => preview.label).join(" → ");
    }
    return "这个片段还没有有效答案";
  };

  if (reviewing) {
    return (
      <div className="run-bundle-review">
        <header><Check size={18} aria-hidden="true" /><div><strong>提交前再看一遍</strong><span>全部证明片段会作为一组答案提交。</span></div></header>
        <ol>
          {interaction.parts.map((item, index) => (
            <li key={item.partId}>
              <span>片段 {index + 1}</span>
              <strong>{item.kind === "ordering" ? "顺序整理" : item.kind === "relation" ? "关系搭建" : "纠错修补"}</strong>
              <p>{answerSummary(item, value.partAnswers[index])}</p>
              <button type="button" className="text-action" onClick={() => openPart(index)}>返回修改</button>
            </li>
          ))}
        </ol>
        <button type="button" className="button" onClick={() => openPart(Math.max(0, interaction.parts.length - 1))}>返回上一步</button>
      </div>
    );
  }

  if (!part || !partValue) return <p className="run-inline-error">组合题的片段数据不完整，请重新同步。</p>;
  const labels = part.kind === "ordering"
    ? part.publicTokenLabels
    : part.kind === "relation"
      ? part.publicNodeLabels
      : part.publicElementLabels;
  const replacementLabels = part.kind === "repair" ? part.replacementOptionLabels : undefined;
  const currentPartReady = structuredPartReady(partValue, part.kind !== "ordering" || touchedOrderingParts.has(part.partId));
  return (
    <div className="run-bundle-editor">
      <div className="run-bundle-progress" role="status" aria-label={`组合证明，第 ${activePart + 1} 个，共 ${interaction.parts.length} 个`}>
        {interaction.parts.map((item, index) => <i key={item.partId} data-active={index <= activePart ? "true" : "false"} data-current={index === activePart ? "true" : "false"} />)}
        <span>{activePart + 1} / {interaction.parts.length}</span>
      </div>
      <section className="run-bundle-part">
        <h4>第 {activePart + 1} 个证明片段</h4>
        <PartEditor
          part={part}
          value={partValue}
          labels={labels}
          replacementLabels={replacementLabels}
          onChange={(nextPart) => {
            const next = [...value.partAnswers] as [StructuredPartAnswerV1] | [StructuredPartAnswerV1, StructuredPartAnswerV1];
            next[activePart] = nextPart;
            if (part.kind === "ordering") {
              setTouchedOrderingParts((current) => new Set([...current, part.partId]));
            }
            onReviewStateChange(false);
            onChange({ ...value, partAnswers: next });
          }}
        />
      </section>
      <footer className="run-bundle-nav">
        <button type="button" className="button" disabled={activePart === 0} onClick={() => openPart(Math.max(0, activePart - 1))}>上一个片段</button>
        <span className="run-bundle-nav__status" role="status">{currentPartReady ? "这个片段已经可以继续" : part.kind === "ordering" ? "先调整一次顺序，再继续" : "先完成这个片段，再继续"}</span>
        <button type="button" className="button primary" disabled={!currentPartReady} onClick={() => {
          const next = activePart + 1;
          setActivePart(next);
          if (next >= interaction.parts.length) onReviewStateChange(true);
        }}>{activePart === interaction.parts.length - 1 ? "复核整组答案" : "下一个片段"}</button>
      </footer>
    </div>
  );
}

export function InteractionEditor({
  task,
  value,
  onChange,
  restoredStructuredDraft,
  onStructuredReviewStateChange,
  onVoiceBusyChange,
}: {
  readonly task: LearningTaskPublic;
  readonly value: ArtifactPayload;
  readonly onChange: (value: ArtifactPayload) => void;
  readonly restoredStructuredDraft: boolean;
  readonly onStructuredReviewStateChange: (ready: boolean) => void;
  readonly onVoiceBusyChange: (busy: boolean) => void;
}) {
  const interaction = task.activeVariant.interaction;

  if (interaction.kind === "voice_teachback" && value.kind === "voice") {
    // 此前这里是一段写死的"当前设备没有可用的语音输入"死路文案：语音载荷类型、
    // 录音器与转写通道都存在，只是这个界面从没把声音接进去。
    return (
      <VoiceTeachbackEditor
        maxSeconds={interaction.maxSeconds}
        value={{ confirmedTranscript: value.confirmedTranscript, correctionMethod: value.correctionMethod }}
        onChange={(next) => onChange({ ...value, confirmedTranscript: next.confirmedTranscript, correctionMethod: next.correctionMethod })}
        onBusyChange={onVoiceBusyChange}
      />
    );
  }

  if (interaction.kind === "text_response" && value.kind === "text") {
    return (
      <label className="run-text-editor">
        <span className="sr-only">用自己的话回答</span>
        <textarea
          aria-label="用自己的话回答"
          maxLength={interaction.maxChars}
          value={value.text}
          onChange={(event) => onChange({ ...value, text: event.target.value })}
          placeholder="先写下你能想起的内容，也可以分点回答。"
        />
        <small className="meta run-text-editor__count">{value.text.length} / {interaction.maxChars}</small>
      </label>
    );
  }

  if (interaction.kind === "single_choice" && value.kind === "choice") {
    return (
      <ChoiceEditor
        ids={interaction.publicOptionIds}
        labels={interaction.publicOptionLabels}
        value={value.selectedOptionId}
        onChange={(selectedOptionId) => onChange({ ...value, selectedOptionId })}
      />
    );
  }

  if (interaction.kind === "true_false" && value.kind === "true_false") {
    return (
      <TrueFalseEditor
        proposition={interaction.proposition}
        value={value.answer}
        onChange={(answer) => onChange({ ...value, answer })}
      />
    );
  }

  if (interaction.kind === "matching" && value.kind === "matching") {
    return (
      <MatchingEditor
        leftIds={interaction.publicLeftIds}
        rightIds={interaction.publicRightIds}
        labels={interaction.publicLabels}
        value={value.assignments}
        onChange={(assignments) => onChange({ ...value, assignments })}
      />
    );
  }

  if (interaction.kind === "ordering" && value.kind === "ordering") {
    return <OrderingEditor ids={interaction.publicTokenIds} labels={interaction.publicTokenLabels} value={value.orderedTokenIds} onChange={(orderedTokenIds) => onChange({ ...value, orderedTokenIds })} />;
  }

  if (interaction.kind === "relation_canvas" && value.kind === "relation") {
    return <PartEditor part={{ kind: "relation", partId: "main", publicNodeIds: interaction.publicNodeIds, allowedEdgeKinds: interaction.allowedEdgeKinds, partTrustCeiling: "facet_eligible", qualificationProfileHash: null }} value={{ kind: "relation", partId: "main", edges: value.edges }} labels={interaction.publicNodeLabels} onChange={(partValue) => partValue.kind === "relation" && onChange({ ...value, edges: partValue.edges })} />;
  }

  if (interaction.kind === "repair" && value.kind === "repair") {
    return <PartEditor part={{ kind: "repair", partId: "main", publicElementIds: interaction.publicElementIds, allowedOperationKinds: interaction.allowedOperationKinds, replacementOptionIds: interaction.replacementOptionIds, partTrustCeiling: "facet_eligible", qualificationProfileHash: null }} value={{ kind: "repair", partId: "main", operations: value.operations }} labels={interaction.publicElementLabels} replacementLabels={interaction.replacementOptionLabels} onChange={(partValue) => partValue.kind === "repair" && onChange({ ...value, operations: partValue.operations })} />;
  }

  if (interaction.kind === "structured_bundle" && value.kind === "structured_bundle") {
    return <StructuredBundleEditor interaction={interaction} value={value} onChange={onChange} restoredDraft={restoredStructuredDraft} onReviewStateChange={onStructuredReviewStateChange} />;
  }

  return <p className="run-inline-error">这道题要的作答方式这台电脑给不了，已经停住没有提交。</p>;
}
