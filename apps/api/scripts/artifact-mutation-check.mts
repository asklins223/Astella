/**
 * 变异自证（39d W4-1 尾；39 §6.1／§6.3／§15.5／§16.4）。
 *
 * ## 为什么它是脚本而不是"我当时手工改了一遍"
 *
 * "改坏了看见有红的就算"这种自证对**任何**一条判据都成立，包括那些其实在空转的。所以
 * 每一项必须同时满足三条，缺一条就当没验：
 *
 *   1) 跑得起来 —— 没有 `Cannot find module` / `SyntaxError` / `Unexpected token`，也
 *      没有"某个导出没了"（红在加载上说明这次变异根本没测到判据）；
 *   2) 至少一条用例变红；
 *   3) 变红的用例里包含**指名的那一条**。
 *
 * 只满足 (2) 的自证是自欺：把测试文件自己改坏也能让一切变红。
 *
 * 跑法（apps/api 下）：
 *   node --import tsx scripts/artifact-mutation-check.mts
 *   node --import tsx scripts/artifact-mutation-check.mts --list      # 只列清单
 *
 * 它会**自己还原**：每项跑完立刻把文件写回原样，`finally` 里再兜一次。基线不绿时直接
 * 拒绝开跑（"基线就不绿"时任何"变红"都说明不了问题）。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "..");
const ROOT = resolve(API, "../..");

interface Mutation {
  readonly name: string;
  /** 相对仓库根。 */
  readonly file: string;
  readonly edits: readonly { readonly old: string; readonly new: string }[];
  /** 必须因此变红的用例名片段（至少一条要命中）。 */
  readonly expect: readonly string[];
}

const MODULE = "apps/api/src/modules/note-learning-rounds";
const SHARED_ARTIFACT = "packages/shared/src/note-dynamic-artifact";
/** 被测文件 → 跑哪一份单测。 */
const TEST_FOR: Record<string, string> = {
  [`${MODULE}/artifact-failure.ts`]: `${MODULE}/artifact-failure.test.ts`,
};
const DEFAULT_TEST = `${MODULE}/round-artifact-generation.test.ts`;

