import type { VisualRenderFrame } from "../shared/visual/bridge";
import { isVisualScalar } from "../shared/visual/contract";
import { measureVisual } from "./geometry";
import { snapshotVisual } from "./svg-snapshot";

const container = document.getElementById("visual") as HTMLElement;

function readToken(value: string): Omit<VisualRenderFrame["datum"][number], "rect"> | undefined {
  if (value.length > 4096) return undefined;
  try {
    const token: unknown = JSON.parse(value);
    if (!Array.isArray(token)) return undefined;
    const [figure, source, key, field] = token;
    if (
      typeof figure !== "number" ||
      typeof source !== "string" ||
      !(isVisualScalar(key) || (Array.isArray(key) && key.every(isVisualScalar))) ||
      !(field === null || typeof field === "string")
    )
      return undefined;
    return { figure, source, key, field: field ?? undefined };
  } catch {
    return undefined;
  }
}

function measure(revision: number): VisualRenderFrame {
  const dimensions = measureVisual(container, readToken);
  return {
    revision,
    ...dimensions,
    svg: snapshotVisual(container, dimensions.width, dimensions.height),
  };
}

Object.defineProperty(globalThis, "measureNodexVisual", { value: measure });
