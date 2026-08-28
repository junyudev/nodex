import { DatabaseIcon, OpenInIcon } from "@/components/shared/icons";
import { createReactBlockSpec } from "@blocknote/react";

import { useBlockReferenceHostRuntime } from "@/components/block-documents/block-reference-runtime-context";
import { useLibraryPath } from "@/lib/use-library-navigation";
import { databaseBlockConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { parseDatabaseId, type DatabaseId } from "../../../../shared/database-identities";

export function DatabaseBlockSurface({
  title,
  loading = false,
  onOpen,
}: {
  readonly title: string;
  readonly loading?: boolean;
  readonly onOpen?: () => void;
}) {
  return (
    <button
      type="button"
      className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm text-token-text-primary hover:bg-token-main-surface-secondary disabled:cursor-default"
      disabled={!onOpen}
      onClick={onOpen}
    >
      <DatabaseIcon className="size-4 shrink-0 text-token-description-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium">
        {loading ? "Opening database…" : title}
      </span>
      {onOpen ? (
        <OpenInIcon className="size-3.5 shrink-0 text-token-description-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      ) : null}
    </button>
  );
}

function DatabaseBlock({ databaseId }: { readonly databaseId: DatabaseId }) {
  const host = useBlockReferenceHostRuntime();
  const path = useLibraryPath({ kind: "database", databaseId });
  const database = path.data?.nodes.at(-1);
  const title = database?.kind === "database" ? database.title : "Untitled database";

  return (
    <DatabaseBlockSurface
      title={title}
      loading={path.isPending}
      {...(host?.openDatabase ? { onOpen: () => host.openDatabase?.(databaseId) } : {})}
    />
  );
}

/** An owning Database Container shell. It is distinct from a database View reference. */
export const createDatabaseBlockSpec = createReactBlockSpec(databaseBlockConfig, {
  render: ({ block }) => <DatabaseBlock databaseId={parseDatabaseId(block.id)} />,
});
