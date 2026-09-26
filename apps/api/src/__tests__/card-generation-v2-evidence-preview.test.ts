/**
 * doc 34 L21 §2 —— 证据预览的落点状态。
 *
 * 这一组用例的**正控制**是第一条：夹具由真的密封计划
 * （`planEvidenceSnapshotsV2`，与写库那一份同一函数）产出，再交给读端的分类函数。
 * 两边算出的哈希必须对上——如果对不上，后面所有"漂移"断言都是在测我自己写错的哈希域。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { planEvidenceSnapshotsV2 } from "@ailearn/shared/card-generation-v2-pipeline";
import { evidenceQuoteCopiesV2, evidenceSnapshotsV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { noteBlocks, noteVersions, notes } from "@ailearn/shared/db-schema/note";
import {
  classifyEvidencePreviewV2,
  EVIDENCE_PREVIEW_SOURCE_STATES_V2,
} from "@ailearn/shared/card-generation-v2-hashing";
import { loadEvidencePreviewItems } from "../modules/card-generation-v2/evidence-preview.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";
const NOTE_ID = "00000000-0000-4000-8000-000000000003";
const NOTE_VERSION_ID = "00000000-0000-4000-8000-000000000004";
const BLOCK_A = "00000000-0000-4000-8000-00000000000a";
/** 显式保存之后那一版：锚点行属于 `NOTE_VERSION_ID`，笔记的当前版本是这一版。 */
const NEW_VERSION_ID = "00000000-0000-4000-8000-00000000000b";

const ORIGINAL = "分布式共识是指多个节点对某个值达成一致。";

function sealPlan(blocks = [{ blockId: BLOCK_A, type: "paragraph", content: ORIGINAL, ordinal: 1 }]) {
  return planEvidenceSnapshotsV2({
    workspaceId: WORKSPACE_ID,
    runId: "00000000-0000-4000-8000-000000000009",
    noteId: NOTE_ID,
    noteVersionId: NOTE_VERSION_ID,
    sourceSnapshotId: SOURCE_SNAPSHOT_ID,
    sourceScope: { kind: "whole_note" },
    blocks,
  });
}

function classify(blockContent: string | null, row: {
  blockContentHash: string | null;
  quoteHash: string | null;
  startOffset: number;
  endOffset: number;
}) {
  return classifyEvidencePreviewV2({
    blockContent,
    blockContentHash: row.blockContentHash,
    quoteHash: row.quoteHash,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
  });
}

describe("classifyEvidencePreviewV2", () => {
  it("密封侧写下的行在读侧判为 located，切片与当初封进去的一致", () => {
    const plan = sealPlan();
    assert.ok(plan.snapshotRows.length > 0, "密封计划必须真的产出证据行");
    for (const row of plan.snapshotRows) {
      const result = classify(ORIGINAL, row);
      assert.equal(result.state, "located");
      assert.equal(result.quote, ORIGINAL.slice(row.startOffset, row.endOffset));
    }
  });

  it("块内容被就地改写 → drifted（并且给出的仍是现在的文字）", () => {
    const [row] = sealPlan().snapshotRows;
    const edited = `${ORIGINAL}后来又补了一句。`;
    const result = classify(edited, row);
    assert.equal(result.state, "drifted");
    assert.equal(result.quote, edited.slice(row.startOffset, row.endOffset));
  });

  it("块变短到切片下标越界 → drifted", () => {
    const [row] = sealPlan().snapshotRows;
    assert.equal(classify("共识", row).state, "drifted");
  });

  it("块行已经不在了 → missing，且不给出任何假装是原文的文字", () => {
    const [row] = sealPlan().snapshotRows;
    const result = classify(null, row);
    assert.equal(result.state, "missing");
    assert.equal(result.quote, "");
  });

  it("内容哈希缺失（手写行）也判 drifted，不能因为少一个字段就放行", () => {
    const [row] = sealPlan().snapshotRows;
    assert.equal(
      classifyEvidencePreviewV2({
        blockContent: ORIGINAL,
        blockContentHash: null,
        quoteHash: row.quoteHash,
        startOffset: row.startOffset,
        endOffset: row.endOffset,
      }).state,
      "drifted",
    );
  });

  it("三态词汇表就是合同里那三个，没有第四种", () => {
    assert.deepEqual([...EVIDENCE_PREVIEW_SOURCE_STATES_V2], ["located", "drifted", "missing"]);
  });
});

