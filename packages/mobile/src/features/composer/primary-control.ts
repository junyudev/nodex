/**
 * What the Composer's one primary control does: send what it holds, or, while it is empty beside
 * a Run, stop that Run. A Run the reader may not stop still shows Stop, unavailable, with why.
 */
export type PrimaryControl =
  | { readonly kind: "send"; readonly ready: boolean }
  | { readonly kind: "stop"; readonly ready: boolean; readonly unavailableReason: string | null };

export const primaryControl = (input: {
  readonly hasContent: boolean;
  readonly canSend: boolean;
  readonly sending: boolean;
  /** Whether this Composer can stop the Run beside it. */
  readonly canStop: boolean;
  /** Why the reader may not stop that Run, when there is one they may not. */
  readonly stopUnavailableReason: string | null;
}): PrimaryControl => {
  const unavailableReason = input.canStop ? null : input.stopUnavailableReason;
  if (!input.hasContent && (input.canStop || unavailableReason !== null))
    return { kind: "stop", ready: unavailableReason === null, unavailableReason };
  return { kind: "send", ready: input.hasContent && input.canSend && !input.sending };
};
