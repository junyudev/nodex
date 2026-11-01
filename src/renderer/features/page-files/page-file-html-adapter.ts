import type {
  PageFileHtmlAdmissionInput,
  PageFileHtmlAdmissionResult,
} from "../../../shared/page-file-html";
import { invokeRendererControl } from "../../lib/renderer-command";

/** The presentation owner borrows only admission/release, never a general IPC route. */
export const pageFileHtmlAdapter = {
  admit: (input: PageFileHtmlAdmissionInput): Promise<PageFileHtmlAdmissionResult> =>
    invokeRendererControl("page-file-html:admit", input),
  release: (grant: string): Promise<boolean> =>
    invokeRendererControl("page-file-html:release", { grant }),
};