const MUTATIONS: readonly Mutation[] = [
  {
    name: "M1 §6.1 模型写数字被拒",
    file: `${SHARED_ARTIFACT}/round-artifact-model.ts`,
    edits: [{
      old: `  steps: z.array(z.strictObject({
    /** 这一步在讲什么（≤ 200 字）。它同时是**文字等价表达**（§6.3）与降级分镜的正文。 */
    narration: z.string().trim().min(1).max(200),
  })).min(1).max(8),`,
      new: `  steps: z.array(z.object({
    narration: z.string().trim().min(1).max(200),
  }).passthrough()).min(1).max(8),`,
    }],
    expect: ["§6.1 结构保证：模型的输出合同收不下任何数字字段"],
  },
  {
    name: "M2 §6.1 示意声明可被模型顶替",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{
      old: `    + \`<p class="ailearn-art__notice">\${escapeArtifactTextV1(ARTIFACT_ILLUSTRATION_NOTICE_V1)}</p>\``,
      new: "    + ``",
    }],
    expect: ["§6.1：服务端无条件加示意声明，模型写的那一句替代不了它"],
  },
  {
    name: "M3 §6.1 实测话拦不住",
    file: `${SHARED_ARTIFACT}/round-artifact-measure.ts`,
    edits: [{
      old: `  return text.split(CLAUSE_SPLIT_V1).some((clause) => {
    const lower = clause.toLowerCase();`,
      new: `  return text.split(CLAUSE_SPLIT_V1).some((clause) => {
    if (clause.length >= 0) return false;
    const lower = clause.toLowerCase();`,
    }],
    expect: ["§6.1：声称实测过的那一类话在落库之前被整份拒掉", "§6.1 真模型跑出来的回归"],
  },
  {
    name: "M4 §6.1 读数映射不夹取（150% 撑破布局）",
    file: `${SHARED_ARTIFACT}/round-artifact-measure.ts`,
    edits: [{
      old: "  return Math.min(100, Math.max(value > 0 ? 2 : 0, Number((ratio * 100).toFixed(2))));",
      new: "  return Number((ratio * 100).toFixed(2));",
    }],
    expect: ["§6.1：参数→结果映射只有服务端那一条"],
  },
  {
    name: "M5 §6.3 不再听宿主的 reduced 指令",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{
      old: `  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== 'host->frame') return;
    if (data.command === 'motion' && data.motion === 'reduced') setStatic();
  });`,
      new: "  window.addEventListener('message', function (event) { void event; });",
    }],
    expect: ["§6.3 静态分镜：播放器在 reduced 下停掉自动播放并换掉控制条"],
  },
  {
    name: "M6 §6.3 单步越界（最后一步之后画面清空）",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{ old: "    if (i < 0) i = 0; if (i >= count) i = count - 1;", new: "    if (i < 0) i = 0;" }],
    expect: ["§6.3 暂停／单步／重播：控制条上有这四件"],
  },
  {
    name: "M7 §6.3 去掉重播按钮",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{
      old: "    bar.appendChild(play); bar.appendChild(prev); bar.appendChild(next); bar.appendChild(replay); bar.appendChild(note);",
      new: "    bar.appendChild(play); bar.appendChild(prev); bar.appendChild(next); bar.appendChild(note);",
    }],
    expect: ["§6.3 暂停／单步／重播：控制条上有这四件"],
  },
  {
    name: "M8 §6.3 控制条留在 root 里（静态分镜会复制 N 份）",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{ old: "    document.body.appendChild(bar);", new: "    root.appendChild(bar);" }],
    expect: ["控制条被移出 root"],
  },
  {
    name: "M9 §6.3 文字等价表达被拿掉",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{
      old: '    + `<ol class="ailearn-art__list">${list.join("")}</ol>`',
      new: '    + `<ol class="ailearn-art__list"></ol>`',
    }],
    expect: ["§6.3 文字等价：每一步的讲解", "渲染器产出的标记确实是播放器查询的那一套"],
  },
  {
    name: "M10 §6.3 快照绑定那一行被拿掉",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{
      old: '    + `<p class="ailearn-art__meta">${escapeArtifactTextV1(buildMetaLineV1(input.snapshotHash, input.generatorRef))}</p>`',
      new: '    + `<p class="ailearn-art__meta"></p>`',
    }],
    expect: ["§6.3 绑定：画面上写明按哪一版材料、用哪一版生成器做的"],
  },
  {
    name: "M11 §6.3 伪造百分比进度",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{
      old: "  return `第 ${readout.value}${escapeArtifactTextV1(readout.unit)}`;",
      new: "  return `第 ${readout.value}${escapeArtifactTextV1(readout.unit)}（约 ${Math.round(readout.value / nodes.length * 100)}%）`;",
    }],
    expect: ["§6.3 不伪造进度：产物里没有任何进度条，只说第几步"],
  },
  {
    name: "M12 §15.5 自己写执行循环（绕过公共内核那道闸）",
    file: `${SHARED_ARTIFACT}/round-artifact-model.ts`,
    edits: [{
      old: "    currentActiveTransaction: options.currentActiveTransaction,",
      new: "    currentActiveTransaction: () => undefined,",
    }],
    expect: ["§15.5：往里塞一个活动事务，那一次模型调用被公共内核真的拒掉"],
  },
  {
    name: "M13 §15.5 不走 runAiTask",
    file: `${SHARED_ARTIFACT}/round-artifact-model.ts`,
    edits: [{
      old: "  const receipt = await runAiTask(task, {",
      new: "  const receipt = await (async () => task.commit && ({ outcome: \"committed\", output: null, usage: { modelCalls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 }, failure: null, preservedValidResult: false, resumedFromCheckpoint: false, modelCalls: 0 }))({",
    }],
    expect: ["§15.5：这一发真的是通过 runAiTask 跑的"],
  },
  {
    name: "M14 §16.4 generate 档从组合表里消失",
    file: `${MODULE}/artifact-failure.ts`,
    edits: [{ old: '  generate: ["model_failed", "contract_rejected"],', new: "  generate: []," }],
    expect: ["两档 generate 失败都真的落得到那张表", "组合非法时抛"],
  },
  {
    name: "M15 §6.2 生成失败与判据未达成混成一句",
    file: `${SHARED_ARTIFACT}/round-artifact-model.ts`,
    edits: [{
      old: '      failure: rejected ? "contract_rejected" : "model_failed",',
      new: '      failure: "model_failed",',
    }],
    expect: ["生成失败与判据未达成是**两句不同的话**"],
  },
  {
    name: "M16 确定性被破坏（产物里写进时间戳）",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{
      old: '    + `<p class="ailearn-art__meta">',
      new: '    + `<p class="ailearn-art__meta">${Date.now()} ',
    }],
    expect: ["确定性：同一份分镜渲染两次逐字节相同"],
  },
  {
    name: "M17 材料里的标签不再转义成文本",
    file: `${MODULE}/round-artifact.ts`,
    edits: [{ old: '    .replaceAll("<", "&lt;")', new: '    .replaceAll("<", "")' }],
    expect: ["材料的恶意文本只能成为文本", "转义：材料里带来的一句"],
  },
  {
    name: "M18 §6.3 步进只改计数器不改画面状态",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{ old: "    var kids = stage.querySelectorAll('[data-node]');", new: "    var kids = [];" }],
    expect: ["§6.3 步进真的改画面状态"],
  },
  {
    name: "M19 §6.1 退回整段扫关键字（真模型实测 8 样本误毙 2 个的那一版）",
    file: `${SHARED_ARTIFACT}/round-artifact-measure.ts`,
    edits: [
      { old: "  return text.split(CLAUSE_SPLIT_V1).some((clause) => {", new: "  return [text].some((clause) => {" },
      {
        old: "      if (MEASUREMENT_DISCLAIMERS_V1.some((disclaimer) => before.includes(disclaimer))) continue;",
        new: "      if (false && MEASUREMENT_DISCLAIMERS_V1.some((disclaimer) => before.includes(disclaimer))) continue;",
      },
    ],
    expect: ["§6.1 真模型跑出来的回归：诚实的免责**不许**被判成违规"],
  },
  {
    name: "M20 §6.1 免责护住整段（同段后半句的声明漏过去）",
    file: `${SHARED_ARTIFACT}/round-artifact-measure.ts`,
    edits: [{ old: "  return text.split(CLAUSE_SPLIT_V1).some((clause) => {", new: "  return [text].some((clause) => {" }],
    expect: ["§6.1 真模型跑出来的回归：诚实的免责**不许**被判成违规"],
  },
  {
    // 这一条是接到真桌面那一侧才暴露的：reduced 之后播放器的监听器先跑（内容在模板
    // 脚本之前 ⇒ 监听器先注册），把 render 一起关掉，于是模板的 staticStoryboard 把
    // **同一张**第 1 步的 DOM 存成 N 份——画面上「有 N 步」，步数对得上、内容一条不少，
    // 只是全都一样。这一族里最难被发现的一种假。
    name: "M21 §6.3 reduced 之后连 render 一起关掉（静态分镜 N 张全一样）",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{
      old: "    if (!stage.isConnected()) return;",
      new: "    if (staticMode) return;\n    if (!stage.isConnected()) return;",
    }],
    expect: ["§6.3 静态分镜铺得开：模板那一侧逐个 render(i) 快照，N 张分镜必须各不相同"],
  },
  {
    // `isConnected` 写成属性而不是调用：函数对象恒为真 ⇒ 那道闸一次都不生效。
    name: "M22 §6.3 容器脱离文档之后还在写（isConnected 漏了括号）",
    file: `${SHARED_ARTIFACT}/round-artifact-render.ts`,
    edits: [{ old: "    if (!stage.isConnected()) return;", new: "    if (!stage.isConnected) return;" }],
    expect: ["静态分镜铺完之后 render 空转"],
  },
];

