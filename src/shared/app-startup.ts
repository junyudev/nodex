export type AppInitializationStep =
  | { phase: "app_waiting" }
  | { phase: "sqlite_waiting" }
  | { phase: "done" };

export type DatabaseMigrationProgress =
  | { type: "InProgress"; value: number }
  | { type: "Done" };
