import { describe, expect, test } from "bun:test";
import { collectSelectedImageBlockDecorationRanges } from "./selected-image-block-decorations";

describe("selected image block decorations", () => {
  test("collects top-level image block container ranges in selection span", () => {
    const ranges = collectSelectedImageBlockDecorationRanges(
      {
        nodesBetween: (_from, _to, callback) => {
          callback(
            {
              type: { name: "blockContainer" },
              firstChild: { type: { name: "paragraph" } },
              nodeSize: 8,
            },
            1,
          );
          callback(
            {
              type: { name: "blockContainer" },
              firstChild: { type: { name: "image" } },
              nodeSize: 6,
            },
            9,
          );
          callback(
            {
              type: { name: "blockContainer" },
              firstChild: { type: { name: "image" } },
              nodeSize: 12,
            },
            15,
          );
        },
      },
      { empty: false, from: 3, to: 40 },
    );

    expect(JSON.stringify(ranges)).toBe(
      JSON.stringify([
        { from: 9, to: 15 },
        { from: 15, to: 27 },
      ]),
    );
  });

  test("returns no ranges for empty selection", () => {
    const ranges = collectSelectedImageBlockDecorationRanges(
      {
        nodesBetween: () => {
          throw new Error("should not be called");
        },
      },
      { empty: true, from: 5, to: 20 },
    );
    expect(ranges.length).toBe(0);
  });

  test("de-dupes identical positions and ignores invalid image candidates", () => {
    const ranges = collectSelectedImageBlockDecorationRanges(
      {
        nodesBetween: (_from, _to, callback) => {
          callback(
            {
              type: { name: "blockContainer" },
              firstChild: { type: { name: "image" } },
              nodeSize: 0,
            },
            11,
          );
          callback(
            {
              type: { name: "blockContainer" },
              firstChild: { type: { name: "image" } },
              nodeSize: 10,
            },
            11,
          );
          callback(
            {
              type: { name: "blockContainer" },
              firstChild: { type: { name: "image" } },
              nodeSize: 10,
            },
            11,
          );
        },
      },
      { empty: false, from: 1, to: 30 },
    );

    expect(JSON.stringify(ranges)).toBe(
      JSON.stringify([{ from: 11, to: 21 }]),
    );
  });
});
