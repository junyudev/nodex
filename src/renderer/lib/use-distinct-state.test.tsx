import { useLayoutEffect } from "react";
import { act } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";

import { render, settleAsyncRender } from "@/test/dom";
import { useDistinctState, type SetDistinctState } from "./use-distinct-state";

describe("useDistinctState", () => {
  test("commits React updates only for semantic value transitions", async () => {
    let renderCount = 0;
    let value = false;
    let setValue: SetDistinctState<boolean> = () => false;
    let getValue = () => false;

    function Harness() {
      const state = useDistinctState(false);
      useLayoutEffect(() => {
        renderCount += 1;
        [value, setValue, getValue] = state;
      });
      return null;
    }

    render(<Harness />);
    await settleAsyncRender();
    const settledRenderCount = renderCount;

    act(() => {
      expect(setValue(false)).toBe(false);
      expect(setValue(false)).toBe(false);
    });
    expect(renderCount).toBe(settledRenderCount);
    expect(getValue()).toBe(false);

    act(() => {
      expect(setValue(true)).toBe(true);
      expect(setValue(true)).toBe(false);
    });
    await settleAsyncRender();

    expect(value).toBe(true);
    expect(getValue()).toBe(true);
    expect(renderCount).toBe(settledRenderCount + 1);
  });

  test("compares structured values before dispatching to React", async () => {
    let renderCount = 0;
    let value = ["session:a"];
    let setValue: SetDistinctState<string[]> = () => false;

    function Harness() {
      const state = useDistinctState(
        ["session:a"],
        (current, next) =>
          current.length === next.length && current.every((entry, index) => entry === next[index]),
      );
      useLayoutEffect(() => {
        renderCount += 1;
        [value, setValue] = state;
      });
      return null;
    }

    render(<Harness />);
    await settleAsyncRender();
    const settledRenderCount = renderCount;

    act(() => {
      expect(setValue(["session:a"])).toBe(false);
    });
    expect(renderCount).toBe(settledRenderCount);

    act(() => {
      expect(setValue(["session:b"])).toBe(true);
    });
    await settleAsyncRender();

    expect(value).toEqual(["session:b"]);
    expect(renderCount).toBe(settledRenderCount + 1);
  });
});
