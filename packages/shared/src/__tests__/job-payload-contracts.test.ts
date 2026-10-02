import assert from "node:assert/strict";
import { test } from "node:test";
import { JobType } from "../enums.ts";
import {
  JobPayloadContractError,
  PARSE_SOURCE_JOB_PAYLOAD_FIELDS,
  readNoteAnnotationExplainJobPayload,
  readNoteDynamicArtifactGenerateJobPayload,
  readNoteExpansionGenerateJobPayload,
  readParseSourceJobPayload,
} from "../contracts/job-payload-contracts.ts";

// 稳定 P1（2026-09-15 审计）：jobs.payload 在非 companion 类型上的精确契约。
// 读取器必须 fail closed——坏载荷要是被"宽容地"读成 undefined，问题会晚到
// 使用该字段的地方才炸（历史上就是 "missing sourceId in payload" 的可重试失败）。

test("parse_source payload：合法输入被归一化", () => {
  const minimal = readParseSourceJobPayload({ sourceId: "src-1" });
  assert.deepEqual(minimal, { sourceId: "src-1", fetchUrlContent: false });

  const withFetch = readParseSourceJobPayload({ sourceId: "src-1", fetchUrlContent: true });
  assert.deepEqual(withFetch, { sourceId: "src-1", fetchUrlContent: true });

  // 无关字段不影响读取（payload 是 jsonb，允许携带未来字段）。
  const extra = readParseSourceJobPayload({ sourceId: "src-1", traceId: "t-1", userId: "u-1" });
  assert.deepEqual(extra, { sourceId: "src-1", fetchUrlContent: false });
});

test("parse_source payload：fetchUrlContent 只认字面 true", () => {
  // 脏值不得被当成"要抓 URL"（那会对外发起非预期请求）；当成 false 只是不抓正文，
  // 用户可以重试，两害相权取后者。
  for (const dirty of ["true", 1, "1", {}, [], "yes"]) {
    assert.equal(
      readParseSourceJobPayload({ sourceId: "src-1", fetchUrlContent: dirty }).fetchUrlContent,
      false,
      `fetchUrlContent=${JSON.stringify(dirty)} 不应被当成 true`,
    );
  }
});

test("parse_source payload：缺字段 / 类型不对 / 非对象一律抛契约错误", () => {
  const cases: Array<[string, unknown]> = [
    ["null payload", null],
    ["undefined payload", undefined],
    ["数组 payload", []],
    ["字符串 payload", "sourceId=1"],
    ["缺 sourceId", {}],
    ["sourceId 为空串", { sourceId: "" }],
    ["sourceId 只有空白", { sourceId: "   " }],
    ["sourceId 是数字", { sourceId: 42 }],
    ["sourceId 是 null", { sourceId: null }],
    ["sourceId 是对象", { sourceId: { id: "src-1" } }],
  ];
  for (const [label, payload] of cases) {
    assert.throws(
      () => readParseSourceJobPayload(payload as Record<string, unknown> | null | undefined),
      (error: unknown) => {
        assert.ok(error instanceof JobPayloadContractError, `${label}: 必须是 JobPayloadContractError`);
        // 结构化字段让 worker 侧能按类型分类（→ 不可重试），不必解析消息文本。
        assert.equal(error.code, "job_payload_contract_error", label);
        assert.equal(error.jobType, JobType.PARSE_SOURCE, label);
        assert.match(error.message, /parse_source/, label);
        return true;
      },
      label,
    );
  }
});

test("字段名常量与读取器实现同源", () => {
  // 常量是给"读同一份 payload 的其它调用方"用的；一旦它与实现漂移，
  // 这条断言会失败（而不是某个调用方静默读不到值）。
  const payload = {
    [PARSE_SOURCE_JOB_PAYLOAD_FIELDS.sourceId]: "src-1",
    [PARSE_SOURCE_JOB_PAYLOAD_FIELDS.fetchUrlContent]: true,
  };
  assert.deepEqual(readParseSourceJobPayload(payload), {
    sourceId: "src-1",
    fetchUrlContent: true,
  });
});

const notePayload = {
  noteId: "00000000-0000-4000-8000-000000000001",
  noteVersionId: "00000000-0000-4000-8000-000000000002",
  requestId: "00000000-0000-4000-8000-000000000003",
};
const noteAnchor = {
  noteVersionId: notePayload.noteVersionId,
  startBlockOrdinal: 2,
  startOffset: 12,
  endBlockOrdinal: 3,
  endOffset: 4,
  excerpt: "第一段的末尾。\n\n下一段。",
  prefix: "第一段开头",
  suffix: "接下来的内容",
};
const noteAnchorReaders = [
  ["解释", (anchor: typeof noteAnchor) => readNoteAnnotationExplainJobPayload({ ...notePayload, anchor }).anchor],
  ["互动演示", (anchor: typeof noteAnchor) => readNoteDynamicArtifactGenerateJobPayload({ ...notePayload, sourceKind: "annotation", anchor }).anchor],
  ["选段拓展", (anchor: typeof noteAnchor) => readNoteExpansionGenerateJobPayload({ ...notePayload, focusAnchor: anchor }).focusAnchor],
] as const;

for (const [label, readAnchor] of noteAnchorReaders) {
  test(`${label}任务入口接受跨段锚点，末段偏移独立于首段偏移`, () => {
    assert.deepEqual(readAnchor(noteAnchor), noteAnchor);
    const endAtBoundary = { ...noteAnchor, endOffset: 0 };
    assert.deepEqual(readAnchor(endAtBoundary), endAtBoundary);
  });

  test(`${label}任务入口保留单段支持，拒绝倒序、空范围和版本错配`, () => {
    const singleBlock = { ...noteAnchor, endBlockOrdinal: 2, endOffset: 16 };
    assert.deepEqual(readAnchor(singleBlock), singleBlock);
    for (const anchor of [
      { ...noteAnchor, endBlockOrdinal: 1 },
      { ...singleBlock, endOffset: 12 },
      { ...singleBlock, endOffset: 4 },
      { ...noteAnchor, startOffset: -1 },
      { ...noteAnchor, endOffset: -1 },
      { ...noteAnchor, noteVersionId: notePayload.noteId },
    ]) {
      assert.throws(() => readAnchor(anchor), JobPayloadContractError);
    }
  });
}
