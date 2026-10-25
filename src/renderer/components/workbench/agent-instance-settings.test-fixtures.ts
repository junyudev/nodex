import { act, fireEvent, type RenderResult } from "@testing-library/react";
import type { NodexSettingsDisclosureState } from "../ui/settings";

/** An Agent section rendered open, as when Settings lands on it. */
export const openSection: NodexSettingsDisclosureState = { open: true, onOpenChange: () => {} };

export async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

export async function change(element: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(element, { target: { value } });
    await Promise.resolve();
  });
}

/** Opens a collapsed profile row by the profile's name. */
export async function expandProfile(view: Pick<RenderResult, "findByRole">, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await click(
    await view.findByRole("button", { name: new RegExp(`^${escaped}`), expanded: false }),
  );
}

export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
