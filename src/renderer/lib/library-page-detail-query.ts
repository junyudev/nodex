import { queryOptions } from "@tanstack/react-query";

import type { PageDetailError } from "../../shared/page-detail";
import { readLibraryPageDetail } from "./api";
import { queryKeys } from "./query-keys";

export class LibraryPageDetailReadError extends Error {
  constructor(readonly failure: PageDetailError) {
    super(failure.message);
  }
}

export const libraryPageDetailQueryOptions = (pageId: string) =>
  queryOptions({
    queryKey: queryKeys.library.pageDetail(pageId),
    queryFn: async () => {
      const result = await readLibraryPageDetail(pageId);
      if (!result.ok) throw new LibraryPageDetailReadError(result.error);
      return result.value;
    },
  });
