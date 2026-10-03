import { useLayoutEffect, useRef, useState } from "react";
import { useRoomStore } from "../../../app/room-store";

export type StudyTab = "today" | "rounds" | "spaces";
type Position = { scope: number; tab: StudyTab; scroll: Record<StudyTab, number>; roundsShown: number };
// Retain only a reading position. Records are always read again from the gateway.
let resume: Position | null = null;
const fresh = (scope: number): Position => ({ scope, tab: "today", scroll: { today: 0, rounds: 0, spaces: 0 }, roundsShown: 0 });

export const studyRoundReadingDepth = (scope: number) => resume?.scope === scope ? resume.roundsShown : 0;

export function useStudyJournalPosition(loading: Record<StudyTab, boolean>, roundsShown: number) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const position = useRef(resume?.scope === scope ? { ...resume, scroll: { ...resume.scroll } } : fresh(scope));
  const [tab, setTab] = useState<StudyTab>(position.current.tab);
  const paperRef = useRef<HTMLDivElement>(null);
  const restoring = useRef(true);

  useLayoutEffect(() => {
    if (position.current.scope === scope) return;
    position.current = fresh(scope); resume = null; restoring.current = true;
    setTab("today");
  }, [scope]);
  useLayoutEffect(() => {
    if (!restoring.current || loading[tab] || !paperRef.current) return;
    paperRef.current.scrollTop = position.current.scroll[tab];
    restoring.current = false;
  }, [tab, loading.today, loading.rounds, loading.spaces]);
  useLayoutEffect(() => {
    if (!loading.rounds) position.current.roundsShown = roundsShown;
  }, [loading.rounds, roundsShown]);
  useLayoutEffect(() => () => {
    if (position.current.scope === useRoomStore.getState().workspaceScopeRevision)
      resume = { ...position.current, scroll: { ...position.current.scroll } };
  }, []);

  const select = (next: StudyTab) => {
    if (next === tab) return;
    position.current.tab = next; restoring.current = true; setTab(next);
  };
  const rememberScroll = () => {
    if (!restoring.current && paperRef.current)
      position.current.scroll[tab] = paperRef.current.scrollTop;
  };
  return { tab, select, paperRef, rememberScroll };
}
