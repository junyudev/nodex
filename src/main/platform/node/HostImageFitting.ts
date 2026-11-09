/* @effect-diagnostics asyncFunction:off -- Native image codec Adapter; the fitting policy is shared with the desktop. */
import sharp, { type Sharp } from "sharp";
import * as Layer from "effect/Layer";
import {
  AgentImageFitting,
  fitWithImageCodec,
  type EncodableImage,
} from "../../agent-backend/AgentImageFitting";

const encodable = (image: Sharp, width: number, height: number): EncodableImage => ({
  isEmpty: () => width <= 0 || height <= 0,
  getSize: () => ({ width, height }),
  resize: (size) =>
    encodable(image.clone().resize(size.width, size.height), size.width, size.height),
  toPNG: () => image.clone().png().toBuffer(),
  toJPEG: (quality) => image.clone().jpeg({ quality }).toBuffer(),
});

export const fitHostImage = fitWithImageCodec(async (bytes) => {
  // Decode even an under-budget image: metadata alone cannot prove the pixels are readable.
  const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000 })
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return encodable(sharp(data, { raw: info }), info.width, info.height);
});

export const live = Layer.succeed(AgentImageFitting, { fit: fitHostImage });
