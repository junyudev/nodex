import { describe, expect, test } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { PromptImage } from "./PromptImage.ts";

const decode = Schema.decodeUnknownSync(Schema.Array(PromptImage));

describe("structured generation prompt images", () => {
  test("preserves image order and bytes for all supported media types", () => {
    const images = ["image/png", "image/jpeg", "image/gif", "image/webp"].map(
      (mediaType, index) => ({
        mediaType,
        data: Buffer.from([index]).toString("base64"),
      }),
    );
    expect(decode(images)).toEqual(images);
    expect(decode([])).toEqual([]);
  });

  test.each([
    { mediaType: "image/svg+xml", data: "AQID" },
    { mediaType: "image/png", data: "" },
    { mediaType: "image/png", data: "data:image/png;base64,AQID" },
    { mediaType: "image/png", data: "not base64" },
  ])("rejects unsupported media or invalid bytes: %j", (image) => {
    expect(() => decode([image])).toThrow();
  });
});
