import { queryOptions, useQuery } from "@tanstack/react-query";
import { readLibraryModule } from "./api";

export const membersQueryOptions = () =>
  queryOptions({
    staleTime: Infinity,
    queryFn: async () => {
      const result = await readLibraryModule({ kind: "library" }, { read: { mode: "members" } });
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.value.kind !== "members")
        throw new Error("Library returned a non-Members read");
      return result.value.value.items;
    },
  });
export const useMembers = () => useQuery(membersQueryOptions());

export const useLocalMember = () =>
  useQuery({
    staleTime: Infinity,
    queryFn: async () => {
      const result = await readLibraryModule(
        { kind: "library" },
        { read: { mode: "local_member" } },
      );
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.value.kind !== "local_member") throw new Error("Invalid local Member");
      return result.value.value.value;
    },
  });
