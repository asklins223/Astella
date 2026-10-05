import { useEffect, useLayoutEffect, useRef } from "react";
import { DoorOpen, X } from "lucide-react";
import gsap from "gsap";
import { useRoomStore } from "../../app/room-store";
import { spaceRoleLabel } from "../../app/space-identity";
import { clearSpaceArrival, useSpaceArrival } from "./space-arrival";

/** A nameplate and a local page edge share one cancelable arrival beat. Input never waits. */
export function SpaceArrival() {
  const arrival = useSpaceArrival(state => state.current);
  const root = useRef<HTMLDivElement>(null);
  const mode = useRoomStore(state => state.reducedMotion ? "off" : state.motionMode);
  useLayoutEffect(() => {
    if (!arrival || !root.current) return;
    if (mode === "off") return;
    const context = gsap.context(() => {
      const timeline = gsap.timeline();
      timeline.fromTo(".space-arrival__sign", { opacity: 0, y: mode === "full" ? -24 : 0, rotateX: mode === "full" ? -28 : 0, scale: .96 },
        { opacity: 1, y: 0, rotateX: 0, scale: 1, duration: mode === "full" ? .64 : .18, ease: "back.out(1.2)" })
        .fromTo(".space-arrival__seal", { scale: 1.5, opacity: 0, rotation: -18 }, { scale: 1, opacity: 1, rotation: -7, duration: .3, ease: "power3.out" }, .22);
      if (mode === "full") timeline.fromTo(".space-arrival__edge", { rotateY: -72, opacity: 0 }, { rotateY: 0, opacity: 1, duration: .68, ease: "power2.out" }, 0)
        .to(".space-arrival__edge", { opacity: 0, duration: .22 }, .7);
    }, root);
    return () => context.revert();
  }, [arrival?.id, mode]);
  useEffect(() => {
    if (!arrival) return;
    const timer = window.setTimeout(() => clearSpaceArrival(arrival.generation), 4800);
    return () => window.clearTimeout(timer);
  }, [arrival?.id]);
  if (!arrival) return null;
  return <div ref={root} className="space-arrival" data-motion={mode}>
    <div className="space-arrival__edge" aria-hidden="true"><i /><i /><i /></div>
    <div className="space-arrival__sign" role="status">
      <span className="space-arrival__seal" aria-hidden="true"><DoorOpen size={22} /></span>
      <div><small>{arrival.reason === "create" ? "新书房准备好了" : "我们到了"}</small><strong>{arrival.name}</strong><span>{spaceRoleLabel(arrival)}</span></div>
      <button type="button" aria-label="收起到达桌签" onClick={() => clearSpaceArrival(arrival.generation)}><X size={15} /></button>
    </div>
  </div>;
}