// ─── 读点：替身按**表**分派，并记录每一次查询 ───
// 旧形状是"三次 select 按顺序排队"，实现多读一张表就会错到别处去；现在按 `from(...)`
// 收到的那张表分派条目，`queryLog` 把真实顺序留在断言里。没登记过的表直接喊——
// 那正是"实现新读了一张表，先把它在替身里也建出来"的信号。

const TABLE_LABELS = new Map<unknown, string>([
  [evidenceSnapshotsV2, "evidence_snapshots_v2"],
  [noteBlocks, "note_blocks"],
  [noteVersions, "note_versions"],
  [notes, "notes"],
  [evidenceQuoteCopiesV2, "evidence_quote_copies_v2"],
]);

/**
 * @param blocks 按块 id 取回的那些行——线上形状带 `versionId`/`ordinal`，替身就得带。
 * @param anchors 锚点所属版本与它所在笔记的当前版本（跨版本重落那一步读的两张表）。
 */
function fakeTx(
  snapshots: Record<string, unknown>[],
  blocks: { id: string; content: string; versionId?: string; ordinal?: number }[],
  copies: { evidenceSnapshotId: string; quoteText: string }[] = [],
  anchors: {
    versions?: { versionId: string; currentVersionId: string | null }[];
    currentBlocks?: { versionId: string; ordinal: number; content: string }[];
  } = {},
) {
  const queues = new Map<string, unknown[][]>([
    ["evidence_snapshots_v2", [snapshots]],
    // `note_blocks` 被读两次：先按锚点块 id，再按当前版本的 ordinal。
    ["note_blocks", [blocks, anchors.currentBlocks ?? []]],
    ["note_versions", [anchors.versions ?? []]],
    ["evidence_quote_copies_v2", [copies]],
  ]);
  const queryLog: string[] = [];
  const terminal = (label: string) => {
    queryLog.push(label);
    const rows = queues.get(label)?.shift() ?? [];
    return {
      limit: async () => rows,
      then: (
        onFulfilled?: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    select: () => {
      let label = "";
      const chain = {
        where: () => terminal(label),
        innerJoin: () => chain,
      };
      return {
        from: (target: unknown) => {
          const found = TABLE_LABELS.get(target);
          if (!found) throw new Error("替身读不到这张表：实现新加了一次查询，先在替身里登记它");
          label = found;
          return chain;
        },
      };
    },
  };
  return { tx, queryLog };
}

/** 每篇笔记的锚点版本就是当前版本时，读侧走的是"就地改写"那条老路。 */
const CURRENT_ANCHOR = {
  versions: [{ versionId: NOTE_VERSION_ID, currentVersionId: NOTE_VERSION_ID }],
};

describe("loadEvidencePreviewItems", () => {
  it("指不到原文的证据不再被静默丢掉，而是带着 missing 状态回到界面上", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx, queryLog } = fakeTx([row], []);
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.deepEqual(queryLog,
      ["evidence_snapshots_v2", "note_blocks", "evidence_quote_copies_v2"],
      "块行一条都没有，就不该再去读版本（读了也白读）");
    assert.equal(items.length, 1, "旧实现会在这里 continue，把这条证据整个吞掉");
    assert.equal(items[0].sourceState, "missing");
    assert.equal(items[0].preview, "");
  });

  it("内容改过的证据标 drifted，并把现在的文字一起给出去", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx } = fakeTx(
      [row],
      [{ id: BLOCK_A, content: `${ORIGINAL}补了一句。`, versionId: NOTE_VERSION_ID, ordinal: 1 }],
      [],
      CURRENT_ANCHOR,
    );
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.equal(items[0].sourceState, "drifted");
    assert.ok(items[0].preview.startsWith(ORIGINAL));
  });

  it("没变过的证据是 located，且不会凭空多出标记", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx } = fakeTx(
      [row],
      [{ id: BLOCK_A, content: ORIGINAL, versionId: NOTE_VERSION_ID, ordinal: 1 }],
      [],
      CURRENT_ANCHOR,
    );
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.deepEqual(items.map((i) => i.sourceState), ["located"]);
    assert.equal(items[0].preview, ORIGINAL);
  });

  // 显式保存会开新版本，而新版本里每个块都是**新行新 id**（`document-state.ts:419-442`）：
  // 锚点那一行从此冻结在当初的文字上。下面三条钉的是"以当前版本为准重落锚点"这一决策表，
  // 线上那条链（真建版本、真投影块）由 `evidence-anchor-version-drift-postgres.integration.ts` 测。
  describe("锚点属于上一版时按 ordinal 重落", () => {
    const ANCHOR_ROWS = (content: string) => [{
      id: BLOCK_A, content, versionId: NOTE_VERSION_ID, ordinal: 1,
    }];
    const SUPERSEDED = {
      versions: [{ versionId: NOTE_VERSION_ID, currentVersionId: NEW_VERSION_ID }],
    };

    it("当前版那段改了 → drifted，且给回当初那段", async () => {
      const [row] = sealPlan().snapshotRows;
      const { tx, queryLog } = fakeTx(
        [row],
        ANCHOR_ROWS(ORIGINAL),
        [{ evidenceSnapshotId: row.evidenceSnapshotId, quoteText: ORIGINAL }],
        {
          ...SUPERSEDED,
          currentBlocks: [{
            versionId: NEW_VERSION_ID, ordinal: 1, content: ORIGINAL.replace("达成一致", "达成共识"),
          }],
        },
      );
      const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
      assert.deepEqual(queryLog, [
        "evidence_snapshots_v2", "note_blocks", "note_versions", "note_blocks",
        "evidence_quote_copies_v2",
      ], "重落这一步根本没发生");
      assert.equal(items[0].sourceState, "drifted");
      // 切片下标是**旧块长度**，所以给出去的是新块里那一段对应位置的文字。
      assert.equal(items[0].preview, ORIGINAL.replace("达成一致", "达成共识"));
      assert.equal(items[0].originalPreview, ORIGINAL);
    });

    it("当前版那段一字未动 → located（开了新版本不等于内容变了）", async () => {
      const [row] = sealPlan().snapshotRows;
      const { tx } = fakeTx(
        [row],
        ANCHOR_ROWS(ORIGINAL),
        [],
        { ...SUPERSEDED, currentBlocks: [{ versionId: NEW_VERSION_ID, ordinal: 1, content: ORIGINAL }] },
      );
      const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
      assert.deepEqual(items.map((i) => i.sourceState), ["located"]);
    });

    it("当前版连一行投影都没有 → 不报消息（dev 实测 63/69 是这一形）", async () => {
      // 「无从比对」不是「落点没了」：界面上那一句「原文已不在笔记里」是用户可见的断言，
      // 没有可对照的整体时发它就是凭空造事实。
      const [row] = sealPlan().snapshotRows;
      const { tx, queryLog } = fakeTx([row], ANCHOR_ROWS(ORIGINAL), [], SUPERSEDED);
      const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
      assert.deepEqual(queryLog, [
        "evidence_snapshots_v2", "note_blocks", "note_versions", "note_blocks",
        "evidence_quote_copies_v2",
      ], "确实去当前版找过落点（没去找就断言「不报消息」是空的）");
      assert.equal(items[0].sourceState, "located");
      assert.equal(items[0].preview, ORIGINAL);
    });

    it("当前版里没有这个 ordinal → missing，不许拿相邻那块冒充当初的依据", async () => {
      const [row] = sealPlan().snapshotRows;
      const { tx } = fakeTx(
        [row],
        ANCHOR_ROWS(ORIGINAL),
        [{ evidenceSnapshotId: row.evidenceSnapshotId, quoteText: ORIGINAL }],
        { ...SUPERSEDED, currentBlocks: [{ versionId: NEW_VERSION_ID, ordinal: 2, content: "另一段话" }] },
      );
      const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
      assert.equal(items[0].sourceState, "missing");
      assert.equal(items[0].preview, "");
      assert.equal(items[0].originalPreview, ORIGINAL, "落点没了也要给得出当初那段");
    });
  });

  it("refIds 为空时一条查询都不发", async () => {
    const { tx, queryLog } = fakeTx([], []);
    assert.deepEqual(await loadEvidencePreviewItems(tx, WORKSPACE_ID, []), []);
    assert.deepEqual(queryLog, [], "空列表不该消耗任何一次查询");
  });
});


