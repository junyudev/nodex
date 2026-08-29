import { describe, expect, test } from "vite-plus/test";

import {
  attachNodexStructuralClipboardWriteClaim,
  decodeNodexClipboardEnvelope,
  encodeNodexClipboardEnvelope,
  readNodexClipboardWriteClaim,
  type NodexClipboardEnvelopeV1,
} from "../shared/clipboard-paste";
import { writeStructuralClipboard } from "./clipboard-structural-writer";

const envelope: NodexClipboardEnvelopeV1 = {
  version: 1,
  profileId: "profile-1",
  libraryId: "library-1",
  storeEpoch: "epoch-1",
  bundleId: "bundle-1",
  capability: "a".repeat(64),
  manifestHash: "b".repeat(64),
  actionHint: "cut",
};
const writeClaim = "0199134e-cbb0-7000-8000-000000000003";
const pendingHtml = () =>
  attachNodexStructuralClipboardWriteClaim("<p>Subpage title</p>", writeClaim);

describe("structural clipboard writer", () => {
  test("writes one native HTML/plain payload and verifies the capability on readback", () => {
    let writtenHtml = pendingHtml();
    let writtenText = "";

    const result = writeStructuralClipboard(
      {
        envelope,
        writeClaim,
        html: "<p>Subpage title</p>",
        text: "Subpage title",
      },
      {
        write: ({ html, text }) => {
          writtenHtml = html ?? "";
          writtenText = text ?? "";
        },
        readHTML: () => writtenHtml,
        readText: () => writtenText,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(writtenText).toBe("Subpage title");
    expect(writtenHtml).toContain("<p>Subpage title</p>");
    expect(decodeNodexClipboardEnvelope(writtenHtml)).toEqual(envelope);
    expect(readNodexClipboardWriteClaim(writtenHtml)).toBe(writeClaim);
  });

  test("rejects a final readback that retained the capability but lost its write claim", () => {
    let html = pendingHtml();
    const result = writeStructuralClipboard(
      {
        envelope,
        writeClaim,
        html: "<p>Subpage title</p>",
        text: "Subpage title",
      },
      {
        write: ({ html: nextHtml }) => {
          html = nextHtml?.replace(/\sdata-nodex-clipboard-write-claim="[^"]+"/u, "") ?? "";
        },
        readHTML: () => html,
        readText: () => "Subpage title",
      },
    );

    expect(result).toEqual({ ok: false, failure: "readback_mismatch" });
  });

  test("does not treat a successful write with a mismatched readback as a cut acknowledgement", () => {
    let html = pendingHtml();
    const result = writeStructuralClipboard(
      {
        envelope,
        writeClaim,
        html: "<p>Subpage title</p>",
        text: "Subpage title",
      },
      {
        write: () => {
          html = encodeNodexClipboardEnvelope({ ...envelope, capability: "c".repeat(64) });
        },
        readHTML: () => html,
        readText: () => "Subpage title",
      },
    );

    expect(result).toEqual({ ok: false, failure: "readback_mismatch" });
  });

  test("does not overwrite a newer native clipboard value", () => {
    let writeCount = 0;
    const result = writeStructuralClipboard(
      {
        envelope,
        writeClaim,
        html: "<p>Subpage title</p>",
        text: "Subpage title",
      },
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

  test("treats readback failures as an unacknowledged write", () => {
    let readCount = 0;
    const result = writeStructuralClipboard(
      {
        envelope,
        writeClaim,
        html: "<p>Subpage title</p>",
        text: "Subpage title",
      },
      {
        write: () => undefined,
        readHTML: () => {
          readCount += 1;
          if (readCount === 1) return pendingHtml();
          throw new Error("clipboard unavailable");
        },
        readText: () => "Subpage title",
      },
    );

    expect(result).toEqual({ ok: false, failure: "readback_mismatch" });
  });

  test("reports native clipboard failures without acknowledging the write", () => {
    const result = writeStructuralClipboard(
      {
        envelope,
        writeClaim,
        html: "<p>Subpage title</p>",
        text: "Subpage title",
      },
      {
        write: () => {
          throw new Error("clipboard unavailable");
        },
        readHTML: () => pendingHtml(),
        readText: () => "Subpage title",
      },
    );

    expect(result).toEqual({ ok: false, failure: "write_failed" });
  });

  test("rejects invalid or oversized envelopes before touching the clipboard", () => {
    let writeCount = 0;
    const clipboard = {
      write: () => {
        writeCount += 1;
      },
      readHTML: () => "",
      readText: () => "",
    };

    expect(
      writeStructuralClipboard(
        {
          envelope: { ...envelope, version: 2 as 1 },
          writeClaim,
          html: "<p>Ignored</p>",
          text: "Ignored",
        },
        clipboard,
      ),
    ).toEqual({ ok: false, failure: "write_failed" });

    expect(
      writeStructuralClipboard(
        {
          envelope: { ...envelope, profileId: "x".repeat(4096) },
          writeClaim,
          html: "<p>Ignored</p>",
          text: "Ignored",
        },
        clipboard,
      ),
    ).toEqual({ ok: false, failure: "write_failed" });
    expect(writeCount).toBe(0);
  });
});
