import { ArrowLeft, ArrowRight, Award, RotateCcw, Star } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { NoteLearningCardAttemptV1, NoteLearningCardV1 } from "@astella/shared/note-learning-card-contracts";
import { useRoomStore } from "../../../../../app/home/room-store";
import { playLearningCardReward } from "./learning-card-motion";
import { resultCounts } from "./card-model";
import { useLearningCardPresentation } from "./learning-card-presentation";

function RewardLaurel() {
  const leaves = [[91,186,-35],[72,169,-58],[60,148,-75],[56,123,-90],[59,98,-107],[67,75,-125],[80,54,-145]];
  const branch = <><path d="M115 200C53 191 31 111 81 49" fill="none" stroke="currentColor" strokeWidth="2" />{leaves.map(([x,y,rotation], index) => <g key={index}><ellipse cx={x} cy={y} rx="14" ry="5" transform={`rotate(${rotation} ${x} ${y})`} /><ellipse cx={x! - 11} cy={y! - 7} rx="12" ry="4.5" transform={`rotate(${rotation! + 60} ${x! - 11} ${y! - 7})`} /></g>)}</>;
  return <svg className="lc-reward-laurel" viewBox="0 0 260 220" aria-hidden="true"><g>{branch}</g><g transform="translate(260 0) scale(-1 1)">{branch}</g></svg>;
}

export function LearningCardCelebration({ card, result, onDetails, onCard }: { card: NoteLearningCardV1; result: NoteLearningCardAttemptV1; onDetails: () => void; onCard: () => void }) {
  const root = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const [replay, setReplay] = useState(0), [litStars, setLitStars] = useState(0);
  const [systemReduced, setSystemReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const motionMode = useRoomStore((state) => state.motionMode), reduced = useRoomStore((state) => state.reducedMotion);
  const noMotion = reduced || motionMode !== "full" || systemReduced;
  const totals = resultCounts(result, card.questions), score = result.score ?? 0, earnedStars = result.stars ?? 0;
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const stop = root.current ? playLearningCardReward(root.current, score, noMotion) : () => {};
    const timers: ReturnType<typeof setTimeout>[] = [];
    setLitStars(noMotion ? earnedStars : 0);
    useLearningCardPresentation.setState({ reward: { active: !noMotion, at: performance.now() } });
    if (!noMotion) {
      for (let index = 0; index < earnedStars; index++) timers.push(setTimeout(() => setLitStars(index + 1), 650 + index * 280));
      timers.push(setTimeout(() => useLearningCardPresentation.setState({ reward: { active: false, at: 0 } }), 5800));
    }
    return () => { timers.forEach(clearTimeout); stop(); useLearningCardPresentation.setState({ reward: { active: false, at: 0 } }); };
  }, [score, earnedStars, replay, noMotion]);
  return <section ref={root} className="lc-celebration" data-motion={noMotion ? "off" : "full"} aria-label="本次练习结算"><div className="lc-celebration-effects" aria-hidden="true" /><div className="lc-celebration-layout"><div className="lc-award-paper" data-directory-content><button type="button" className="lc-text-btn lc-award-back" onClick={onCard}><ArrowLeft size={15} />回到学习卡</button><span className="lc-award-badge"><Award size={15} />本次练习已完成</span><h1 ref={heading} tabIndex={-1}>{score >= 90 ? "闪闪发亮的一次练习！" : score >= 60 ? "又把知识，往心里放近了一点。" : "完成了，这一步也很珍贵。"}</h1><p className="lc-award-subtitle">本次共 {card.questions.length} 道题，答案和原文已整理好。</p><div className="lc-award-object" aria-hidden="true"><div className="lc-award-rays" /><div className="lc-award-halo" key={`halo-${replay}`} /><RewardLaurel /><div className="lc-score-medal"><strong data-award-score>{score}</strong><span>本次练习 / 100</span></div></div><p className="lc-sr-only">本次得分 {score}，{result.stars ?? 0} 星。</p><div className="lc-award-stars" aria-hidden="true">{[0, 1, 2, 3, 4].map((index) => <span className="lc-award-star" data-lit={index < litStars || undefined} key={`${replay}-${index}`} style={{ "--star-index": index } as CSSProperties}><Star className="lc-star-base" />{index < (result.stars ?? 0) && <><Star className="lc-star-light" /><i /></>}</span>)}</div><p className="lc-best-preserved">{(card.bestScore ?? 0) > score ? `最佳 ${card.bestStars ?? 0} 星 · ${card.bestScore} 分，依然为你保留。` : `这张卡的最佳成绩：${card.bestScore ?? score} 分 · ${card.bestStars ?? result.stars ?? 0} 星`}</p><div className="lc-award-counts"><span><b>{totals.correct}</b>答对</span><span><b>{totals.partial + totals.wrong}</b>值得回看</span><span><b>{totals.skipped}</b>跳过</span></div><div className="lc-award-actions"><button type="button" className="lc-btn lc-btn--green" onClick={onDetails}>查看答题详情<ArrowRight size={16} /></button></div><button type="button" className="lc-text-btn lc-replay" onClick={() => setReplay((current) => current + 1)}><RotateCcw size={13} />再庆祝一次</button></div></div><p className="lc-celebration-footnote">所有题目等权计分，跳过的题目按 0 分计算。每一次练习都会留下记录。</p></section>;
}
