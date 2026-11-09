import { describe, expect, test } from "vitest";
import { renderableImageType } from "./renderable-image";

const bytes = (...parts: readonly (string | readonly number[])[]) =>
  Uint8Array.from(
    parts.flatMap((part) => (typeof part === "string" ? [...Buffer.from(part, "latin1")] : part)),
  );

describe("renderableImageType", () => {
  test.each([
    ["image/png", bytes([0x89], "PNG\r\n\x1a\n", [0, 0, 0, 13])],
    ["image/jpeg", bytes([0xff, 0xd8, 0xff, 0xe0])],
    ["image/gif", bytes("GIF89a")],
    ["image/gif", bytes("GIF87a")],
    ["image/webp", bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ")],
  ])("reads %s from the bytes' own signature", (type, head) => {
    expect(renderableImageType(head)).toBe(type);
  });

  test.each([
    ["SVG, which can carry script", bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
    ["HTML", bytes("<!doctype html><script>")],
    ["a RIFF that is not WebP", bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt ")],
    ["a truncated PNG signature", bytes([0x89], "PNG")],
    ["nothing", new Uint8Array()],
  ])("never draws %s as a picture", (_, head) => {
    expect(renderableImageType(head)).toBeNull();
  });
});
