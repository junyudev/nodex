import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@/components/ui/toast";
import { toastFailure } from "./failure-toast";

vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));

describe("toastFailure", () => {
  beforeEach(() => {
    vi.mocked(toast.danger).mockClear();
  });

  it("leads with what failed and explains with the readable reason", () => {
    toastFailure(
      "Message not sent",
      new Error("Error invoking remote method 'agent:send': Error: The Agent is offline"),
    );

    expect(toast.danger).toHaveBeenCalledWith("Message not sent", {
      description: "The Agent is offline",
    });
  });

  it("omits a reason that is missing or only repeats the title", () => {
    toastFailure("Couldn't add files");
    toastFailure("Couldn't add files", new Error("Couldn't add files"));
    toastFailure("Couldn't add files", { notAnError: true });

    for (const call of vi.mocked(toast.danger).mock.calls) {
      expect(call).toEqual(["Couldn't add files", {}]);
    }
  });

  it("replaces the earlier toast for the same failure", () => {
    toastFailure("Couldn't save the draft", new Error("Disk full"), { id: "composer-draft-save" });

    expect(toast.danger).toHaveBeenCalledWith("Couldn't save the draft", {
      description: "Disk full",
      id: "composer-draft-save",
    });
  });
});
