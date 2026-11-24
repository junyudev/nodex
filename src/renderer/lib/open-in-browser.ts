import { toastFailure } from "./failure-toast";
import { openExternalUrl } from "./file-system-operations";

/**
 * Opens a web page in the system browser, which hands links such as Discord invites to their app,
 * and tells the person with `failureTitle` when it could not.
 */
export async function openInBrowser(url: string, failureTitle: string): Promise<void> {
  try {
    if (!(await openExternalUrl(url))) toastFailure(failureTitle);
  } catch (error) {
    toastFailure(failureTitle, error);
  }
}
