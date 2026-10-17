/** Some IMEs clear isComposing on the Enter that commits a candidate.
 * The native 229 marker still identifies that key as part of composition. */
export function isCompanionComposition(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function shouldSendCompanionOnEnter(event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
  readonly nativeEvent: Pick<KeyboardEvent, "isComposing" | "keyCode">;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.defaultPrevented
    && !isCompanionComposition(event.nativeEvent);
}
