import { describe, expect, it } from "vitest";

import { primaryControl } from "./primary-control";

const reason = "Only the person who started this, or a Space Owner, can stop it.";
const base = { hasContent: false, canSend: true, sending: false, canStop: false };

describe("primaryControl", () => {
  it("stops a Run the reader may stop once the Composer is empty", () => {
    expect(primaryControl({ ...base, canStop: true, stopUnavailableReason: null })).toEqual({
      kind: "stop",
      ready: true,
      unavailableReason: null,
    });
  });

  it("keeps another Member's Run's Stop in place, unavailable and saying why", () => {
    expect(primaryControl({ ...base, stopUnavailableReason: reason })).toEqual({
      kind: "stop",
      ready: false,
      unavailableReason: reason,
    });
  });

  it("sends what the Composer holds, whoever may stop the Run", () => {
    for (const canStop of [true, false])
      expect(
        primaryControl({ ...base, hasContent: true, canStop, stopUnavailableReason: reason }),
      ).toEqual({ kind: "send", ready: true });
  });

  it("sends nothing while the Composer is empty and no Run is beside it", () => {
    expect(primaryControl({ ...base, stopUnavailableReason: null })).toEqual({
      kind: "send",
      ready: false,
    });
  });
});
