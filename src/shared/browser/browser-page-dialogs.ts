/**
 * A dialog a Browser page opened with `alert()` or `confirm()`.
 *
 * The page's script is stopped until the dialog is answered, and so is any navigation of that
 * page. Main owns the pending answer; the tab snapshot carries what a person needs to give it.
 * An Agent that controls the page answers the same dialog through its own Browser tools, and
 * whichever answer arrives first settles it.
 */
export interface BrowserPageDialog {
  id: string;
  kind: "alert" | "confirm";
  /** Origin of the frame that opened the dialog. */
  origin: string;
  /** The page's origin, when a frame from another origin opened the dialog. */
  embeddingOrigin?: string;
  message: string;
  /** This page has opened a dialog before, so the person may stop it from opening more. */
  canSuppress: boolean;
}
