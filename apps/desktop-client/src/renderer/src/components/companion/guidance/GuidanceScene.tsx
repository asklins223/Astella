import { BookOpen, Check, Compass, FileText, Gauge, MessageCircle, Moon, Sparkles, UserRound, Volume2 } from "lucide-react";
import { spaceRoleLabel } from "../../../app/space-identity";
import type { CompanionGuideController } from "./use-companion-guide";
import type { GuideStep } from "./guide-definitions";

export const SCENE_BEATS = {
  room: ["认一认门牌", "知道自己在哪", "带着问题出发"],
  note: ["收好一份资料", "展开成自己的笔记", "留下一个问题"],
  reading: ["继续读这篇笔记", "选中这一句，叫我解释", "理解留在原句旁"],
  agent: ["把同一个问题交给我", "进展看得到，随时补充", "先看提纲，再确认保存"],
  review: ["给自己一个线索", "回到原文核对", "需要时，再复习"],
  return: ["从一个问题开始", "走过一篇笔记", "现在，换成你的内容"],
} as const;

/** One sheet stays on stage for the entire story; CSS carries it between chapters. */
export function GuidanceScene({ step, guide, phase, onPhase }: { step: GuideStep; guide: CompanionGuideController; phase: number; onPhase: (phase: number) => void }) {
  const kind = step.demo;
  const identity = guide.identity;
  const room = kind === "room" && step.id !== "settings";
  return <div className="guidance-scene" data-kind={kind} data-phase={phase} data-settings={step.id === "settings" || undefined} aria-label={`演示：${SCENE_BEATS[kind][phase]}`}>
    <svg className="guidance-scene__drawing" viewBox="0 0 1000 660" aria-hidden="true" fill="none">
      <ellipse cx="510" cy="576" rx="350" ry="25" fill="#6a815415" />
      <path data-guide-draw="true" d="M100 478 C48 168 370 52 700 150 S986 460 790 568" stroke="#a8ba8b" strokeWidth="2" strokeLinecap="round" />
      <path data-guide-draw="true" d="M151 391 C275 515 357 166 515 276 S715 435 875 275" stroke="#bea16a" strokeWidth="3" strokeLinecap="round" />
      <path d="m875 275 -17 1 8 15" stroke="#bea16a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {[[127,180], [766,151], [918,428], [277,565], [703,598]].map(([x,y], index) => <g key={x} data-guide-spark="true" transform={`translate(${x},${y})`}><path d="M0 -9 Q1 -1 9 0 Q1 1 0 9 Q-1 1 -9 0 Q-1 -1 0 -9Z" fill={index % 2 ? "#91b47e" : "#d5ab70"} /></g>)}
    </svg>
    <div className="guidance-scene__door" data-guide-object="true" aria-hidden={!room}><svg viewBox="0 0 210 300" fill="none" aria-hidden="true"><path data-guide-draw="true" d="M30 283V33Q30 12 51 12H161Q182 12 182 33V283M15 284H197" stroke="#819b6c" strokeWidth="5" strokeLinecap="round" /><path d="M51 38 155 57V265L51 279Z" fill="#d9e7c2" stroke="#9bb385" strokeWidth="2" /><rect x="68" y="69" width="67" height="73" rx="33" fill="#fff7dd" /><path d="M101 70v69M69 105h65" stroke="#adbc8e" strokeWidth="3" /><circle cx="137" cy="178" r="6" fill="#b5996e" /><path d="M68 209h55v36H68Z" stroke="#b6c5a1" strokeWidth="2" /></svg><span>我们从这里出发</span></div>
    <div className="guidance-scene__source" data-guide-object="true" aria-hidden={kind !== "note"}><FileText size={40} /><small>资料 · 示例</small><h3>学习的方法</h3><i /><i /><i /><span>出处和原文，一起留下</span></div>
    <div className="guidance-scene__request" data-guide-object="true" aria-hidden={kind !== "agent"}>“为什么回想比重读更有帮助？”<br /><b>帮我把这个问题，整理成提纲。</b></div>
    <div className="guidance-scene__review-box" data-guide-object="true" aria-hidden={kind !== "review"}><i /><i /><i /><span>留下的理解</span></div>
    <article className="guidance-scene__folio" data-guide-object="true" aria-hidden={step.id === "settings"}>
      <span className="guidance-scene__folio-tab"><BookOpen size={15} />{room ? "这间书房" : "学习的方法"}</span>
      <div data-guide-content="true">
        {room ? <><small>当前学习空间</small><h3>{identity?.name ?? "你的书房"}</h3><span className="guidance-scene__role">{identity ? spaceRoleLabel(identity) : "正在核对身份"}</span><div className="guidance-scene__shelf"><BookOpen size={27} /><div>{guide.contents.status === "ready" ? <><b>{guide.contents.total === 0 ? "从第一个想法开始" : `这里有 ${guide.contents.total} 篇笔记`}</b>{guide.contents.notes.slice(0, 2).map(note => <span key={note.id}>{note.title}</span>)}</> : <b>{guide.contents.status === "loading" ? "正在看看这里的笔记…" : "笔记暂时没有读到"}</b>}</div></div></>
          : kind === "note" ? <><small>我的笔记 · 教学示例</small><h3>用自己的话，<br />记下来。</h3><p>读完一段，试着合上书。<br />回想让我们发现理解的空隙。<br />带着问题，再回到原文。</p><span className="guidance-scene__thought">为什么回想比重读更有帮助？</span><em>资料出处 ↗</em></>
          : kind === "reading" ? <><small>还是这篇笔记 · 教学示例</small><h3>给理解一个着落</h3><p>读完一段，试着合上书。<br /><button type="button" className="guidance-scene__sentence" onClick={() => onPhase(1)} aria-label="演示：选中这句请伴星解释">回想让我们发现理解的空隙。</button><br />带着问题，再回到原文。</p><span className="guidance-scene__saved"><MessageCircle size={15} /> 理解留在原句旁 · 示例</span></>
          : kind === "agent" ? <><small><Sparkles size={16} /> 任务 · 教学示例</small><h3>{phase === 0 ? "收到，交给我。" : phase === 1 ? "正在整理这个问题…" : "提纲候选准备好了。"}</h3><ol><li>厘清刚才的问题<Check size={14} /></li><li>整理这篇笔记的内容<Check size={14} /></li><li>准备一份提纲<Check size={14} /></li></ol><span className="guidance-scene__task-foot">可以补充、停止；确认后才保存</span></>
          : kind === "review" ? <><small>自己的回想 · 教学示例</small><h3>为什么回想比重读<br />更有帮助？</h3><p>{phase === 0 ? "先停一停，自己想想。" : phase === 1 ? "回到笔记，核对刚才的理解。" : "需要巩固时，再安排一次复习。"}</p><span className="guidance-scene__task-foot">线索 → 回想 → 核对</span></>
          : <><small>问题 → 笔记 → 理解 → 伴星帮忙</small><h3>从这里，开始你的学习。</h3><p>挑一篇想读的笔记，<br />或者写下你自己的问题。</p><div className="guidance-scene__finish"><Check size={20} />这条路，你已经认识了</div></>}
      </div>
    </article>
    <aside className="guidance-scene__explanation" data-guide-object="true" aria-hidden={kind !== "reading" || phase === 0}><small><Sparkles size={16} /> 伴星解释 · 示例</small><p>不看原文时，<br />哪里想不起来，<br />就知道下一步读哪里。</p><span className="guidance-scene__saved"><Check size={15} /> 解释就在原句旁</span></aside>
    <div className="guidance-scene__learning" aria-hidden={kind !== "reading"}><span>速看</span><span>回想</span><span>解释</span><span>往外学</span></div>
    <div className="guidance-scene__artifact" data-guide-object="true" aria-hidden={kind !== "agent" || phase !== 2}><FileText size={34} /><b>提纲候选</b><small>查看 → 确认 → 保存</small><i>尚未保存 · 示例</i></div>
    <span className="guidance-scene__pencil" aria-hidden={kind !== "note" || phase !== 2}><i />同一个问题，接着往下读</span>
    <div className="guidance-scene__bookmark" data-guide-object="true" aria-hidden={kind !== "return"}><Compass size={28} /><b>随时回来找我</b></div>
    <div className="guidance-scene__settings" data-guide-object="true" aria-hidden={step.id !== "settings"}><span><Moon size={36} /><b>日与夜</b></span><span><Volume2 size={36} /><b>声音</b></span><span><Gauge size={36} /><b>动效</b></span><span><UserRound size={36} /><b>个人偏好</b></span></div>
    <div className="guidance-scene__beats" role="group" aria-label="本段演示">{SCENE_BEATS[kind].map((caption, beat) => <button key={caption} type="button" aria-label={`演示画面 ${beat + 1}：${caption}`} aria-pressed={phase === beat} onClick={() => onPhase(beat)}><span>{String(beat + 1).padStart(2, "0")}</span>{caption}</button>)}</div>
  </div>;
}
