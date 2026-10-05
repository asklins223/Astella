import { useLayoutEffect, useRef } from "react";
import { ArrowRight, Compass, Pause, X } from "lucide-react";
import { spaceRoleLabel } from "../../../app/space-identity";
import { GUIDE_TOPICS, type GuideTopicId } from "./guide-definitions";
import type { CompanionGuideController } from "./use-companion-guide";

/** The island holds the directory. A selected topic unfolds into the whole room. */
export function CompanionGuideBook({ guide, onClose }: { guide: CompanionGuideController; onClose: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const start = (topic: GuideTopicId, resume = false) => { guide.start(topic, resume); onClose(); };
  return <section className="companion-guide-book" role="dialog" aria-modal="false" aria-labelledby="companion-guide-title">
    <header className="companion-guide-book__header"><span className="companion-guide-book__seal"><Compass size={20} /></span><div><small>跟着伴星，看看书房</small><h2 ref={heading} tabIndex={-1} id="companion-guide-title">伴星带路</h2></div><button type="button" className="companion-guide-book__close" aria-label="合上带路目录" onClick={onClose}><X size={17} /></button></header>
    <div className="companion-guide-book__identity"><span>{guide.identity?.name ?? "当前空间"}</span><small>{guide.identity ? spaceRoleLabel(guide.identity) : "身份读取中"}</small></div>
    <div className="companion-guide-book__body">
      {guide.invitation ? <div className="companion-guide-book__invitation"><strong>{guide.invitation === "account" ? "欢迎来到书房" : "一起认识这里"}</strong><p>我来带路，你随时可以停下来。</p><div><button type="button" onClick={() => start(guide.invitation === "account" ? "welcome" : "space")}>带我看看<ArrowRight size={13} /></button><button type="button" onClick={guide.skip}>我先自己探索</button></div></div> : null}
      {guide.resume ? <button type="button" className="companion-guide-book__resume" onClick={() => start(guide.resume!.topic, true)}><Pause size={15} /><span>继续刚才的带看<small>{guide.resume.step}</small></span><ArrowRight size={15} /></button> : null}
      <button type="button" className="companion-guide-book__first-walk" onClick={() => start("welcome")}><Compass size={25} /><span><small>第一次来，从这里开始</small><b>跟我完整走一遍</b><em>书房 → 笔记 → 读懂 → 伴星帮忙</em></span><ArrowRight size={17} /></button>
      <p className="companion-guide-book__topics-label">也可以只重看其中一段</p>
      <nav className="companion-guide-book__topics" aria-label="带路主题">{GUIDE_TOPICS.filter(item => item.id !== "welcome").map((item, index) => <button type="button" key={item.id} onClick={() => start(item.id)}><span className="companion-guide-book__topic-icon"><item.icon size={18} /></span><span><b>{item.title}</b><small>{item.description}</small></span><em>{String(index + 1).padStart(2, "0")}</em><ArrowRight size={14} /></button>)}</nav>
    </div>
    <footer className="companion-guide-book__directory-footer">选一段，在书房里边看边听。</footer>
  </section>;
}
