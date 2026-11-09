/* @effect-diagnostics asyncFunction:off -- Real codec behavior is the Adapter contract. */
import sharp from "sharp";
import { expect, test } from "vite-plus/test";
import { fitHostImage } from "./HostImageFitting";

test("a headless Host validates image pixels and fits them to an Agent's byte budget", async () => {
  const bytes = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  expect(bytes.length).toBeGreaterThan(5000);
  const fitted = await fitHostImage({ bytes, mediaType: "image/png" }, 5000);
  expect(fitted.bytes.byteLength).toBeLessThanOrEqual(5000);
  const metadata = await sharp(fitted.bytes).metadata();
  expect(metadata.width).toBeGreaterThan(0);
  expect(metadata.width).toBeLessThanOrEqual(2048);
  await expect(
    fitHostImage({ bytes: Buffer.from("invalid image"), mediaType: "image/png" }, 5000),
  ).rejects.toThrow();
});