const LOAD_ERROR_MARKERS = [
  "Cannot find module", "SyntaxError", "Unexpected token", "Unexpected identifier",
  "ERR_MODULE_NOT_FOUND", "does not provide an export", "ERR_AMBIGUOUS_MODULE_SYNTAX",
  "Could not find", "cannot be found", "No test files found",
];

function testFor(file: string): string {
  return TEST_FOR[file] ?? DEFAULT_TEST;
}

function runTests(relativeTest: string): { reds: string[]; loadErrors: string[] } {
  const testPath = join(ROOT, relativeTest);
  if (!existsSync(testPath)) {
    return { reds: [], loadErrors: [`测试文件不存在：${testPath}`] };
  }
  let out = "";
  try {
    out = execFileSync("node", ["--import", "tsx", "--test", testPath], {
      cwd: API, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // node --test 用非零退出码表示"有用例红了"——那正是我们要看的，不是错误。
    const e = err as { stdout?: string; stderr?: string };
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const reds = out.split("\n")
    .filter((line) => line.startsWith("not ok "))
    .map((line) => line.split(" - ", 2)[1]?.trim() ?? line);
  return { reds, loadErrors: LOAD_ERROR_MARKERS.filter((marker) => out.includes(marker)) };
}

function main(): number {
  if (process.argv.includes("--list")) {
    for (const m of MUTATIONS) console.log(`${m.name}\n  文件：${m.file}\n  指名：${m.expect.join(" | ")}`);
    return 0;
  }

  // 基线不绿就不开跑：那时的"变红"说明不了任何问题。
  const baseline = runTests(DEFAULT_TEST);
  if (baseline.reds.length > 0 || baseline.loadErrors.length > 0) {
    console.error("基线就不绿，先修基线：", baseline.reds, baseline.loadErrors);
    return 2;
  }

  const failures: string[] = [];
  const backupDir = mkdtempSync(join(tmpdir(), "artifact-mutation-"));
  const files = [...new Set(MUTATIONS.map((m) => m.file))];
  for (const file of files) copyFileSync(join(ROOT, file), join(backupDir, file.replaceAll("/", "_")));

  try {
    for (const mutation of MUTATIONS) {
      const path = join(ROOT, mutation.file);
      const original = readFileSync(path, "utf8");
      let mutated = original;
      let applied = true;
      for (const edit of mutation.edits) {
        if (!mutated.includes(edit.old)) {
          failures.push(`${mutation.name}: 补丁没匹配上（实现已漂移），这次变异没生效`);
          applied = false;
          break;
        }
        mutated = mutated.replace(edit.old, edit.new);
      }
      if (!applied) continue;

      writeFileSync(path, mutated);
      const result = runTests(testFor(mutation.file));
      writeFileSync(path, original);

      if (result.loadErrors.length > 0) {
        failures.push(`${mutation.name}: 红在模块加载上（${result.loadErrors.join(", ")}）⇒ 这一变异没测到判据`);
        continue;
      }
      if (result.reds.length === 0) {
        failures.push(`${mutation.name}: 没有任何用例变红 ⇒ 判据没在守它声称的东西`);
        continue;
      }
      const hit = mutation.expect.filter((e) => result.reds.some((r) => r.includes(e)));
      if (hit.length === 0) {
        failures.push(`${mutation.name}: 变红了，但红在 ${result.reds.slice(0, 3).join(" / ")}，不包含指名的 ${mutation.expect.join(" | ")}`);
        continue;
      }
      console.log(`  OK  ${mutation.name}`);
      console.log(`      指名用例变红：${hit[0]}`);
    }
  } finally {
    for (const file of files) {
      copyFileSync(join(backupDir, file.replaceAll("/", "_")), join(ROOT, file));
    }
    rmSync(backupDir, { recursive: true, force: true });
  }

  console.log();
  if (failures.length > 0) {
    console.log("变异自证失败：");
    for (const line of failures) console.log(`  - ${line}`);
    return 1;
  }
  console.log(`全部 ${MUTATIONS.length} 项变异自证通过（红在正确断言上，且已还原）`);
  return 0;
}

process.exit(main());
