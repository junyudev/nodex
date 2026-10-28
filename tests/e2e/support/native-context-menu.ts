import type { ElectronApplication } from "@playwright/test";

/**
 * Chromium cannot click an OS-native menu. Opens the next native context menu through `open`,
 * then selects its real Electron MenuItem by id through the item's installed click callback.
 * Resolves with the menu's item labels, in order, for assertions about its contents.
 */
export async function selectNativeContextMenuItem(
  application: ElectronApplication,
  itemId: string,
  open: () => Promise<void>,
): Promise<readonly string[]> {
  const selected = application.evaluate(
    ({ Menu }, id) =>
      new Promise<string[]>((resolve, reject) => {
        const original = Menu.prototype.popup;
        const timeout = setTimeout(() => {
          Menu.prototype.popup = original;
          reject(new Error(`No native context menu opened to select ${id}`));
        }, 15_000);
        Menu.prototype.popup = function (options) {
          Menu.prototype.popup = original;
          clearTimeout(timeout);
          try {
            const item = this.getMenuItemById(id);
            if (!item) throw new Error(`The native context menu has no ${id} item`);
            const labels = this.items.flatMap((entry) => (entry.label ? [entry.label] : []));
            Reflect.apply(item.click, item, [item, options?.window, {}]);
            options?.callback?.();
            resolve(labels);
          } catch (error) {
            options?.callback?.();
            reject(error);
          }
        };
      }),
    itemId,
  );
  const [labels] = await Promise.all([selected, open()]);
  return labels;
}
