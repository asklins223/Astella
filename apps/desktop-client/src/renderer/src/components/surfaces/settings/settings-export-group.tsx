/**
 * 设置页「导出与归档」那一组。
 *
 * ## 这里现在有两行导出，各自解决一件事（2026-10 改）
 *
 * - **导出工作区**：一个 JSON，给「留档 / 自己分析」用，要 owner。整库导出的服务端
 *   `requireOwner` 没有旁路，成员在界面上看到的是灰按钮加一句说明。
 * - **导出笔记为 Markdown**：一个装满 `.md` 的目录，给「拿去别的工具里读」用，
 *   **任何成员都能用**——范围是服务端按「这个调用者看得见什么」判的，客户端不判角色。
 *
 * ⚠️ 下面那段注释仍然成立，别删：它记着**整库导出只有导出这一半**（没有任何端点能把
 * 那份 JSON 导回来），所以分组叫「导出与归档」而不是「备份/恢复」，说明里明写「导不回来」。
 * 这是一条**产品事实**，写进代码注释是为了下一个改文案的人不会顺手写回「备份」。
 *
 * ## 为什么这里不再有「导入 Markdown 笔记」
 *
 * 批量丢 .md 原来有第二扇门（这一行），它直接建笔记、不产生来源，于是同一个动作有两条
 * 形态不同的来路，界面上还长得像一对「备份/恢复」。现在只留**来源库那一条**：丢文件 →
 * 走正常的收录流程（建来源、排队解析）→ 要写笔记的人自己在来源页选「开始写笔记」。
 * 那条路对来源、解析、复习排程都是同一套，成员与 owner 看到的行为也一致。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import type { ReactElement } from "react";
import { FileDown } from "lucide-react";
import { SettingRow } from "./settings-primitives.tsx";

export function SettingsExportGroup(props: {
  readonly currentRole: "owner" | "member" | undefined;
  readonly exporting: boolean;
  /** Markdown 目录导出有它自己的忙碌位：两行导出的耗时差一个量级，共用一个会让界面说错话。 */
  readonly markdownExporting: boolean;
  readonly onExport: () => Promise<void>;
  readonly onExportMarkdown: () => Promise<void>;
  /** 导入完成之后关掉设置页并回到首页——那是页面级动作。 */
  /** 导入完成后请书房走一步（页面知道该回哪一屏）。 */
  readonly onImported: (intent: "open-notes") => void;
  /** 关掉设置页。页面持有它（它要知道该回到哪一屏）。 */
  readonly onCloseSurface: () => void;
}): ReactElement {
  const { currentRole, exporting, markdownExporting, onExport, onExportMarkdown, onImported, onCloseSurface } = props;
  const exportWorkspace = onExport;
  const exportMarkdownDirectory = onExportMarkdown;
  const closeSurface = onCloseSurface;
  const invoke = onImported;
  return (
<section className="settings-group">
  {/* 审计 F41：导出与导入并排放在「生命周期」里，读起来像"备份/恢复"一对，
      而**服务端只有导出这一半**（没有任何端点能把这份 JSON 导回来）。
      所以①分组改成"导出与归档"，把导入 Markdown 留在"这页还能做什么"那一组；
      ②导出的说明里明写"导不回来"，不再让"备份"这个词暗示可以恢复。
      （③ 那行 Markdown 导入后来整个搬去了来源库，见本文件头。） */}
  <h3 className="settings-group__title">导出与归档</h3>
  <div className="settings-rows">
    <SettingRow
      title="导出笔记为 Markdown"
      detail={currentRole
        ? "把这个空间里你能看到的笔记写成一个文件夹，一篇一个 .md 文件；保存时选择位置，可以直接拿去别的编辑器里读和搜。"
        : "先连上一个空间再导出。"}
    >
      <button
        type="button"
        className="button"
        disabled={markdownExporting}
        onClick={() => void exportMarkdownDirectory()}
      >
        <FileDown size={13} aria-hidden="true" />
        {markdownExporting ? "正在导出 Markdown…" : "导出为 Markdown…"}
      </button>
    </SettingRow>
    <SettingRow
      title="导出工作区（只读存档）"
      detail={currentRole === "owner"
        ? "把当前空间的来源、笔记、学习卡与版本写成一个 JSON 文件，用来留档或自己分析；保存时选择位置。当前不支持将这份 JSON 存档导回书房。"
        : "整库导出只对空间所有者开放，你在这个空间是成员。"}
    >
      <button
        type="button"
        className="button"
        disabled={exporting || currentRole !== "owner"}
        onClick={() => void exportWorkspace()}
      >
        {exporting ? "正在导出工作区…" : "导出为 JSON…"}
      </button>
    </SettingRow>
    <SettingRow title="删除来源与笔记" detail="删除是逐条的危险操作，入口在各自的库里，这一页只统计数量。">
      <button
        type="button"
        className="button"
        onClick={() => { closeSurface(); invoke("open-notes"); }}
      >
        去笔记库
      </button>
    </SettingRow>
  </div>
</section>
  );
}