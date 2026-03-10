import { expect, test } from "bun:test";
import { shouldArmSideMenuSelectionGuard } from "./side-menu-selection-guard";

class FakeElement {
  private readonly matches = new Set<string>();
  private parent: FakeElement | null = null;

  constructor(...selectors: string[]) {
    for (const selector of selectors) {
      this.matches.add(selector);
    }
  }

  appendChild(child: FakeElement): void {
    child.parent = this;
  }

  closest(selector: string): FakeElement | null {
    if (this.matches.has(selector)) return this;
    return this.parent?.closest(selector) ?? null;
  }
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
