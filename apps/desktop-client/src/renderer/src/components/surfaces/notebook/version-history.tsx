/**
 * 「版本历史」那一格：列出每一版，并把某一版换回当前。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 45 行、6 个外部符号。四档（在途 / 读失败 / 空 / 有版本）是**互斥**的，
 * 摆在一格里才不会让「读失败」与「还没有版本」在屏上长得一样。
 *
 * ## 四条不许动
 *
 *  1. **那颗「恢复」有三个禁用理由，而且 `title` 要逐条说清**——只读身份 / 有没提交的改动 /
 *     正在恢复。用户被禁用时必须知道**为什么被禁用**以及**怎么解开**。
 *  2. **「恢复」不删任何版本**。这句在说明里也写着——恢复与「撤销到某一版」不是一回事。
 *  3. **当前版本那颗只画标记，不画按钮**。当前版没有「恢复到当前版」这个动作。
 *  4. **列表**不含正文**：要看某一版正文只能把它换回当前（见
 *     `use-notebook-versions.ts` 的文件头）。所以这里不能加一个「查看」按钮——
 *     那是不存在的操作。
 */
import { useLayoutEffect, useRef, type ReactElement } from "react";
import type { DesktopNoteVersionItem } from "@astella/shared/desktop-surface-contracts";

export function VersionHistory(props: {
  readonly versions: readonly DesktopNoteVersionItem[] | null;
  readonly loading: boolean;
  readonly failure: string | null;
  readonly restoringVersionId: string | null;
  /** 只读身份：这一篇不可改写，于是那一列没有「恢复」。 */
  readonly editable: boolean;
  /** 有没提交的改动。 */
  readonly dirty: boolean;
  readonly formatRelative: (value: string) => string;
  readonly onReload: () => void;
  readonly onRestore: (version: DesktopNoteVersionItem) => void;
}): ReactElement {
  const {
    versions, loading, failure, restoringVersionId,
    editable, dirty, formatRelative, onReload, onRestore,
  } = props;
  const rootRef = useRef<HTMLElement>(null);
  const pendingFocusRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    const root = rootRef.current;
    if (!pending || !root || loading || restoringVersionId) return;
    pendingFocusRef.current = null;
    if (failure) return;
    const current = [...root.querySelectorAll<HTMLElement>("[data-version-id]")]
      .find((row) => row.dataset.versionId === pending && row.dataset.currentVersion === "true");
    const active = document.activeElement;
    if (current && (root.contains(active) || active === document.body || active === document.documentElement)) {
      // The restore button disappears on success. Keep the keyboard at its receipt,
      // unless the user has already moved to another part of the notebook.
      current.focus({ preventScroll: true });
    }
  }, [failure, loading, restoringVersionId, versions]);
  return (
    <section ref={rootRef} className="version-history" aria-label="笔记版本历史">
      <p className="small">
        点击「保存版本」留下这次内容。平时的改动会自动同步到当前草稿；恢复会切回选中的版本，不会删除其他版本。
      </p>
      {loading ? <p className="small" role="status">正在读取版本历史…</p> : null}
      {!loading && failure ? (
        <p className="small notebook-note" role="alert">
          {failure}
          <button type="button" className="text-action text-action--strong" onClick={onReload}>
            重新读取
          </button>
        </p>
      ) : null}
      {!loading && !failure && versions?.length === 0 ? (
        <p className="small">这篇笔记还没有可列出的版本。</p>
      ) : null}
      {!loading && !failure && versions?.length ? (
        <ul className="version-list">
          {versions.map((version) => (
            <li
              key={version.versionId}
              className={version.current ? "current" : undefined}
              data-version-id={version.versionId}
              data-current-version={version.current ? "true" : undefined}
              tabIndex={version.current ? -1 : undefined}
              aria-label={version.current ? `v${version.versionNo}，当前版本` : undefined}
            >
              <span className="version-no">v{version.versionNo}</span>
              <span className="version-time">{formatRelative(version.createdAt)}</span>
              {version.current ? (
                <span className="version-tag">当前版本</span>
              ) : (
                <button
                  type="button"
                  className="text-action text-action--strong"
                  disabled={!editable || dirty || restoringVersionId !== null}
                  title={!editable
                    ? "你在这个空间是只读身份，不能改写这篇笔记的版本"
                    : dirty
                      ? "先提交或撤销当前编辑，再恢复历史版本"
                      : "把这篇笔记切回这一版，不删除任何版本"}
                  onClick={() => {
                    pendingFocusRef.current = version.versionId;
                    onRestore(version);
                  }}
                >
                  {restoringVersionId === version.versionId ? "正在恢复…" : "恢复这一版"}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
