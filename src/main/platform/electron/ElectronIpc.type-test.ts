import type {
  ElectronIpcControlHandler,
  ElectronIpcLocalCommitCommandHandler,
  ElectronIpcPlainCommandHandler,
  ElectronIpcQueryHandler,
  ElectronIpcRevisionedCommandHandler,
} from "./ElectronIpc";

type ProjectListQueryHandler = ElectronIpcQueryHandler<"projects:list">;
type ProjectUpdateCommandHandler = ElectronIpcLocalCommitCommandHandler<"projects:update">;
type PersistedAtomCommandHandler = ElectronIpcRevisionedCommandHandler<"persisted-atom:update">;
type DocumentPreparationCommandHandler =
  ElectronIpcPlainCommandHandler<"block-document:owned:prepare">;
type ProjectionSubscriptionControlHandler =
  ElectronIpcControlHandler<"local-commit-audience:subscribe">;

// @ts-expect-error handler results must remain compatible with the selected endpoint contract
type InvalidProjectListResult = ElectronIpcQueryHandler<"projects:list", string>;

// @ts-expect-error command channels cannot register through the query helper
type CommandAsQuery = ElectronIpcQueryHandler<"projects:update">;
// @ts-expect-error query channels cannot register through a plain command helper
type QueryAsPlainCommand = ElectronIpcPlainCommandHandler<"projects:list">;
// @ts-expect-error revisioned commands cannot register as LocalCommit commands
type RevisionAsLocalCommit = ElectronIpcLocalCommitCommandHandler<"persisted-atom:update">;
type PendingOperationAsLocalCommit =
  ElectronIpcLocalCommitCommandHandler<// @ts-expect-error pending Core operations without commit evidence cannot register as LocalCommit
  "block-document:owned:prepare">;
// @ts-expect-error LocalCommit commands cannot register as revisioned commands
type LocalCommitAsRevision = ElectronIpcRevisionedCommandHandler<"projects:update">;

export type ElectronIpcHandlerTypeFixtures =
  | CommandAsQuery
  | DocumentPreparationCommandHandler
  | InvalidProjectListResult
  | LocalCommitAsRevision
  | PendingOperationAsLocalCommit
  | ProjectListQueryHandler
  | ProjectUpdateCommandHandler
  | ProjectionSubscriptionControlHandler
  | QueryAsPlainCommand
  | RevisionAsLocalCommit
  | PersistedAtomCommandHandler;
