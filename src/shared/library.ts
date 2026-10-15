export const INITIAL_DATA_SOURCE_SUFFIX = ":data-source:initial" as const;

export const initialDataSourceId = (databaseId: string): string => {
  const canonicalDatabaseId = databaseId.trim();
  if (!canonicalDatabaseId) {
    throw new TypeError("databaseId must be a non-empty identity");
  }
  return `${canonicalDatabaseId}${INITIAL_DATA_SOURCE_SUFFIX}`;
};

export type ProjectLifecycle = "active" | "inactive" | "archived";

export interface LocalProfileLibrary {
  readonly profileId: string;
  readonly libraryId: string;
}
