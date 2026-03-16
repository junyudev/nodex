import { expect, test } from "bun:test";
import {
  getSideMenuSelectionGuardFloatingOptions,
  shouldArmSideMenuSelectionGuard,
} from "./side-menu-selection-guard";

class FakeElement {
  private readonly matches = new Set<string>();
  parentElement: FakeElement | null = null;

  constructor(...selectors: string[]) {
    for (const selector of selectors) {
      this.matches.add(selector);
    }
  }

  appendChild(child: FakeElement): void {
    child.parentElement = this;
  }

  closest(selector: string): FakeElement | null {
    if (this.matches.has(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
}

class FakeTextTarget {
  constructor(readonly parentElement: FakeElement | null) {}
}

test("arms the side menu selection guard for primary-button presses in ProseMirror content", () => {
  const proseMirror = new FakeElement(".ProseMirror");
  const textNode = new FakeElement();
  proseMirror.appendChild(textNode);

  expect(shouldArmSideMenuSelectionGuard(textNode as unknown as EventTarget, 0)).toBeTrue();
});

test("does not arm the side menu selection guard for non-primary mouse buttons", () => {
  const proseMirror = new FakeElement(".ProseMirror");
  const textNode = new FakeElement();
  proseMirror.appendChild(textNode);

  expect(shouldArmSideMenuSelectionGuard(textNode as unknown as EventTarget, 2)).toBeFalse();
});

test("does not arm the side menu selection guard for targets outside ProseMirror content", () => {
  const outsideTarget = new FakeElement();

  expect(shouldArmSideMenuSelectionGuard(outsideTarget as unknown as EventTarget, 0)).toBeFalse();
});

test("does not arm the side menu selection guard when the press starts on the side menu", () => {
  const proseMirror = new FakeElement(".ProseMirror");
  const sideMenu = new FakeElement(".bn-side-menu");
  const button = new FakeElement();

  proseMirror.appendChild(sideMenu);
  sideMenu.appendChild(button);

  expect(shouldArmSideMenuSelectionGuard(button as unknown as EventTarget, 0)).toBeFalse();
});

test("arms the side menu selection guard for text-node-like targets inside ProseMirror", () => {
  const proseMirror = new FakeElement(".ProseMirror");
  const textNode = new FakeTextTarget(proseMirror);

  expect(shouldArmSideMenuSelectionGuard(textNode as unknown as EventTarget, 0)).toBeTrue();
});

test("returns non-hit-testable floating options while the guard is active", () => {
  const floatingOptions = getSideMenuSelectionGuardFloatingOptions(true);
  const style = floatingOptions?.elementProps?.style as
    | { pointerEvents?: unknown; visibility?: unknown }
    | undefined;

  expect(floatingOptions?.elementProps?.className).toBe("bn-side-menu-selection-guard-overlay");
  expect(style?.pointerEvents).toBe("none");
  expect(style?.visibility).toBe(undefined);
});

test("does not override floating options while the guard is inactive", () => {
  expect(getSideMenuSelectionGuardFloatingOptions(false) === undefined).toBeTrue();
});
