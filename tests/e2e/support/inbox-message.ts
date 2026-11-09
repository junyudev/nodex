import { expect, type Locator } from "@playwright/test";

/**
 * Opens an Inbox message's Page through `Open page` on its text. The actions on the text take
 * pointer input only while the message is hovered, and a recording's action overlay can take that
 * hover away between steps without the pointer moving, so each attempt hovers the message again.
 */
export async function openInboxMessagePage(message: Locator): Promise<void> {
  const open = message
    .getByTestId("inbox-message-actions")
    .getByRole("button", { name: "Open page", exact: true });
  await expect(async () => {
    await message.getByTestId("inbox-message-unit").hover();
    await open.click({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}
