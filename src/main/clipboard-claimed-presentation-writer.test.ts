import { describe, expect, test } from "vite-plus/test";

import { attachNodexClipboardWriteClaim } from "../shared/clipboard-paste";
import { writeClaimedClipboardPresentation } from "./clipboard-claimed-presentation-writer";

const writeClaim = "0199134e-cbb0-7000-8000-000000000003";

describe("claimed clipboard presentation writer", () => {
  test("replaces the claimed presentation and verifies plain-text readback", () => {
    let html = attachNodexClipboardWriteClaim("<p>Portable</p>", writeClaim);
    let text = "Portable";

    const result = writeClaimedClipboardPresentation(
      { writeClaim, html: "<p>Portable</p>", text: "/profile/assets/a.blob" },
      {
        write: (next) => {
          html = next.html ?? "";
          text = next.text ?? "";
        },
        readHTML: () => html,
        readText: () => text,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(html).toBe("<p>Portable</p>");
    expect(text).toBe("/profile/assets/a.blob");
  });

  test("does not overwrite a newer clipboard value", () => {
    let writeCount = 0;
    const result = writeClaimedClipboardPresentation(
      { writeClaim, html: "<p>Portable</p>", text: "/profile/assets/a.blob" },
      {
        write: () => {
          writeCount += 1;
        },
        readHTML: () => "<p>Newer copy</p>",
        readText: () => "Newer copy",
      },
    );

    expect(result).toEqual({ ok: false, failure: "superseded" });
    expect(writeCount).toBe(0);
  });

  test("rejects mismatched native readback", () => {
    const result = writeClaimedClipboardPresentation(
      { writeClaim, html: "<p>Portable</p>", text: "/profile/assets/a.blob" },
      {
        write: () => undefined,
        readHTML: () => attachNodexClipboardWriteClaim("<p>Portable</p>", writeClaim),
        readText: () => "Different",
      },
    );

    expect(result).toEqual({ ok: false, failure: "readback_mismatch" });
  });

  test("does not let malformed IPC input claim an unclaimed clipboard", () => {
    let writeCount = 0;
    const result = writeClaimedClipboardPresentation(
      { writeClaim: null, html: "<p>Injected</p>", text: "Injected" } as never,
      {
        write: () => {
          writeCount += 1;
        },
        readHTML: () => "<p>Unclaimed</p>",
        readText: () => "Unclaimed",
      },
    );

    expect(result).toEqual({ ok: false, failure: "write_failed" });
    expect(writeCount).toBe(0);
  });
});
