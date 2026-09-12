import { expect, test } from "vitest";
import {
  CodexChunkedArray,
  codexTransportValue,
  copyCodexTransportMetadata,
  getCodexSourceLineBytes,
  markCodexChunkedJson,
  materializeCodexJson,
  setCodexSourceLineBytes,
} from "./transport-values.ts";

test.each(["object", "array", "segmented array"])(
  "materializing a %s preserves physical identity and bytes for later window delivery",
  (shape) => {
    const values = [{ text: "first" }, { text: "last" }];
    const segmented = new CodexChunkedArray([[values[0]], [values[1]]], 2);
    const raw =
      shape === "object" ? { data: segmented } : shape === "array" ? [segmented] : segmented;
    const expected = shape === "object" ? { data: values } : shape === "array" ? [values] : values;
    markCodexChunkedJson({ result: raw });
    setCodexSourceLineBytes(raw, 5 * 1024 * 1024);
    const internal = materializeCodexJson(raw);
    expect(internal).toEqual(expected);
    expect(internal).not.toBe(raw);
    expect(codexTransportValue(internal)).toBe(raw);
    expect(getCodexSourceLineBytes(internal as object)).toBe(5 * 1024 * 1024);
    const decoded = structuredClone(internal);
    copyCodexTransportMetadata(internal, decoded);
    expect(codexTransportValue(decoded)).toBe(raw);
    expect(getCodexSourceLineBytes(decoded as object)).toBe(5 * 1024 * 1024);
  },
);

test("plain values retain identity and own prototype keys remain data", () => {
  const plain = { data: ["ordinary"] };
  expect(materializeCodexJson(plain)).toBe(plain);
  const raw = {
    result: { ...JSON.parse('{"__proto__":{"safe":true}}'), data: new CodexChunkedArray([[1]], 1) },
  };
  markCodexChunkedJson(raw);
  const internal = materializeCodexJson(raw.result) as object;
  expect(Object.getPrototypeOf(internal)).toBe(Object.prototype);
  expect(Object.hasOwn(internal, "__proto__")).toBe(true);
  expect(internal).toEqual({ ...JSON.parse('{"__proto__":{"safe":true}}'), data: [1] });
});
