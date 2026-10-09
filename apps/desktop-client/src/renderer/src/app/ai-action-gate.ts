import { createRequestMeta, unwrapGatewayResult } from "./desktop-client";
import { useRoomStore } from "./room-store";
import { notifyCompanion } from "../components/companion/companion-notifications";
import {
  companionConsentGate, COMPANION_CONSENT_REQUIRED_LINE, COMPANION_EXTERNAL_DISABLED_LINE,
  SETTINGS_ATTENTION_AI_CONSENT, SETTINGS_SECTION_AI_CONSENT,
  type CompanionConsentGateVerdict,
} from "./companion-consent-gate";

/** Local guidance must work before consent: never synthesize this notice. */
export function guideToAiSettings(reason: Exclude<CompanionConsentGateVerdict, null>): void {
  const room = useRoomStore.getState();
  notifyCompanion({
    id: "ai-permission-guidance", kind: "help", title: "还需要开启 AI 使用权限",
    body: reason === "external_disabled" ? COMPANION_EXTERNAL_DISABLED_LINE : COMPANION_CONSENT_REQUIRED_LINE,
    scope: room.workspaceScopeRevision, delivery: "immediate", repeat: true,
    actions: [{ id: "ai-settings", label: "查看 AI 使用设置", kind: "navigate", run: openAiSettings }],
  });
  openAiSettings();
}

function openAiSettings(): void {
  const room = useRoomStore.getState();
  room.setSettingsAttention(SETTINGS_ATTENTION_AI_CONSENT);
  room.setSettingsSection(SETTINGS_SECTION_AI_CONSENT);
  room.invoke("open-settings");
}

/** Check on each user action, before starting any task or replacing old work.
 * A failed read throws and cannot accidentally authorize an enqueue. */
export async function ensureAiActionAllowed(
  workspaceEpoch?: number,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const scope = useRoomStore.getState().workspaceScopeRevision;
  const settings = unwrapGatewayResult(await window.astella.workspace.getAiSettings({ meta: createRequestMeta(workspaceEpoch) }));
  if (scope !== useRoomStore.getState().workspaceScopeRevision || !isCurrent()) return false;
  const verdict = companionConsentGate(settings);
  if (verdict === null) return true;
  guideToAiSettings(verdict);
  return false;
}

/** The server repeats the gate inside its acceptance transaction. */
export function guideAiPermissionFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code !== "ai_consent_required" && code !== "ai_data_policy_denied") return false;
  guideToAiSettings(code === "ai_data_policy_denied" ? "external_disabled" : "consent_required");
  return true;
}
