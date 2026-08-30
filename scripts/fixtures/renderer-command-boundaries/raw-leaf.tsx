import { invoke as rawInvoke } from "../../../lib/api";

export const RenameFromLeaf = ({ projectId }: { readonly projectId: string }) => (
  <button onClick={() => rawInvoke("projects:update", projectId, { name: "Renamed" })}>
    Rename
  </button>
);
