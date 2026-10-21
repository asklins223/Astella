
import { safeUuid } from "./desktop-gateway-uuid";
import type { GatewayTransport } from "./desktop-gateway-transport";

export async function getNoteLearningArtifactHtml(t: GatewayTransport, artifactId: string, requestId?: string): Promise<string> {
    await t.ensureConnected(requestId);
    const result = await t.requestBinaryBytes(
      `/v2/note-learning-artifacts/${safeUuid(artifactId)}`,
      { method: "GET" },
      { accept: "text/html", contentTypePrefix: "text/html", maxBytes: Number.POSITIVE_INFINITY },
      requestId,
    );
    return Buffer.from(result.bytes).toString("utf8");
  }

export async function getNoteLearningRoundArtifactHtml(t: GatewayTransport, artifactId: string, requestId?: string): Promise<string> {
    await t.ensureConnected(requestId);
    const result = await t.requestBinaryBytes(
      `/v2/note-learning-round-artifacts/${safeUuid(artifactId)}`,
      { method: "GET" },
      { accept: "text/html", contentTypePrefix: "text/html", maxBytes: Number.POSITIVE_INFINITY },
      requestId,
    );
    return Buffer.from(result.bytes).toString("utf8");
  }

/** Trusted operation template, stored through the same isolated artifact surface. */
export async function getNoteLearningCardOperationHtml(t: GatewayTransport, artifactId: string, requestId?: string): Promise<string> {
  await t.ensureConnected(requestId);
  const result = await t.requestBinaryBytes(
    `/v2/note-learning-card-operation-artifacts/${safeUuid(artifactId)}`,
    { method: "GET" },
    { accept: "text/html", contentTypePrefix: "text/html", maxBytes: Number.POSITIVE_INFINITY },
    requestId,
  );
  return Buffer.from(result.bytes).toString("utf8");
}
