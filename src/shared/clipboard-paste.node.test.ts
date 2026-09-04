import { describe, expect, test } from "vite-plus/test";

import {
  attachNodexClipboardEnvelope,
  attachNodexClipboardFragment,
  attachNodexClipboardWriteClaim,
  attachNodexStructuralClipboardWriteClaim,
  decodeNodexStructuralClipboardDescriptor,
  encodeNodexClipboardEnvelope,
  encodeNodexStructuralClipboardDescriptor,
  hasNodexStructuralClipboardFallback,
  hasUntrustedTypedOwnerHtml,
  inspectNodexClipboardHtml,
  NODEX_CLIPBOARD_FRAGMENT_MAX_ENCODED_LENGTH,
  readNodexClipboardFragment,
  readNodexClipboardWriteClaim,
  sanitizeUntrustedTypedOwnerHtml,
  type NodexClipboardEnvelopeV1,
} from "./clipboard-paste";

const envelope: NodexClipboardEnvelopeV1 = {
  version: 1,
  profileId: "profile-1",
  libraryId: "library-1",
  storeEpoch: "epoch-1",
  bundleId: "bundle-1",
  capability: "a".repeat(64),
  manifestHash: "b".repeat(64),
  actionHint: "copy",
};
const writeClaim = "0199134e-cbb0-7000-8000-000000000004";

describe("portable clipboard fragments", () => {
  test("round-trips Unicode rich content and slice boundaries through native HTML wrappers", () => {
    const fragment = '<div data-pm-slice="0 0 -1 []"><p>层级 🎨 &amp; text</p></div>';
    const html = attachNodexClipboardFragment("<p>层级 🎨 &amp; text</p>", fragment);
    expect(attachNodexClipboardFragment(html, fragment)).toBe(html);
    const inspected = inspectNodexClipboardHtml(
      attachNodexClipboardEnvelope(html, envelope, writeClaim),
    );
    expect(
      readNodexClipboardFragment(attachNodexClipboardEnvelope(html, envelope, writeClaim)),
    ).toBe(fragment);
    expect(inspected.envelope).toEqual(envelope);
    expect(inspected.fallbackHtml).toContain("<p>层级 🎨 &amp; text</p>");
    expect(readNodexClipboardFragment(inspected.fallbackHtml)).toBeNull();
  });

  test("cannot smuggle typed-owner authority through an encoded fragment", () => {
    const unsafe = '<div data-content-type="page">Subpage</div>';
    // Bypass our writer to exercise the external/untrusted reader boundary.
    const html = `<p data-nodex-clipboard-fragment-v1="${Buffer.from(unsafe).toString("base64url")}">Subpage</p>`;
    expect(readNodexClipboardFragment(html)).toBe(sanitizeUntrustedTypedOwnerHtml(unsafe));
    expect(inspectNodexClipboardHtml(html).envelope).toBeNull();
  });

  test.each(["%%%", "_w", "", "A".repeat(NODEX_CLIPBOARD_FRAGMENT_MAX_ENCODED_LENGTH + 1)])(
    "ignores malformed or oversized fragment %#",
    (encoded) => {
      const html = `<div data-nodex-clipboard-fragment-v1="${encoded}"><p>Fallback</p></div>`;
      expect(readNodexClipboardFragment(html)).toBeNull();
      expect(inspectNodexClipboardHtml(html).fallbackHtml).toBe("<div><p>Fallback</p></div>");
    },
  );
});

