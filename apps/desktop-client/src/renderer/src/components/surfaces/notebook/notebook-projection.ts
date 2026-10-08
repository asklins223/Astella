import type { AstellaDesktopApiM2, GatewayResultV1 } from "@astella/shared/desktop-ipc-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import type { NotebookProjection } from "./notebook-surface";

/** 正文、首页和能力同时读取；来源、记录与学习状态只依赖笔记身份，彼此不等待。 */
export async function readNotebookProjection({ api, workspaceEpoch, noteId, readLegacyRoute, legacyRouteRequestedFor }: {
  api: AstellaDesktopApiM2;
  workspaceEpoch: number;
  noteId?: string;
  readLegacyRoute: boolean;
  legacyRouteRequestedFor: string | null;
}): Promise<NotebookProjection> {
  const meta = () => createRequestMeta(workspaceEpoch);
  const roomPromise = api.room.getProjection({ meta: meta() }).then(unwrapGatewayResult);
  const capabilityPromise = api.capabilities.get({ meta: meta() }).then(unwrapGatewayResult);
  // 先挂上拒绝处理，避免另一路读取失败时留下未处理的 Promise。
  void roomPromise.catch(() => undefined);
  void capabilityPromise.catch(() => undefined);
  const initialRoom = noteId ? null : await roomPromise;
  const selectedId = noteId ?? (initialRoom?.primaryFocus.state === "data" ? initialRoom.primaryFocus.data.objective.sources.primaryNote?.noteId : undefined);
  if (!selectedId) throw new Error("这一篇笔记还没定下来是哪一篇，不能编辑，也不能生成学习卡。");
  const note = unwrapGatewayResult(await api.note.get({ meta: meta(), noteId: selectedId }));
  const optional = async <T,>(read: () => Promise<GatewayResultV1<T>>) => unwrapGatewayResult(await read());
  const [room, capabilities, source, latest, objectives, subscriptions, round, history, route] = await Promise.allSettled([
    roomPromise,
    capabilityPromise,
    note.sourceId ? optional(() => api.source.get({ meta: meta(), sourceId: note.sourceId! })) : Promise.resolve(null),
    api.contract.enabledRoutes.includes("note.cardGeneration")
      ? optional(() => api.note.cardGeneration.latestRun({ meta: meta(), noteId: note.noteId })) : Promise.resolve(null),
    optional(() => api.objective.list({ meta: meta(), limit: 1, lifecycle: "active", noteId: note.noteId })),
    optional(() => api.review.listNoteSubscriptions({ meta: meta() })),
    optional(() => api.noteLearningRound.open({ meta: meta(), noteId: note.noteId })),
    optional(() => api.noteLearningRound.history({ meta: meta(), noteId: note.noteId })),
    readLegacyRoute || legacyRouteRequestedFor === note.noteId
      ? optional(() => api.noteLearningRound.route({ meta: meta(), noteId: note.noteId })) : Promise.resolve(null),
  ]);
  if (room.status === "rejected") throw room.reason;
  if (capabilities.status === "rejected") throw capabilities.reason;
  const focus = room.value.primaryFocus.state === "data" ? room.value.primaryFocus.data : null;
  const objective = objectives.status === "fulfilled" ? objectives.value.items[0] : null;
  const subscription = subscriptions.status === "fulfilled" ? subscriptions.value.items
    .find(item => item.subjectType === "note" && item.subjectId === note.noteId) : null;
  const openRound = round.status === "fulfilled" ? round.value?.round ?? null : null;
  let roundTeachingView: NotebookProjection["roundTeachingView"] = null;
  let roundTeachingFailure: string | null = null;
  if (openRound) {
    try {
      roundTeachingView = unwrapGatewayResult(await api.noteLearningRound.teaching({ meta: meta(), roundId: openRound.roundId }));
    } catch (error) { roundTeachingFailure = gatewayErrorMessage(error); }
  }
  return {
    note,
    source: source.status === "fulfilled" ? source.value : null,
    sourceFailure: source.status === "rejected" ? gatewayErrorMessage(source.reason) : null,
    latestGenerationRun: latest.status === "fulfilled" ? latest.value : null,
    objective: focus?.objective.sources.primaryNote?.noteId === note.noteId ? focus.objective : null,
    noteObjective: objective ? { objectiveId: objective.objectiveId, publicSummary: objective.publicSummary, reviewHold: objective.reviewHold ?? null } : null,
    noteSubscription: subscription ?? null,
    openRound,
    openRoundContentMoved: round.status === "fulfilled" ? round.value?.contentMoved ?? false : false,
    openRoundNoteChangeImpact: round.status === "fulfilled" ? round.value?.noteChangeImpact ?? null : null,
    roundHistory: history.status === "fulfilled" ? history.value : null,
    routeCoverage: route.status === "fulfilled" ? route.value : null,
    routeCoverageFailure: route.status === "rejected" ? gatewayErrorMessage(route.reason) : null,
    roundTeachingView, roundTeachingFailure,
    capabilities: capabilities.value,
    activeGeneration: room.value.activeGenerationSummary,
  };
}
