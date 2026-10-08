/** 要点／脑图是同一枚两挡开关：纸面与画布各放一处，位置、样式与弹簧只此一份。
 *
 * 它挂在纸面框上（`NotebookDesk` 的叶子里、滚动页之外），**不能**放进页内容：
 * 页内容的入场动画带 `transform`，会把绝对定位的包含块从纸面框换成那一页——
 * 开关就先落在页上、动画一停再跳回纸面左上（2026-10-08 真窗口逐帧量到 62×127px 的跳）。 */
export function NotebookOverviewSwitch(props: {
  readonly active: "points" | "mindMap";
  readonly onSelect: (tab: "points" | "mindMap") => void;
}) {
  return <nav className="notebook-overview-tabs" data-tab={props.active} aria-label="速看内容">
    <button type="button" aria-pressed={props.active === "points"} onClick={() => props.onSelect("points")}>要点</button>
    <button type="button" aria-pressed={props.active === "mindMap"} onClick={() => props.onSelect("mindMap")}>脑图</button>
  </nav>;
}
