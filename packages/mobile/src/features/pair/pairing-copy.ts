/** What each way a pairing can fail means to the person, and what to do about it. */
export const pairingFailureMessage = (reason: string | undefined): string => {
  switch (reason) {
    case "invalid":
      return "That isn't a Nodex device link.";
    case "expired":
      return "That code has expired. Show a new one on the Space host.";
    case "rejected":
      return "The Space host turned that code down. Show a new one and try again.";
    case "unreachable":
      return "Couldn't reach the Space host. Check that this phone is on the same network or tailnet, and that Nodex is open.";
    case "busy":
      return "Still linking a Space. Try again in a moment.";
    case "incompatible":
      return "This version of Nodex Mobile and the Space host can't talk to each other. Update whichever is older.";
    case "locked":
      return "Saved Space credentials are unavailable. Unlock this phone and try again.";
    case "pin":
      return "The host certificate changed. Show a new device link to trust its current certificate.";
    default:
      return "Linking didn't finish. Show a new code and try again.";
  }
};

/** The failure code a pairing error carries, when it carries one. */
export const pairingFailureReason = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
};
