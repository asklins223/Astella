/** Lite reduces the room's motion while keeping the lesson's process visible. */
export function resolveArtifactMotion(mode: "full" | "lite" | "off", systemReduced: boolean): "full" | "reduced" {
  return systemReduced || mode === "off" ? "reduced" : "full";
}