describe("冻结的原文副本（0275 / L21 §1）", () => {
  it("密封计划同时产出副本行，ref 里那个号就是这条证据自己的 id", () => {
    const plan = sealPlan();
    assert.equal(plan.quoteCopyRows.length, plan.snapshotRows.length, "副本行数与证据行数不等");
    for (const [index, row] of plan.snapshotRows.entries()) {
      const copy = plan.quoteCopyRows[index];
      assert.equal(copy.evidenceSnapshotId, row.evidenceSnapshotId);
      assert.equal(copy.quoteHash, row.quoteHash);
      assert.equal(copy.quoteText, ORIGINAL.slice(row.startOffset, row.endOffset));
      assert.equal(
        row.protectedQuoteRef,
        `evidence://snapshot/${row.evidenceSnapshotId}`,
        "ref 又指向一个不存在的对象了（L21 §1 的原症状）",
      );
    }
  });

  it("落点变了且冻过副本 → originalPreview 给出当初那段", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx } = fakeTx(
      [row],
      [{ id: BLOCK_A, content: `${ORIGINAL}补了一句。`, versionId: NOTE_VERSION_ID, ordinal: 1 }],
      [{ evidenceSnapshotId: row.evidenceSnapshotId, quoteText: ORIGINAL }],
      CURRENT_ANCHOR,
    );
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.equal(items[0].sourceState, "drifted");
    assert.equal(items[0].originalPreview, ORIGINAL);
    assert.equal(items[0].preview, ORIGINAL.slice(0, items[0].preview.length), "预览给的是现在的切片");
  });

  it("存量证据没有副本 → null，界面据此说「这段没被冻住」而不是「没有原文」", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx } = fakeTx(
      [row],
      [{ id: BLOCK_A, content: `${ORIGINAL}补了一句。`, versionId: NOTE_VERSION_ID, ordinal: 1 }],
      [],
      CURRENT_ANCHOR,
    );
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.equal(items[0].originalPreview, null);
  });

  it("落点还在时不给副本（那时「当初那段」就是现在这段，标出来只会误导）", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx } = fakeTx(
      [row],
      [{ id: BLOCK_A, content: ORIGINAL, versionId: NOTE_VERSION_ID, ordinal: 1 }],
      [{ evidenceSnapshotId: row.evidenceSnapshotId, quoteText: ORIGINAL }],
      CURRENT_ANCHOR,
    );
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.equal(items[0].sourceState, "located");
    assert.equal(items[0].originalPreview, null);
  });

  it("ref 解析器只认自己写的那种格式", async () => {
    const { parseProtectedQuoteRefV2 } = await import("@ailearn/shared/card-generation-v2-pipeline");
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal(parseProtectedQuoteRefV2(`evidence://snapshot/${id}`), id);
    assert.equal(parseProtectedQuoteRefV2(null), null);
    assert.equal(parseProtectedQuoteRefV2("evidence://snapshot/不是uuid"), null);
    assert.equal(parseProtectedQuoteRefV2(`https://example.com/${id}`), null);
  });
});

describe("证据预览只剩一个读点", () => {
  const files = [
    "../modules/card-generation-v2/reveal-service.ts",
    "../modules/card-generation-v2/card-service.ts",
  ];
  for (const rel of files) {
    it(`${rel.split("/").pop()} 不再自己切 note_blocks 原文`, () => {
      const source = readFileSync(new URL(rel, import.meta.url), "utf8");
      assert.ok(source.length > 500, "读到了文件内容（否则这条断言是空的）");
      assert.match(source, /loadEvidencePreviewItems/, "必须走那个唯一读点");
      assert.doesNotMatch(source, /noteBlocks/, "不许再直接读块正文");
    });
  }
});
