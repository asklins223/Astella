import type * as Y from "yjs";
import { Fragment, Slice } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type { CompanionEditNoteV1, CompanionNoteEditingContextV1 } from "@astella/shared/companion-note-authoring-contracts";
import { transformCompanionNoteEdit } from "@astella/shared/note-companion-transform";
import { noteDocSchema } from "./doc-fragment.ts";
export { NoteEditConflict } from "@astella/shared/note-companion-transform";

/** Preview and saved edits share one transform. Only this adapter mutates CRDT. */
export function applyCompanionNoteEdit(doc: Y.Doc, input: CompanionEditNoteV1, editing?: CompanionNoteEditingContextV1): void {
  const fragment = doc.getXmlFragment("content");
  const before = noteDocSchema().nodeFromJSON(yXmlFragmentToProsemirrorJSON(fragment));
  const next = transformCompanionNoteEdit(before, input, editing, { Fragment, Slice, Transform });
  doc.transact(() => updateYFragment(doc, fragment, next, { mapping: new Map(), isOMark: new Map() }), "companion-edit");
}
