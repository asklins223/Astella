import { EventEmitter } from "node:events";

export type SessionRevocation = { tokenHash: string } | { userId: string; workspaceId?: string };
const events = new EventEmitter();

/** Emitted only after the transaction that revoked the credential commits. */
export function notifySessionRevoked(event: SessionRevocation): void {
  events.emit("revoked", event);
}

export function onSessionRevoked(listener: (event: SessionRevocation) => void): () => void {
  events.on("revoked", listener);
  return () => events.off("revoked", listener);
}