describe("Nodex structural clipboard sidecar", () => {
  test("round-trips strict preparing and ready private descriptors", () => {
    const preparing = {
      version: 1,
      phase: "preparing",
      writeClaim,
      actionHint: "cut",
    } as const;
    const ready = { ...preparing, phase: "ready", envelope } as const;

    expect(
      decodeNodexStructuralClipboardDescriptor(encodeNodexStructuralClipboardDescriptor(preparing)),
    ).toEqual(preparing);
    expect(
      decodeNodexStructuralClipboardDescriptor(encodeNodexStructuralClipboardDescriptor(ready)),
    ).toEqual(ready);
  });

  test("rejects malformed, oversized, and authority-shaped private descriptors", () => {
    expect(decodeNodexStructuralClipboardDescriptor("not json")).toBeNull();
    expect(
      decodeNodexStructuralClipboardDescriptor(
        JSON.stringify({
          version: 1,
          phase: "preparing",
          writeClaim,
          actionHint: "cut",
          closure: { blocks: [] },
        }),
      ),
    ).toBeNull();
    expect(
      decodeNodexStructuralClipboardDescriptor(
        JSON.stringify({
          version: 1,
          phase: "ready",
          writeClaim,
          actionHint: "cut",
        }),
      ),
    ).toBeNull();
    expect(decodeNodexStructuralClipboardDescriptor("x".repeat(4 * 1024 + 1))).toBeNull();
  });

  test("round-trips one bounded envelope while retaining a safe fallback marker", () => {
    const html = attachNodexClipboardEnvelope("<p>Shareable fallback</p>", envelope);

    const inspected = inspectNodexClipboardHtml(html);

    expect(inspected.envelope).toEqual(envelope);
    expect(inspected.fallbackHtml).toContain("<p>Shareable fallback</p>");
    expect(inspected.fallbackHtml).not.toContain("nodex-clipboard-envelope-v1");
    expect(inspected.hasStructuralFallback).toBe(true);
    expect(hasNodexStructuralClipboardFallback(inspected.fallbackHtml)).toBe(true);
  });

  test("keeps the exact write claim beside the final envelope until cut preparation settles", () => {
    const html = attachNodexClipboardEnvelope("<p>Shareable fallback</p>", envelope, writeClaim);

    const inspected = inspectNodexClipboardHtml(html);

    expect(inspected.envelope).toEqual(envelope);
    expect(inspected.writeClaim).toBe(writeClaim);
    expect(readNodexClipboardWriteClaim(html)).toBe(writeClaim);
  });

  test("removes typed-owner semantics from portable HTML", () => {
    const unsafe = [
      '<div data-content-type="page">Page</div>',
      "<div data-content-type='database'>Database</div>",
      "<div data-content-type=canvas>Canvas</div>",
      '<div data-content-type="pageRef">Reference</div>',
    ].join("");

    const sanitized = sanitizeUntrustedTypedOwnerHtml(unsafe);
    const inspected = inspectNodexClipboardHtml(attachNodexClipboardEnvelope(unsafe, envelope));

    expect(hasUntrustedTypedOwnerHtml(sanitized)).toBe(false);
    expect(sanitized).toContain('data-content-type="pageRef"');
    expect(inspected.fallbackHtml).toContain('data-nodex-structural-fallback-type="page"');
    expect(inspected.fallbackHtml).not.toContain('data-content-type="page"');
  });

  test("round-trips a safe synchronous write claim without owner authority", () => {
    const html = attachNodexStructuralClipboardWriteClaim(
      '<div data-content-type="page">Subpage</div>',
      writeClaim,
    );
    const inspected = inspectNodexClipboardHtml(html);

    expect(inspected.writeClaim).toBe(writeClaim);
    expect(readNodexClipboardWriteClaim(html)).toBe(writeClaim);
    expect(inspected.envelope).toBeNull();
    expect(hasUntrustedTypedOwnerHtml(inspected.fallbackHtml)).toBe(false);

    const replacement = "0199134e-cbb0-7000-8000-000000000007";
    const replaced = attachNodexStructuralClipboardWriteClaim(html, replacement);
    expect(replaced.match(/data-nodex-clipboard-write-claim=/gu)).toHaveLength(1);
    expect(readNodexClipboardWriteClaim(replaced)).toBe(replacement);
  });

  test("claims ordinary presentation without marking it as structural fallback", () => {
    const html = attachNodexClipboardWriteClaim("<p>Portable</p>", writeClaim);
    const inspected = inspectNodexClipboardHtml(html);

    expect(inspected.writeClaim).toBe(writeClaim);
    expect(inspected.hasStructuralFallback).toBe(false);
    expect(inspected.fallbackHtml).toContain("<p>Portable</p>");
  });

  test("replaces an existing marker instead of emitting ambiguous capabilities", () => {
    const stale = encodeNodexClipboardEnvelope({ ...envelope, capability: "c".repeat(64) });
    const html = attachNodexClipboardEnvelope(`${stale}<p>Shareable fallback</p>`, envelope);

    expect(html.match(/nodex-clipboard-envelope-v1/gu)).toHaveLength(1);
    expect(inspectNodexClipboardHtml(html).envelope).toEqual(envelope);
  });

  test("strips malformed or non-canonical markers without promoting them", () => {
    const malformed =
      '<meta name="nodex-clipboard-envelope-v1" content="not+base64"><p>Fallback</p>';

    const inspected = inspectNodexClipboardHtml(malformed);

    expect(inspected.envelope).toBeNull();
    expect(inspected.fallbackHtml).toContain("<p>Fallback</p>");
    expect(inspected.fallbackHtml).not.toContain("nodex-clipboard-envelope-v1");
  });

  test("rejects payloads with unrecognized authority fields", () => {
    const encoded = btoa(JSON.stringify({ ...envelope, preserveIdentity: true }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    const html = `<meta name="nodex-clipboard-envelope-v1" content="${encoded}">`;

    expect(inspectNodexClipboardHtml(html).envelope).toBeNull();
  });
});
