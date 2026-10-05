import type { GatewayResultV1,RequestMetaV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { useCallback,useEffect } from "react";
import { createRequestMeta } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { COMPANION_RECORDS_CHANGED } from "../../companion/companion-events";
import { useSurfaceProjection } from "../notebook/surface-data";
import { readSection } from "./companion-center-model";
export { COMPANION_ACCOUNT_CHANGED,COMPANION_RECORDS_CHANGED,publishCompanionAccountChanged,publishCompanionRecordsChanged } from "../../companion/companion-events";

/** Each page owns its request and failure; one unavailable capability never blanks the directory. */
export function useCompanionResource<T>(read: (meta: RequestMetaV1) => Promise<GatewayResultV1<T>>, deps: readonly unknown[] = [], enabled = true) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const projection = useSurfaceProjection(async ({ workspaceEpoch }) => ({ scope,
    section: enabled ? await readSection(() => read(createRequestMeta(workspaceEpoch))) : null }), [enabled, scope, ...deps], { refreshOnFocus: true });
  const meta = useCallback(() => createRequestMeta(projection.epochRef.current), [projection.epochRef]);
  return { ...projection, section: projection.data?.scope === scope ? projection.data.section : null, meta };
}

export function useCompanionRecordsRefresh(reload: () => Promise<void>) {
  useEffect(() => {
    const refresh = () => { void reload(); };
    window.addEventListener(COMPANION_RECORDS_CHANGED, refresh);
    window.addEventListener("ailearn:companion-activity-changed", refresh);
    return () => { window.removeEventListener(COMPANION_RECORDS_CHANGED, refresh); window.removeEventListener("ailearn:companion-activity-changed", refresh); };
  }, [reload]);
}
