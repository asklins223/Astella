import { useEffect,useMemo,useState } from "react";
import { feedDiaryReferenceToCompanion } from "../../companion/companion-feed";
import { useCompanionDiaryActions } from "./companion-diary-actions";
import { todayIsoDate } from "./companion-diary-day";
import { DiaryPanel } from "./companion-diary-panel";
import { publishCompanionRecordsChanged,useCompanionRecordsRefresh,useCompanionResource } from "./use-companion-resource";
import { useDiscoveryBookmarks } from "./use-discovery-bookmarks";

export function CompanionDiaryPage(props: {
  refreshKey: number;
  requestedDate: string | null;
  onMemory: (id: string) => void;
  onSettings: () => void;
  sourceTarget?: { sourceId: string; revision?: number } | null;
  onSourceConsumed?: () => void;
}) {
  const [date, setDate] = useState<string | null>(props.requestedDate);
  const [month, setMonth] = useState((props.requestedDate ?? todayIsoDate()).slice(0, 7));
  const bookmarks = useDiscoveryBookmarks(props.refreshKey);
  const diary = useCompanionResource(async meta => {
    const result = await window.ailearn.companion.daily.get({ meta, ...(date ? { date } : {}) });
    return result.ok ? { ...result, data: { ...result.data, requestedDate: date } } : result;
  }, [date, props.refreshKey]);
  const calendar = useCompanionResource(meta => window.ailearn.companion.daily.month({ meta, month }), [month, props.refreshKey]);
  const reload = async () => { await Promise.all([diary.reload({ silent: true }), calendar.reload({ silent: true })]); };
  useCompanionRecordsRefresh(reload);
  useEffect(() => { if (props.requestedDate) setDate(props.requestedDate); }, [props.requestedDate]);
  const changingDate = diary.section?.ok && diary.section.value.requestedDate !== date;
  const section = changingDate ? null : diary.section;
  const shownDate = section?.ok ? section.value.date ?? date : date;
  useEffect(() => { if (shownDate) setMonth(shownDate.slice(0, 7)); }, [shownDate]);
  const actions = useCompanionDiaryActions({ date: shownDate, epochRef: diary.epochRef, reload: async () => { await reload(); publishCompanionRecordsChanged(); } });
  const marks = useMemo(() => calendar.section?.ok && calendar.section.value.month === month
    ? new Map(calendar.section.value.days.map(day => [day.date, day.status])) : null, [calendar.section, month]);
  return <>
    <DiaryPanel section={section} loading={diary.loading || Boolean(changingDate)} failure={diary.failure} date={date} onDate={setDate}
      onMemory={props.onMemory} onDiscussDiary={feedDiaryReferenceToCompanion}
      onHideDiary={actions.hide} onUnhideDiary={actions.unhide} onDeleteDiary={actions.remove}
      confirmDeleteDiary={actions.confirmingDelete} onConfirmDeleteDiary={actions.setConfirmingDelete}
      busy={actions.busy} notice={actions.notice} onRetry={() => void reload()} marks={marks}
      marksFailure={calendar.section && !calendar.section.ok ? calendar.section.message : calendar.failure}
      onMarksMonth={setMonth} discoveryFor={bookmarks.forRequest} sourceTarget={shownDate === props.requestedDate ? props.sourceTarget : null} onSourceConsumed={props.onSourceConsumed} />
    <div className="cc-page-note"><span>日记是否自动生成，在伴星设置里管理。</span><button type="button" className="cc-link" onClick={props.onSettings}>记录规则</button></div>
  </>;
}
