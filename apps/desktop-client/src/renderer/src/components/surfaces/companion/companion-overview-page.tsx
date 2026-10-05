import { useEffect } from "react";
import { useCompanionChat } from "../../../app/companion-chat-session";
import { createRequestMeta } from "../../../app/desktop-client";
import { companionDisplayName,publishCompanionDisplayName } from "../../companion/companion-display-name";
import { useSurfaceProjection } from "../notebook/surface-data";
import { readSection,type CompanionCenterTab } from "./companion-center-model";
import { CompanionCenterOverview } from "./companion-center-overview";
import { SectionState } from "./companion-center-primitives";
import { useCompanionRecordsRefresh } from "./use-companion-resource";

export function CompanionOverviewPage({ refreshKey, onGo, onDiary }: { refreshKey: number; onGo: (tab: CompanionCenterTab) => void; onDiary: (date: string | null) => void }) {
  const chat = useCompanionChat();
  const resource = useSurfaceProjection(async ({ workspaceEpoch }) => {
    const meta = () => createRequestMeta(workspaceEpoch);
    const [persona, diary, history, activity] = await Promise.all([
      readSection(() => window.ailearn.companion.persona.get({ meta: meta() })),
      readSection(() => window.ailearn.companion.daily.get({ meta: meta() })),
      readSection(() => window.ailearn.companion.history.list({ meta: meta(), query: { limit: 10 } })),
      readSection(() => window.ailearn.companion.activity.timeline({ meta: meta() })),
    ]);
    return { persona, diary, history, activity };
  }, [refreshKey], { refreshOnFocus: true });
  useCompanionRecordsRefresh(resource.reload);
  useEffect(() => {
    if (!resource.data?.persona.ok) return;
    const name = companionDisplayName(resource.data.persona.value);
    chat.setCompanionName(name);
    publishCompanionDisplayName(name);
  }, [resource.data?.persona, chat.setCompanionName]);
  if (!resource.data) return <SectionState message={resource.failure ? "近况暂时读不到" : "正在翻开陪伴手册…"} detail={resource.failure ?? undefined} onRetry={resource.failure ? () => void resource.reload() : undefined} />;
  const { diary, history, activity } = resource.data;
  return <CompanionCenterOverview companionName={chat.companionName} diary={diary} history={history} activity={activity} onContinue={() => chat.setMode("conversation")} onGo={target => target === "diary" ? onDiary(diary.ok ? diary.value.date : null) : onGo(target)} />;
}
