import type { Page, TestInfo } from "@playwright/test";

/** Capture a failed initial send without changing successful-path timing or retrying input. */
export async function attachComposerFailureEvidence(page: Page, testInfo: TestInfo): Promise<void> {
  if (page.isClosed()) return;
  try {
    const state = await page.evaluate(async () => ({
      body: document.body.innerText,
      composers: [...document.querySelectorAll("[data-codex-composer]")].map((element) => ({
        text: element.textContent,
        label: element.getAttribute("aria-label"),
        editable: element.getAttribute("contenteditable"),
      })),
      sendButtons: [...document.querySelectorAll('button[aria-label="Send prompt"]')].map(
        (element) => ({
          disabled: element.hasAttribute("disabled"),
        }),
      ),
      persisted: await window.api?.invoke("persisted-atom:sync-request"),
      windowSession: await window.api?.invoke("window-sessions:bootstrap"),
    }));
    await testInfo.attach("initial-composer-state.json", {
      body: JSON.stringify(state, null, 2),
      contentType: "application/json",
    });
    await page.screenshot({ path: testInfo.outputPath("initial-composer-failure.png") });
  } catch (error) {
    await testInfo.attach("initial-composer-evidence-error.txt", {
      body: String(error),
      contentType: "text/plain",
    });
  }
}
