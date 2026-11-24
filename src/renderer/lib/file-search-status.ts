import type { IntlShape } from "@/lib/i18n";
import type { FileSearchIncomplete } from "../../shared/file-search";
import { basename } from "./file-path";

/** Explains, in one line, why a settled file search did not cover every file. */
export function describeFileSearchIncomplete(
  intl: IntlShape,
  incomplete: FileSearchIncomplete,
): string {
  const folder = incomplete.root === undefined ? null : basename(incomplete.root);
  if (folder === null || incomplete.reason === "unavailable")
    return intl.formatMessage({
      id: "lib.fileSearchStatus.unavailable",
      defaultMessage: "Couldn’t search files",
    });
  switch (incomplete.reason) {
    case "too-large":
      return intl.formatMessage(
        {
          id: "lib.fileSearchStatus.tooLarge",
          defaultMessage: "“{folder}” is too large to search completely",
        },
        { folder },
      );
    case "missing":
      return intl.formatMessage(
        { id: "lib.fileSearchStatus.missing", defaultMessage: "“{folder}” no longer exists" },
        { folder },
      );
    case "unreadable":
      return intl.formatMessage(
        {
          id: "lib.fileSearchStatus.unreadable",
          defaultMessage: "Nodex doesn’t have permission to read “{folder}”",
        },
        { folder },
      );
  }
}
