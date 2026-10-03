import { Leaf, Sparkles } from "lucide-react";
import { useRef, type CSSProperties, type ReactNode } from "react";
import { useCardPackMotion } from "./use-card-pack-motion";
import { useCardPaperArrival } from "../../motion/card-object-spring";

export function cardPackTint(identity: string): number {
  let hash = 0;
  for (const character of identity) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return hash % 5;
}

/** CSS geometry, rather than a bitmap: actual faces, folded seal and layered cards. */
export function CardPackArt({ count, opened = false }: { count: number; opened?: boolean }) {
  return <span className="card-pack-art" aria-hidden="true">
    <span className="card-pack-art__shadow" />
    <span className="card-pack-art__body">
      <span className="card-pack-art__back" />
      <span className="card-pack-art__cards"><i /><i /><i><Leaf size={29} strokeWidth={1.8} /></i></span>
      <span className="card-pack-art__side" /><span className="card-pack-art__bottom" />
      <span className="card-pack-art__front"><span className="card-pack-art__caption">STUDY CARDS</span><span className="card-pack-art__illustration"><i /><i /><span><Leaf size={52} strokeWidth={1.5} /></span></span><span className="card-pack-art__seal"><Sparkles size={13} />{opened ? "已打开" : `${count} 张`}</span></span>
      <span className="card-pack-art__flap"><i /></span>
    </span>
  </span>;
}

export function CardPackObject({ identity, title, count, opened, onToggle, children }: { identity: string; title: string; count: number; opened: boolean; onToggle(): void; children: ReactNode }) {
  const poseRef = useRef<HTMLSpanElement>(null);
  const motion = useCardPackMotion(poseRef, opened);
  return <button type="button" className="card-pack-object" data-tint={cardPackTint(identity)} aria-label={`${opened ? "合上" : "打开"}卡包：${title}`} aria-expanded={opened} onClick={onToggle} {...motion}>
    <span className="card-pack-object__scene" ref={poseRef}><CardPackArt count={count} opened={opened} /></span>
    <span className="card-pack-object__caption">{children}</span>
  </button>;
}

export function CardPackCardSpot({ children }: { children: ReactNode }) {
  const spotRef = useRef<HTMLLIElement>(null);
  useCardPaperArrival(spotRef, "card");
  return <li ref={spotRef}>{children}</li>;
}

export function CardPackLearningCard({ id, index, title, strategy, strategyLabel, symbol, state, progress, summary, onOpen }: { id: string; index: number; title: string; strategy: string | null; strategyLabel?: string; symbol?: string; state: string; progress: string; summary: string | null; onOpen(): void }) {
  const faceRef = useRef<HTMLSpanElement>(null);
  const motion = useCardPackMotion(faceRef, false, true);
  return <button type="button" className="card-collection__card" data-objective-id={id} data-strategy={strategy} aria-label={`翻开学习卡：${title}`} onClick={onOpen} {...motion}>
    <span ref={faceRef} className="card-collection__card-face" style={{ "--card-order": index } as CSSProperties}>
      <span className="card-collection__card-top"><span className="card-collection__card-mark" aria-hidden="true">{symbol}</span><span className="card-collection__card-type">{strategyLabel}</span><span className="card-collection__card-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span></span>
      <span className="card-collection__card-body"><strong>{title}</strong>{summary && summary !== title ? <span className="card-collection__card-summary">{summary}</span> : null}<span className="card-collection__card-state">{state}<small>{progress}</small></span></span>
    </span>
  </button>;
}
