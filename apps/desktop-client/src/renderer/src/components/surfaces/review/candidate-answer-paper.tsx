import type { DesktopCandidateRevealV2 } from "@ailearn/shared/card-generation-desktop-contracts";
import { revealCooldownHours } from "./candidate-review-model";

export function AnswerBlock({ answer }: { readonly answer: DesktopCandidateRevealV2["canonicalAnswer"] }) {
  switch (answer.kind) {
    case "text":
      return <p className="reveal-answer__text">{answer.unit.text}</p>;
    case "bullets":
      return <ul className="reveal-answer__list">{answer.items.map((item) => <li key={item.unitId}>{item.text}</li>)}</ul>;
    case "ordered_steps":
      return <ol className="reveal-answer__list">{answer.steps.map((step) => <li key={step.unitId}>{step.text}</li>)}</ol>;
    case "mapping":
      return (
        <dl className="reveal-answer__pairs">
          {answer.pairs.map((pair) => (
            <div key={pair.unitId}>
              <dt>{pair.left}</dt>
              <dd>{pair.right}</dd>
            </div>
          ))}
        </dl>
      );
    case "comparison":
      return (
        <table className="md-table reveal-answer__table">
          <thead>
            <tr>{answer.columns.map((column, index) => <th key={index}>{column}</th>)}</tr>
          </thead>
          <tbody>
            {answer.rows.map((row) => (
              <tr key={row.unitId}>
                <th scope="row">{row.dimension}</th>
                {row.values.map((value, index) => <td key={index}>{value}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "formula":
      return (
        <>
          <p className="reveal-answer__formula">{answer.latex}</p>
          <ul className="reveal-answer__list">
            {answer.variableMeanings.map((item) => (
              <li key={item.symbol}><b>{item.symbol}</b> {item.meaning}</li>
            ))}
          </ul>
        </>
      );
    case "code":
      return (
        <>
          <pre className="code-block"><code>{answer.code}</code></pre>
          {answer.explanation ? <p className="small">{answer.explanation}</p> : null}
        </>
      );
  }
}

export function CandidateAnswerPaper({ reveal }: { readonly reveal: DesktopCandidateRevealV2 }) {
  return <section className="reveal-slip" aria-label="答案与来源证据">
    <h3>答案</h3>
    <AnswerBlock answer={reveal.canonicalAnswer} />
    <p>{reveal.explanation}</p>
    {reveal.boundary ? <p><b>边界</b>　{reveal.boundary}</p> : null}
    {reveal.misconception ? <p><b>常见误解</b>　{reveal.misconception}</p> : null}
    {reveal.workedExample ? <p><b>示例</b>　{reveal.workedExample}</p> : null}
    <h3>来源证据</h3>
    {reveal.evidencePreviews.length ? <ul className="reveal-evidence">
      {reveal.evidencePreviews.map((item) => <li key={item.evidenceSnapshotId} data-source-state={item.sourceState}>
        {item.sourceLabel ? <b>{item.sourceLabel}</b> : null}
        {item.sourceState === "drifted" ? <b>原文已改动</b> : null}
        {item.sourceState === "missing" ? <b>原文已不在笔记里</b> : null}
        <span>{item.preview || "这段依据现在指不到笔记里的文字了。"}</span>
        {item.originalPreview ? <span className="reveal-evidence__original">当初那段：{item.originalPreview}</span> : null}
      </li>)}
    </ul> : <p>这次候选没有附带可展示的来源片段。</p>}
    <p className="candidate-answer-paper__notice">{`答案已经看过。这张卡保存进卡组之后要等 ${revealCooldownHours} 小时才能开始正式首次验证；这段时间随时可以练习，不计入正式状态。`}</p>
  </section>;
}
