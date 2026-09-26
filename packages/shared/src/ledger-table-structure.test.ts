/**
 * 39d 实施台账的表格结构守卫：一行被竖线悄悄撑坏，必须让这条用例红。
 *
 * 为什么要有这条：`docs/plans/learning-companion/39d-implementation-task-breakdown-2026-09-24.md`
 * 是唯一台账（它自己的规矩写着「状态列就是唯一台账」）。它靠多轮**追加回写**长大，两类表被反复往里加行：
 * §19「实施日志」（4 列：日期／任务 ID／改了什么／命令与读数）与各波次的状态格表
 * （6 列：ID／任务／依据／依赖／完成判据／状态）。这种错不红、不改行为，只会让某一格的内容跑到隔壁列去，
 * 所以人眼扫过去是看不见的——2026-09-26 一天里手工修了 5 处，而**没有任何东西挡住下一次**：
 * 写那段修复说明的当场就又犯了一次。这条守卫就是那次犯错的产物。
 *
 * 三类真实成因（都取自本文件，不是设想）：
 * 1. **code span 里的裸竖线被 GFM 当成列分隔**——写的人以为反引号能护住它，GFM 不认，那一行当场多出一格。
 *    真实例子：`` `dirty || saveState === "error"` ``、`` `setMode('pass' | 'writes-fail')` ``、
 *    `` `{ limit, originalLength } | null` ``。这三处今天的正确形态是把竖线写成 `\|`（台账 637 行那条修复说明里
 *    就是这么记的——它自己也曾因为把这个字符裸着放进 code span 而撑坏过一次）。
 * 2. **多写一根分隔符**：行尾长成 `…… | |`，凭空多出一个空格子。
 * 3. **把两列并成一段写**：少一根竖线，于是后面每一格整体左移一列——§19 里那 5 条把「改了什么」与
 *    「命令与读数」并成一段的历史行就是这个形状（见 MERGED_CELLS_HISTORY_ROWS）。
 *
 * 判据三条，逐条自证：格数从每张表的表头分隔行**现读**（不抄第二份数字）；豁免名单写明理由、按内容定位
 * （不用会漂的行号）、要求名单里每一条**现在确实仍是坏的**、且只许变短；再加内存里的变异自证
 * （插一根裸竖线 ⇒ 红，去掉反斜杠转义 ⇒ 红），保证「绿」不是因为判据读不到东西。
 * 本守卫只读文档，一个字节都不往 `docs/**` 上写。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 包外相对路径：src → shared → packages → 仓库根。
 * 读不到就当场抛（不做 existsSync + return 那种"跳过"），否则文档一挪走这条守卫就静默恒绿——
 * 那正是它要防的形状：一条永远绿的守卫比没有守卫更糟。
 */
const LEDGER_URL = new URL(
  "../../../docs/plans/learning-companion/39d-implementation-task-breakdown-2026-09-24.md",
  import.meta.url,
);

const LEDGER_LINES: string[] = readFileSync(LEDGER_URL, "utf8").split("\n");

/** §19 实施日志表头的首格，用来认出「豁免名单只对这张表生效」。 */
const LOG_TABLE_HEADER_FIRST_CELL = "日期";

