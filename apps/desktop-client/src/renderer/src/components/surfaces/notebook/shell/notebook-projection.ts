import type { AstellaDesktopApiM2, GatewayResultV1 } from "@astella/shared/desktop-ipc-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../../app/client/desktop-client";
import type { NotebookProjection } from "./notebook-surface.tsx";

/** A note opens by its own identity and permissions. Retired home projections
 * or unrelated capabilities must not make an existing note unreadable. */
export async function readNotebookProjection({ api, workspaceEpoch, noteId }: {
  api: AstellaDesktopApiM2;
  workspaceEpoch: number;
  noteId?: string;
}): Promise<NotebookProjection> {
  const meta = () => createRequestMeta(workspaceEpoch);
  if (!noteId) throw new Error("请先从笔记库选择要打开的笔记。");
  const note = unwrapGatewayResult(await api.note.get({ meta: meta(), noteId }));
  const optional = async <T,>(read: () => Promise<GatewayResultV1<T>>) => unwrapGatewayResult(await read());
  const [source] = await Promise.allSettled([
    note.sourceId ? optional(() => api.source.get({ meta: meta(), sourceId: note.sourceId! })) : Promise.resolve(null),
  ]);
  return {
    note,
    source: source.status === "fulfilled" ? source.value : null,
    sourceFailure: source.status === "rejected" ? gatewayErrorMessage(source.reason) : null,
  };
}
