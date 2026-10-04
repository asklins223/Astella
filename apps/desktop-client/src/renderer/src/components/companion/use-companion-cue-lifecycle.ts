import { useEffect, useRef } from "react";

/** Presentation owns its timer after a delivery is acknowledged and leaves the projection. */
export function useCompanionCueLifecycle<T extends { readonly key: string }>(input: {
  cue: T | null;
  paused: boolean;
  scopeRevision: number;
  start: (cue: T) => (() => void) | void;
}) {
  const startRef = useRef(input.start);
  startRef.current = input.start;
  const active = useRef<{ scope: number; key: string | null; stop: (() => void) | null }>({
    scope: input.scopeRevision, key: null, stop: null,
  });
  useEffect(() => {
    const current = active.current;
    if (current.scope !== input.scopeRevision || input.paused) {
      current.stop?.();
      current.stop = null;
      current.key = null;
      current.scope = input.scopeRevision;
    }
    if (input.paused || !input.cue || current.key === input.cue.key) return;
    current.stop?.();
    const stop = startRef.current(input.cue);
    current.stop = stop ?? null;
    current.key = stop ? input.cue.key : null;
  }, [input.cue, input.paused, input.scopeRevision]);
  useEffect(() => () => {
    const current = active.current;
    current.stop?.();
    current.stop = null;
    current.key = null;
  }, []);
}
