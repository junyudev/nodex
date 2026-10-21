import * as Layer from "effect/Layer";
import { AgentImageFitting, fitWithImageCodec } from "../../agent-backend/AgentImageFitting";

/** Electron's image codec fits images for Agents. */
export const live: Layer.Layer<AgentImageFitting> = Layer.sync(AgentImageFitting, () => {
  const { nativeImage } = require("electron") as typeof import("electron");
  return AgentImageFitting.of({
    fit: fitWithImageCodec((bytes) => nativeImage.createFromBuffer(Buffer.from(bytes))),
  });
});
