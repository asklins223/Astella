/**
 * 设置页「导出与归档」那一组。
 *
 * ## 为什么从 `settings-surface.tsx` 拆出来（2026-09-29）
 *
 * 60 行、3 个外部符号（`currentRole` / `exporting` / `importBusy`）——那份文件里
 * 依赖最少的一块。
 *
 * ⚠️ 那段注释是这一块的一部分，别删：它记着**服务端只有导出这一半**（没有任何端点能把
 * 这份 JSON 导回来），所以分组叫「导出与归档」而不是「备份/恢复」，说明里明写「导不回来」。
 * 这是一条**产品事实**，写进代码注释是为了下一个改文案的人不会顺手写回「备份」。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import type { ReactElement } from "react";
import { FileUp } from "lucide-react";
import { SettingRow } from "./settings-primitives.tsx";

export function SettingsExportGroup(props: {
  readonly currentRole: "owner" | "member" | undefined;
  readonly exporting: boolean;
  readonly importBusy: boolean;
  readonly onExport: () => Promise<void>;
  /** 导入那一发收的是**文件列表**（用户一次可能拖好几篇进来）。 */
  readonly onImport: (files: FileList | null) => Promise<void>;
  /** 导入完成之后关掉设置页并回到首页——那是页面级动作。 */
  /** 导入完成后请书房走一步（页面知道该回哪一屏）。 */
  readonly onImported: (intent: "open-notes") => void;
  /** 关掉设置页。页面持有它（它要知道该回到哪一屏）。 */
  readonly onCloseSurface: () => void;
}): ReactElement {
  const { currentRole, exporting, importBusy, onExport, onImport, onImported, onCloseSurface } = props;
  const exportWorkspace = onExport;
  const importMarkdownFiles = onImport;
  const closeSurface = onCloseSurface;
  const invoke = onImported;
  return (
<section className="settings-group">
  {/* 审计 F41：导出与导入并排放在「生命周期」里，读起来像"备份/恢复"一对，
      而**服务端只有导出这一半**（没有任何端点能把这份 JSON 导回来）。
      所以①分组改成"导出与归档"，把导入 Markdown 留在"这页还能做什么"那一组；
      ②导出的说明里明写"导不回来"，不再让"备份"这个词暗示可以恢复。 */}
  <h3 className="settings-group__title">导出与归档</h3>
  <div className="settings-rows">
    <SettingRow
      title="导出工作区（只读存档）"
      detail={currentRole === "owner"
        ? "把当前空间的来源、笔记、学习卡与版本写成一个 JSON 文件，用来留档或自己分析；保存位置由你在系统对话框里选择。**这份文件目前导不回来**——要恢复内容，请在原空间里操作。"
        : "整库导出只对空间所有者开放，你在这个空间是成员。"}
    >
      <button
        type="button"
        className="button"
        disabled={exporting || currentRole !== "owner"}
        onClick={() => void exportWorkspace()}
      >
        {exporting ? "导出中…" : "导出…"}
      </button>
    </SettingRow>
    <SettingRow
      title="导入 Markdown 笔记"
      detail={currentRole === "owner"
        ? "从本机的 .md 文件建笔记（**不是**上面那份 JSON 存档的导入口）：一次最多 100 个文件，文件名作标题；相同批次重试不会产生重复笔记。导进来的文件属于这个空间——协作空间里所有成员和他们的伴星都会读到。"
        : "批量导入只对空间所有者开放，你在这个空间是成员。"}
    >
      <label
        className="button"
        data-disabled={importBusy || currentRole !== "owner" ? "true" : undefined}
        aria-disabled={importBusy || currentRole !== "owner"}
      >
        <FileUp size={13} aria-hidden="true" />
        {importBusy ? "导入中…" : "选择文件…"}
        <input
          className="settings-file-input"
          type="file"
          accept=".md,.markdown,text/markdown"
          multiple
          disabled={importBusy || currentRole !== "owner"}
          onChange={(event) => {
            const files = event.currentTarget.files;
            void importMarkdownFiles(files);
            event.currentTarget.value = "";
          }}
        />
      </label>
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
