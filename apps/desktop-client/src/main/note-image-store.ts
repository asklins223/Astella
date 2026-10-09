import { SOURCE_IMAGE_MAX_BYTES } from "@astella/shared/source-image-contracts";
import { ImageByteStore } from "./image-byte-store";
export type { ImageBytes as NoteImageBytes } from "./image-byte-store";

export const NOTE_IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export class NoteImageStore extends ImageByteStore {
  constructor(directory: string, maxBytes = NOTE_IMAGE_CACHE_MAX_BYTES) {
    super(directory, maxBytes, SOURCE_IMAGE_MAX_BYTES);
  }
}
let store: NoteImageStore | null = null;
export function createNoteImageStore(directory: string): NoteImageStore { return store = new NoteImageStore(directory); }
export function getNoteImageStore(): NoteImageStore | null { return store; }
