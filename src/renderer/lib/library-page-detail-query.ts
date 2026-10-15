import { queryOptions } from "@tanstack/react-query";

import { readLibraryPageDetail } from "./api";
import { queryKeys } from "./query-keys";

export const libraryPageDetailQueryOptions = (pageId: string) =>
  queryOptions({
    queryKey: queryKeys.library.pageDetail(pageId),
    queryFn: async () => {
      const result = await readLibraryPageDetail(pageId);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
  });
