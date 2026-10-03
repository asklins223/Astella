import type { CompanionAccountPatch,CompanionAccountStateV1 } from "@ailearn/shared/companion-shell-contracts";
import { useEffect,useRef,useState } from "react";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { COMPANION_ACCOUNT_CHANGED,publishCompanionAccountChanged } from "../../companion/companion-events";
import { useCompanionResource } from "../companion/use-companion-resource";

export function useCompanionAccountSettings() {
  const resource = useCompanionResource(meta => window.ailearn.companion.account.getState({ meta }));
  const [account, setAccount] = useState<CompanionAccountStateV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (resource.section?.ok) setAccount(resource.section.value.account); }, [resource.section]);
  useEffect(() => {
    const refresh = () => { void resource.reload({ silent: true }); };
    window.addEventListener(COMPANION_ACCOUNT_CHANGED, refresh);
    return () => window.removeEventListener(COMPANION_ACCOUNT_CHANGED, refresh);
  }, [resource.reload]);
  const patch = async (changes: Omit<CompanionAccountPatch, "revision">): Promise<boolean> => {
    if (!account || lock.current) return false;
    lock.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const updated = unwrapGatewayResult(await window.ailearn.companion.account.patchState({ meta: resource.meta(), request: { revision: account.revision, ...changes } }));
      setAccount(updated); setNotice("伴星设置已保存。"); publishCompanionAccountChanged();
      return true;
    } catch (cause) { const message = gatewayErrorMessage(cause); await resource.reload({ silent: true }); setError(message); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  return { account, busy, patch, error: error ?? (resource.section && !resource.section.ok ? resource.section.message : resource.failure), notice, loading: resource.loading, meta: resource.meta, reload: resource.reload };
}
