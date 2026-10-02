import { useEffect } from "react";
import { mediaAssetUrl, type LearningRoomManifest } from "./learning-room-manifest";

// Keep decoded images alive so the first visit doesn't decode a scene plate
// in the same frame as mounting the paper. One idle request at a time; this
// never delays navigation or replaces the family's original artwork.
const decodedScenes = new Map<string, Promise<HTMLImageElement>>();

function decodeScene(url: string): Promise<HTMLImageElement> {
  const existing = decodedScenes.get(url);
  if (existing) return existing;
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  const result = image.decode().then(() => image).catch((error: unknown) => {
    decodedScenes.delete(url);
    throw error;
  });
  decodedScenes.set(url, result);
  if (decodedScenes.size > 12) decodedScenes.delete(decodedScenes.keys().next().value!);
  return result;
}

export function scheduleTaskScenePreload(manifest: LearningRoomManifest, theme: "day" | "night"): () => void {
  const urls = [...new Set(Object.values(manifest.taskPosters).map((plates) => mediaAssetUrl(manifest, plates[theme].path)))];
  let cancelled = false;
  let idle: number | null = null;
  let timer: number | null = null;
  const warmNext = () => {
    idle = null;
    timer = null;
    if (cancelled) return;
    const url = urls.shift();
    if (!url) return;
    void decodeScene(url).catch(() => undefined).finally(schedule);
  };
  const schedule = () => {
    if (cancelled || !urls.length) return;
    if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(warmNext);
    else timer = window.setTimeout(warmNext, 100);
  };
  schedule();
  return () => {
    cancelled = true;
    if (idle !== null) window.cancelIdleCallback(idle);
    if (timer !== null) window.clearTimeout(timer);
  };
}

export function useTaskScenePreload(manifest: LearningRoomManifest | null, theme: "day" | "night"): void {
  useEffect(() => manifest ? scheduleTaskScenePreload(manifest, theme) : undefined, [manifest, theme]);
}
