import type { IpcApi } from "./ipc-api";
import type {
  CoreLocalCommitCommandChannel,
  IpcCommand,
  IpcEndpointPolicy,
  IpcEndpointPolicyIsComplete,
  IpcOperationDefinitionMap,
  IpcQueryChannel,
  PlainResultCommandChannel,
} from "./ipc-endpoint-policy";

type TypeEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type ExpectTrue<Value extends true> = Value;

interface FixtureApi {
  readonly read: { readonly args: readonly []; readonly result: string };
  readonly write: { readonly args: readonly []; readonly result: void };
}

type CompleteFixturePolicy = ExpectTrue<IpcEndpointPolicyIsComplete<FixtureApi, "read" | "write">>;

// @ts-expect-error every endpoint requires an explicit classification
type MissingEndpointPolicy = ExpectTrue<IpcEndpointPolicyIsComplete<FixtureApi, "read">>;

type MissingLocalCommitEvidence = IpcCommand<
  readonly [],
  "core_local_commit",
  { readonly ok: true; readonly value: string }
>;

// @ts-expect-error LocalCommit commands cannot expose evidence-free success
const missingEvidenceCommand: MissingLocalCommitEvidence = {
  kind: "command",
  acknowledgement: "core_local_commit",
  args: [],
  result: { ok: true, value: "missing receipt" },
};

declare const invokeQuery: <Channel extends IpcQueryChannel>(channel: Channel) => void;
declare const invokeCoreCommand: <Channel extends CoreLocalCommitCommandChannel>(
  channel: Channel,
) => void;

invokeQuery("projects:list");
invokeCoreCommand("projects:update");
// @ts-expect-error a command cannot cross the query transport
invokeQuery("projects:update");
// @ts-expect-error a query cannot cross the LocalCommit command transport
invokeCoreCommand("projects:list");

type AggregateOperationKind = "archive" | "rename";
type AggregateDefinition = PlainResultCommandChannel;

const aggregateOperationDefinitions = {
  archive: "codex:thread:archive",
  rename: "codex:thread:name:set",
} satisfies IpcOperationDefinitionMap<AggregateOperationKind, AggregateDefinition>;

const missingAggregateOperation = {
  rename: "codex:thread:name:set",
  // @ts-expect-error aggregate operation maps cannot omit a supported operation
} satisfies IpcOperationDefinitionMap<AggregateOperationKind, AggregateDefinition>;

type PolicyCoversIpcApi = ExpectTrue<TypeEqual<keyof IpcEndpointPolicy, keyof IpcApi>>;

export type IpcEndpointPolicyTypeFixtures =
  | CompleteFixturePolicy
  | MissingEndpointPolicy
  | PolicyCoversIpcApi
  | typeof aggregateOperationDefinitions
  | typeof missingAggregateOperation
  | typeof missingEvidenceCommand;