/** 围栏代码块里的 `|` 不是表格内容（本文件当前没有围栏，防的是以后往里贴复现配方）。 */
const FENCE = /^ {0,3}(?:```|~~~)/;
const TABLE_ROW = /^ {0,3}\|/;
const DELIMITER_ROW = /^ {0,3}\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * 未转义竖线的位置：一个 `|` 前面反斜杠成对抵消后剩单数根才算被转义。
 * 所以 `\|`（正确写法）不算分隔符，`\\|`（字面反斜杠 + 竖线）算。
 */
function unescapedPipeIndices(line: string): number[] {
  const out: number[] = [];
  let backslashes = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === "|" && backslashes % 2 === 0) out.push(i);
    backslashes = 0;
  }
  return out;
}

/** 切成单元格：行首/行尾那两根不是分隔符。格数与定位键都由这一个函数派生，不留第二份口径。 */
function splitCells(line: string): string[] {
  const text = line.trim();
  const indices = unescapedPipeIndices(text);
  if (indices.length === 0) return [text];
  const parts: string[] = [];
  let prev = 0;
  for (const at of indices) {
    parts.push(text.slice(prev, at));
    prev = at + 1;
  }
  parts.push(text.slice(prev));
  if (indices[0] === 0) parts.shift();
  if (indices[indices.length - 1] === text.length - 1) parts.pop();
  return parts.map((part) => part.trim());
}

interface LedgerRow {
  line: number;
  cells: number;
  firstCell: string;
  secondCell: string;
  text: string;
}

interface LedgerTable {
  headerLine: number;
  expectedColumns: number;
  isLogTable: boolean;
  rows: LedgerRow[];
}

function toLedgerRow(lineNo: number, line: string): LedgerRow {
  const cells = splitCells(line);
  return {
    line: lineNo,
    cells: cells.length,
    firstCell: cells[0] ?? "",
    secondCell: cells[1] ?? "",
    text: line,
  };
}

/** 一张表 = 表头行 + 只由 `|` `-` `:` 组成的分隔行 + 紧随其后的连续数据行。 */
function parseLedgerTables(lines: string[]): LedgerTable[] {
  const tables: LedgerTable[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !TABLE_ROW.test(lines[i]) || !DELIMITER_ROW.test(lines[i + 1] ?? "")) continue;
    const rows: LedgerRow[] = [];
    let j = i + 2;
    for (; j < lines.length && TABLE_ROW.test(lines[j]); j++) rows.push(toLedgerRow(j + 1, lines[j]));
    tables.push({
      headerLine: i + 1,
      // 列数从分隔行现读：它是这张表唯一的形状真相，表头自己也要被它对账
      expectedColumns: splitCells(lines[i + 1]).length,
      isLogTable: splitCells(lines[i])[0] === LOG_TABLE_HEADER_FIRST_CELL,
      rows,
    });
    i = j - 1;
  }
  return tables;
}

interface Violation {
  line: number;
  headerLine: number;
  expectedColumns: number;
  cells: number;
  firstCell: string;
  secondCell: string;
  isLogTable: boolean;
}

function findViolations(lines: string[]): Violation[] {
  const out: Violation[] = [];
  for (const table of parseLedgerTables(lines)) {
    // 表头行自己也在内：它和分隔行不一致是同一类结构病
    for (const row of [toLedgerRow(table.headerLine, lines[table.headerLine - 1]), ...table.rows]) {
      if (row.cells !== table.expectedColumns) {
        out.push({
          line: row.line,
          headerLine: table.headerLine,
          expectedColumns: table.expectedColumns,
          cells: row.cells,
          firstCell: row.firstCell,
          secondCell: row.secondCell,
          isLogTable: table.isLogTable,
        });
      }
    }
  }
  return out;
}

/**
 * 历史行豁免名单：§19 里把「改了什么」与「命令与读数」并成一段写的旧行——3 格 vs 表头 4 格。
 *
 * 为什么豁免而不修：这 5 条的正文已经长成一段连贯叙述，硬拆两列会把当时记录下的因果剪断，
 * 而它们记的是**已交付的事实**；台账的读者要的是那条记录，不是它的列对齐。新行一律要求 4 格。
 *
 * 为什么不用行号定位：追加回写会让行号整片往下漂，用行号写名单等于这名单第二天就失效。
 * 所以键是「首格日期 + 第二格前缀」这种内容键。
 */
const MERGED_CELLS_HISTORY_ROWS: Array<{ date: string; taskIdPrefix: string; reason: string }> = [
  {
    date: "2026-09-24",
    taskIdPrefix: "W2-2（**确定性层收口",
    reason: "「改了什么」①②③与「命令与读数」并成一段叙述，拆列会剪断当时的因果",
  },
  {
    date: "2026-09-24",
    taskIdPrefix: "W2-2（**性能门：量了新增查询",
    reason: "同上：索引形状与「今天过、会随表长」的结论是一句连贯判断，不是一读一答两栏",
  },
  {
    date: "2026-09-24",
    // 必须长到 `：机制settle` 这一截：§19 里另有两条 W2-2（`assessment`/`result` …）的健康行，
    // 键只写到 `assessment` 会一次撞上 3 行（414／415／416），「唯一」这条判据就是防这个
    taskIdPrefix: "W2-2（**`assessment`/`result`：机制settle",
    reason: "同上：机制 settle、撞上 Hooks 阻塞、已还原，是同一条因果链",
  },
  {
    date: "2026-09-25",
    taskIdPrefix: "**交接快照（本会话收在这一点上",
    reason: "交接快照整段是一封信，不是一行三栏；这一行当时就是照一段写的",
  },
  {
    date: "2026-09-25",
    taskIdPrefix: "**W4-4 第一半：有未提交编辑时",
    reason: "同上：判据与读数交织，且这一行还带着已正确转义的 `\\|`",
  },
];

/** 名单只许变短：有人修好了就该删条目，不许往里加。上限钉在当前条数。 */
const MERGED_CELLS_ROWS_CEILING = 5;

function isExemptMergedRow(violation: Violation): boolean {
  return (
    violation.isLogTable &&
    MERGED_CELLS_HISTORY_ROWS.some(
      (entry) =>
        violation.firstCell === entry.date &&
        violation.secondCell.startsWith(entry.taskIdPrefix),
    )
  );
}

function violationsBeyondExemptionList(lines: string[]): Violation[] {
  return findViolations(lines).filter((violation) => !isExemptMergedRow(violation));
}

function describeViolation(violation: Violation): string {
  return (
    `第 ${violation.line} 行（表头在第 ${violation.headerLine} 行）：读到 ${violation.cells} 格，` +
    `而该表分隔行是 ${violation.expectedColumns} 列 —— 首格「${violation.firstCell}」` +
    `／第二格「${violation.secondCell.slice(0, 40)}」`
  );
}

function logTable(lines: string[]): LedgerTable {
  const table = parseLedgerTables(lines).find((entry) => entry.isLogTable);
  assert.ok(table, "没找到 §19 实施日志表（表头首格应是「日期」）");
  return table;
}

test("台账读得到，判据真的在读东西（分母自证）", () => {
  const tables = parseLedgerTables(LEDGER_LINES);
  const dataRows = tables.reduce((sum, table) => sum + table.rows.length, 0);
  // 分母一塌，「0 处结构违规」就变成假绿：这份台账实测 17 张表、388 条数据行（§19 单表 243 条）
  assert.ok(tables.length >= 17, `只读到 ${tables.length} 张表，这条判据没在读东西`);
  assert.ok(dataRows >= 380, `只读到 ${dataRows} 条数据行，这条判据没在读东西`);
  assert.equal(
    logTable(LEDGER_LINES).expectedColumns,
    4,
    "§19 应是 4 列：日期／任务 ID／改了什么／命令与读数",
  );
  assert.ok(
    LEDGER_LINES.filter((line) => line.includes("\\|")).length >= 12,
    "台账里已在使用 `\\|` 这种正确写法；这个数掉下去说明转义约定被抹了，判据会退化成恒绿",
  );
});

test("每一条数据行的未转义竖线数与该表表头一致", () => {
  const broken = violationsBeyondExemptionList(LEDGER_LINES);
  assert.deepEqual(
    broken.map(describeViolation),
    [],
    "台账的表格结构被竖线撑坏了（那一格的内容会跑到隔壁列去）。" +
      "修法：把裸竖线写成 `\\|`、删掉多写的那一根、或把并掉的那根补回去。" +
      "只有 §19 那段历史行可以豁免，且必须写进 MERGED_CELLS_HISTORY_ROWS 并写明理由——" +
      `名单硬上限 ${MERGED_CELLS_ROWS_CEILING} 条，只许变短，加不进去的就得修文档。`,
  );
});

test("豁免名单：每条现在确实仍是坏的，且只许变短", () => {
  assert.ok(
    MERGED_CELLS_HISTORY_ROWS.length <= MERGED_CELLS_ROWS_CEILING,
    `名单已 ${MERGED_CELLS_HISTORY_ROWS.length} 条 > 上限 ${MERGED_CELLS_ROWS_CEILING} 条：` +
      "它只许变短。新行的列数照表头写对，不要往名单里塞。",
  );
  const table = logTable(LEDGER_LINES);
  for (const entry of MERGED_CELLS_HISTORY_ROWS) {
    const hits = table.rows.filter(
      (row) => row.firstCell === entry.date && row.secondCell.startsWith(entry.taskIdPrefix),
    );
    assert.equal(
      hits.length,
      1,
      `名单条目「${entry.date} · ${entry.taskIdPrefix}」按内容定位到 ${hits.length} 行（必须是 1 行）：` +
        "这个键已经不对着那条历史行了，换一个内容键",
    );
    assert.notEqual(
      hits[0].cells,
      table.expectedColumns,
      `名单条目「${entry.date} · ${entry.taskIdPrefix}」（现第 ${hits[0].line} 行）已经是 ` +
        `${hits[0].cells} 格＝与表头一致＝有人修好了：把这条从名单里删掉，` +
        "否则名单会慢慢腐烂成随手豁免",
    );
    assert.ok(entry.reason.trim().length > 0, `名单条目「${entry.taskIdPrefix}」没写理由`);
  }
});

test("灵敏度自证：多插一根裸竖线、或并掉一根，判据都必须红", () => {
  const clean = cleanLogRow();
  // 变异一律在 trim 过的行上做：行首缩进和行尾空格都会让"第几根竖线"与 slice 下标错位
  const base = clean.text.trim();

  // 成因 2（多写一根）：在最右格后面再塞一根裸竖线，凭空多出一个空格子
  const extra = LEDGER_LINES.slice();
  extra[clean.line - 1] = `${base.slice(0, -1)}| 多写的一格 |`;
  const caughtExtra = violationsBeyondExemptionList(extra).filter((v) => v.line === clean.line);
  assert.equal(caughtExtra.length, 1, "插一根裸竖线之后判据没红——这条守卫只是在读空气");
  assert.equal(caughtExtra[0].expectedColumns, 4, "点名时必须带上从表头现读到的列数");
  assert.equal(caughtExtra[0].cells, clean.cells + 1, "多一根竖线就该多出一格");

  // 成因 3（并成一段）：把第二根竖线去掉，等于两列并成一格、后面整体左移
  const merged = LEDGER_LINES.slice();
  const secondPipe = unescapedPipeIndices(base)[1];
  merged[clean.line - 1] = base.slice(0, secondPipe) + base.slice(secondPipe + 1);
  assert.equal(
    violationsBeyondExemptionList(merged).filter((v) => v.line === clean.line).length,
    1,
    "并掉一根竖线之后判据没红——那两列并成一段这类错它抓不到",
  );

  // 正控制：这两次红都只该指向被变异的那一行，磁盘上其它行不受牵连
  assert.equal(
    violationsBeyondExemptionList(extra).filter((v) => v.line !== clean.line).length,
    violationsBeyondExemptionList(LEDGER_LINES).length,
    "变异一行却带红了别的行——判据读的是整篇而不是这一行，红会失去归因",
  );

  // 反向自证：照报错给的修法删掉多写的那一根，该行必须重新通过（判据不能是一条修不掉的红）
  const repaired = LEDGER_LINES.slice();
  repaired[clean.line - 1] = extra[clean.line - 1].replace(/ \| 多写的一格 \|$/, " |");
  assert.equal(repaired[clean.line - 1], base, "补平后的行没回到原样——那这条自证没在自证");
  assert.equal(
    violationsBeyondExemptionList(repaired).filter((v) => v.line === clean.line).length,
    0,
    "按报错里给的修法补平后仍被点名——那条修法提示是错的，或者判据恒红",
  );
});

test("灵敏度自证：去掉反斜杠转义，判据必须红", () => {
  // 成因 1 的正身：`\|` 一旦漏掉反斜杠，GFM 就当它是列分隔
  const row = escapedPipeRow();
  const deEscaped = row.text.replace(/\\\|/g, "|");
  assert.notEqual(deEscaped, row.text, "样本行里没找到 `\\|`，这条变异自证没在证任何东西");
  const mutated = LEDGER_LINES.slice();
  mutated[row.line - 1] = deEscaped;
  const caught = violationsBeyondExemptionList(mutated).filter((v) => v.line === row.line);
  assert.equal(caught.length, 1, "去掉转义之后判据没红——裸竖线那类错照样会溜过去");
  assert.ok(
    caught[0].cells > row.cells,
    `转义应当保护的是格数：${row.cells} 格 → ${caught[0].cells} 格，没变大说明未转义竖线算错了`,
  );
  // 同一行在磁盘上是好的：证明红是这次变异带来的，不是文档本来就坏
  assert.equal(
    findViolations(LEDGER_LINES).filter((v) => v.line === row.line).length,
    0,
    `第 ${row.line} 行本来就不干净，这条灵敏度自证失去对照`,
  );
});

/** 一条现在健康、4 格、以 `|` 收尾的 §19 数据行，当作内存变异的样本。 */
function cleanLogRow(): LedgerRow {
  const table = logTable(LEDGER_LINES);
  const broken = new Set(findViolations(LEDGER_LINES).map((v) => v.line));
  const row = table.rows.find(
    (candidate) =>
      candidate.cells === table.expectedColumns &&
      !broken.has(candidate.line) &&
      candidate.text.trimEnd().endsWith("|"),
  );
  assert.ok(row, "找不到一条干净的 4 格数据行，灵敏度自证失去样本");
  return row;
}

/** 一条健康的数据行，且它真的在用 `\|` 转义（这些行都来自各波次的状态格表与 §19）。 */
function escapedPipeRow(): LedgerRow {
  const broken = new Set(findViolations(LEDGER_LINES).map((v) => v.line));
  const candidates = parseLedgerTables(LEDGER_LINES)
    .flatMap((table) => [toLedgerRow(table.headerLine, LEDGER_LINES[table.headerLine - 1]), ...table.rows])
    .filter(
      (row) => !broken.has(row.line) && row.text.includes("\\|") && row.text.trimEnd().endsWith("|"),
    );
  assert.ok(candidates.length > 0, "台账里找不到一条用了 `\\|` 的健康行，灵敏度自证没有样本");
  return candidates[0];
}
