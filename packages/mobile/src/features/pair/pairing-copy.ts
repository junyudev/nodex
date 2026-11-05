/** What each way a pairing can fail means to the person, and what to do about it. */
export const pairingFailureMessage = (reason: string | undefined): string => {
  switch (reason) {
    case "invalid":
      return "That isn't a Nodex pairing code.";
    case "expired":
      return "That code has expired. Show a new one on your desktop.";
    case "rejected":
      return "Your desktop turned that code down. Show a new one and try again.";
    case "unreachable":
      return "Couldn't reach your desktop. Check that this phone is on the same network or tailnet, and that Nodex is open.";
    case "busy":
      return "Still connecting to a desktop. Try again in a moment.";
    case "incompatible":
      return "This version of Nodex Mobile and your desktop can't talk to each other. Update whichever is older.";
    default:
      return "Pairing didn't finish. Show a new code and try again.";
  }
};

/** The failure code a pairing error carries, when it carries one. */
export const pairingFailureReason = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
};
