import { describe, expect, test } from "bun:test";
import { shouldSuppressPreferIndentBoundaryTab } from "./prefer-indent-tab-boundary";

function makeTarget(options?: {
  insideEditor?: boolean;
  insideCodeBlock?: boolean;
  insideTable?: boolean;
}) {
  const {
    insideEditor = true,
    insideCodeBlock = false,
    insideTable = false,
  } = options ?? {};

  const target = {
    closest(selector: string) {
      if (selector === ".bn-editor") {
        return insideEditor ? target : null;
      }

      if (
        selector.includes('[data-content-type="codeBlock"]')
        || selector.includes('[data-content-type="table"]')
      ) {
        return insideCodeBlock || insideTable ? target : null;
      }

      return null;
    },
  };

  return target;
}

describe("shouldSuppressPreferIndentBoundaryTab", () => {
  test("suppresses Tab when nesting would be a boundary no-op inside editor content", () => {
    const suppressed = shouldSuppressPreferIndentBoundaryTab(
      {
        canNestBlock: () => false,
        canUnnestBlock: () => true,
      },
      makeTarget(),
      false,
    );

    expect(suppressed).toBeTrue();
  });

  test("suppresses Shift-Tab when unnesting would be a boundary no-op inside editor content", () => {
    const suppressed = shouldSuppressPreferIndentBoundaryTab(
      {
        canNestBlock: () => true,
        canUnnestBlock: () => false,
      },
      makeTarget(),
      true,
    );

    expect(suppressed).toBeTrue();
  });

  test("does not suppress when the editor can still change nesting", () => {
    const suppressed = shouldSuppressPreferIndentBoundaryTab(
      {
        canNestBlock: () => true,
        canUnnestBlock: () => true,
      },
      makeTarget(),
      false,
    );

    expect(suppressed).toBeFalse();
  });

  test("does not suppress for hover chrome outside the editor content node", () => {
    const suppressed = shouldSuppressPreferIndentBoundaryTab(
      {
        canNestBlock: () => false,
        canUnnestBlock: () => false,
      },
      makeTarget({ insideEditor: false }),
      false,
    );

    expect(suppressed).toBeFalse();
  });

  test("does not suppress inside code blocks or tables where Tab has specialized behavior", () => {
    const insideCodeBlock = shouldSuppressPreferIndentBoundaryTab(
      {
        canNestBlock: () => false,
        canUnnestBlock: () => false,
      },
      makeTarget({ insideCodeBlock: true }),
      false,
    );
    const insideTable = shouldSuppressPreferIndentBoundaryTab(
      {
        canNestBlock: () => false,
        canUnnestBlock: () => false,
      },
      makeTarget({ insideTable: true }),
      false,
    );

    expect(insideCodeBlock).toBeFalse();
    expect(insideTable).toBeFalse();
  });
});
