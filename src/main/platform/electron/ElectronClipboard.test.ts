import { describe, expect, test } from "vite-plus/test";

import {
  attachNodexStructuralClipboardWriteClaim,
  encodeNodexStructuralClipboardDescriptor,
  NODEX_STRUCTURAL_CLIPBOARD_MIME,
} from "../../../shared/clipboard-paste";
import { makeElectronClipboardPort, type ElectronClipboardTarget } from "./ElectronClipboard";

const writeClaim = "0199134e-cbb0-7000-8000-000000000003";

const makeTarget = () => {
  let html = attachNodexStructuralClipboardWriteClaim("<p>Portable</p>", writeClaim);
  let text = "Portable";
  const formats = new Map<string, string>([
    [
      NODEX_STRUCTURAL_CLIPBOARD_MIME,
      encodeNodexStructuralClipboardDescriptor({
        version: 1,
        phase: "preparing",
        writeClaim,
        actionHint: "copy",
      }),
    ],
  ]);
  const target: ElectronClipboardTarget = {
    availableFormats: () => [...formats.keys(), "text/html", "text/plain"],
    read: () => "",
    readBuffer: (format) => Buffer.from(formats.get(format) ?? "", "utf8"),
    readHTML: () => html,
    readText: () => text,
    write: (next) => {
      html = next.html ?? "";
      text = next.text ?? "";
      formats.clear();
    },
    writeImage: () => undefined,
  };
  return { port: makeElectronClipboardPort(target), read: () => ({ html, text }) };
};

describe("Electron clipboard adapter", () => {
  test("prefers a valid private structural descriptor over the HTML compatibility claim", () => {
    const { port } = makeTarget();

    expect(port.readStructuralDescriptor()).toMatchObject({ writeClaim, phase: "preparing" });
    expect(port.readStructuralWriteClaim()).toBe(writeClaim);
  });

  test("normalizes Electron custom formats stored only as native buffers", () => {
    const { port } = makeTarget();

    expect(port.readFormat(NODEX_STRUCTURAL_CLIPBOARD_MIME)).toContain('"phase":"preparing"');
  });

  test("replaces only the currently claimed presentation and verifies readback", () => {
    const { port, read } = makeTarget();

    expect(
      port.replaceClaimedPresentation({
        writeClaim,
        html: "<p>Portable</p>",
        text: "/profile/assets/a.blob",
      }),
    ).toEqual({ ok: true });
    expect(read()).toEqual({ html: "<p>Portable</p>", text: "/profile/assets/a.blob" });
    expect(
      port.replaceClaimedPresentation({
        writeClaim,
        html: "<p>Older</p>",
        text: "Older",
      }),
    ).toEqual({ ok: false, failure: "superseded" });
  });
});
