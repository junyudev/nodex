import { useState, type ReactNode } from "react";
import type {
  AgentEnvironmentInput,
  AgentEnvironmentVariable,
} from "../../../shared/agent-environment";
import {
  environmentDraftInput,
  validateEnvironmentDraft,
  type AgentEnvironmentDraft,
  type AgentEnvironmentPolicy,
} from "../../lib/agent-environment-editor";
import { useSettingsRead } from "../../lib/use-settings-read";
import { AgentEnvironmentEditor } from "./agent-environment-editor";
import { NodexButton, NodexSwitch } from "../ui/button";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";
import {
  NodexSettingsAddRow,
  NodexSettingsExpandableRow,
  NodexSettingsRow,
  NodexSettingsSection,
  type NodexSettingsDisclosureState,
} from "../ui/settings";

interface AgentInstanceFields {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly environment: AgentEnvironmentVariable[];
}

type InstanceInput<Instance extends AgentInstanceFields> = Omit<Instance, "environment"> & {
  readonly environment: AgentEnvironmentInput[];
};

export interface AgentInstanceSettingsRuntime<Instance extends AgentInstanceFields> {
  readonly read: () => Promise<{ readonly instances: Instance[] }>;
  readonly update: (input: { readonly instances: InstanceInput<Instance>[] }) => Promise<{
    readonly instances: Instance[];
  }>;
}

const PROFILE_LIMIT = 32;
const fieldClassName = "h-8 w-[min(28rem,45vw)] text-sm";

interface ProfileDraft<Instance> {
  readonly instance: Instance;
  readonly environment: AgentEnvironmentDraft[];
}

const without = <Value,>(record: Readonly<Record<string, Value>>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));

const environmentRows = (environment: readonly AgentEnvironmentVariable[]) =>
  environment.map((variable) => ({ ...variable, id: crypto.randomUUID() }));

const sameEnvironment = (
  left: readonly AgentEnvironmentDraft[],
  right: readonly AgentEnvironmentDraft[],
) =>
  left.length === right.length &&
  left.every(
    (row, index) =>
      row.name === right[index]?.name &&
      row.value === right[index]?.value &&
      row.sensitive === right[index]?.sensitive,
  );

const sameInstance = <Instance extends AgentInstanceFields>(left: Instance, right: Instance) =>
  JSON.stringify({ ...left, environment: [] }) === JSON.stringify({ ...right, environment: [] });

const failureMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

type PersistOutcome = "saved" | "superseded" | { readonly failure: string };

/** Each runtime is its own store, so a different runtime starts the control afresh. */
const runtimeKeys = new WeakMap<object, number>();
let nextRuntimeKey = 0;
function runtimeKey(runtime: object) {
  let key = runtimeKeys.get(runtime);
  if (key === undefined) {
    nextRuntimeKey += 1;
    key = nextRuntimeKey;
    runtimeKeys.set(runtime, key);
  }
  return key;
}

/** A new profile takes the Agent's own name first, then a numbered one that is still free. */
function nextProfileName(label: string, names: readonly string[]) {
  if (!names.includes(label)) return label;
  let index = 2;
  while (names.includes(`${label} ${index}`)) index += 1;
  return `${label} ${index}`;
}

/** A profile row's environment note; none when the profile sets no variables. */
export const environmentVariableCount = (count: number) =>
  count === 0 ? null : count === 1 ? "1 variable" : `${count} variables`;

/** What the collapsed section says about the saved profiles. */
export function agentProfilesSummary(
  profiles: readonly Pick<AgentInstanceFields, "enabled">[] | null,
): string | null {
  if (!profiles) return null;
  if (profiles.length === 0) return "Not set up";
  const enabled = profiles.filter((profile) => profile.enabled).length;
  if (profiles.length === 1) return enabled ? "On" : "Off";
  return enabled === 0
    ? `${profiles.length} profiles · Off`
    : `${enabled} of ${profiles.length} on`;
}

type AgentInstanceSettingsControlProps<Instance extends AgentInstanceFields> = {
  readonly open: boolean;
  /** The section's anchor. */
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly description: string;
  /** Explains what a profile chooses, shown while there are none. */
  readonly setupDescription: string;
  readonly disclosure: NodexSettingsDisclosureState;
  readonly executablePlaceholder: string;
  readonly executableDescription: string;
  readonly runtime: AgentInstanceSettingsRuntime<Instance>;
  readonly createInstance: () => Instance;
  readonly environmentPolicy: AgentEnvironmentPolicy;
  readonly environmentSuggestions: readonly string[];
  /** The collapsed row's secondary line. */
  readonly profileDetail: (instance: Instance) => string;
  readonly fields: (input: {
    readonly draft: Instance;
    readonly disabled: boolean;
    readonly change: (patch: Partial<Instance>) => void;
  }) => ReactNode;
  /**
   * Describes the saved executable; `saved` is null until the profile is saved. The draft's
   * environment rows are edited apart from `draft` and arrive as `environment`.
   */
  readonly executableStatus?: (input: {
    readonly saved: Instance | null;
    readonly draft: Instance;
    readonly environment: readonly AgentEnvironmentDraft[];
  }) => ReactNode;
};

/**
 * Settings > Agents for an Agent run from local profiles. Each saved profile is a row with its
 * on/off switch, which applies immediately; its configuration opens in place and saves on its
 * own. Saving one profile re-sends every other saved profile unchanged, keeping their stored
 * secrets.
 */
export function AgentInstanceSettingsControl<Instance extends AgentInstanceFields>(
  props: AgentInstanceSettingsControlProps<Instance>,
) {
  return <AgentProfiles key={runtimeKey(props.runtime)} {...props} />;
}

function AgentProfiles<Instance extends AgentInstanceFields>({
  open,
  id,
  label,
  icon,
  description,
  setupDescription,
  disclosure,
  executablePlaceholder,
  executableDescription,
  runtime,
  createInstance,
  environmentPolicy,
  environmentSuggestions,
  profileDetail,
  fields,
  executableStatus,
}: AgentInstanceSettingsControlProps<Instance>) {
  const [saved, setSaved] = useState<readonly Instance[] | null>(null);
  const [savedEnvironments, setSavedEnvironments] = useState<
    Record<string, AgentEnvironmentDraft[]>
  >({});
  const [drafts, setDrafts] = useState<Record<string, ProfileDraft<Instance>>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** A saved profile's switch while its new state is being saved. */
  const [toggling, setToggling] = useState<{
    readonly id: string;
    readonly enabled: boolean;
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const accept = (next: readonly Instance[]) => {
    setSaved(next);
    setSavedEnvironments(
      Object.fromEntries(next.map((entry) => [entry.id, environmentRows(entry.environment)])),
    );
  };
  const {
    reading,
    error: loadError,
    retry,
    serialize,
  } = useSettingsRead(
    open,
    () => runtime.read(),
    (next) => accept(next.instances),
  );

  const savedProfiles = saved ?? [];
  const unsaved = Object.values(drafts)
    .map(({ instance }) => instance)
    .filter((instance) => !savedProfiles.some(({ id: savedId }) => savedId === instance.id));
  const profiles = [...savedProfiles, ...unsaved];
  const savedEntry = (profileId: string) =>
    savedProfiles.find((entry) => entry.id === profileId) ?? null;
  /** A saved profile's on/off state is never a draft edit: it is whatever Main last saved. */
  const current = (profileId: string): ProfileDraft<Instance> | null => {
    const draft = drafts[profileId];
    const entry = savedEntry(profileId);
    if (!entry) return draft ?? null;
    return draft
      ? { ...draft, instance: { ...draft.instance, enabled: entry.enabled } }
      : { instance: entry, environment: savedEnvironments[profileId] ?? [] };
  };
  const enabledOf = (profileId: string) =>
    toggling?.id === profileId ? toggling.enabled : (current(profileId)?.instance.enabled ?? false);
  const changed = (profileId: string) => {
    if (!drafts[profileId]) return false;
    const draft = current(profileId);
    const entry = savedEntry(profileId);
    return (
      !entry ||
      !draft ||
      !sameInstance(draft.instance, entry) ||
      !sameEnvironment(draft.environment, savedEnvironments[profileId] ?? [])
    );
  };
  const editable = saved !== null && !reading && loadError === null && busy === null;

  const setError = (profileId: string, message: string | null) =>
    setErrors((currentErrors) =>
      message ? { ...currentErrors, [profileId]: message } : without(currentErrors, profileId),
    );
  const dropDraft = (profileId: string) =>
    setDrafts((currentDrafts) => without(currentDrafts, profileId));
  const edit = (profileId: string, patch: Partial<ProfileDraft<Instance>>) => {
    const base = current(profileId);
    if (!base) return;
    setError(profileId, null);
    setDrafts((currentDrafts) => ({ ...currentDrafts, [profileId]: { ...base, ...patch } }));
  };

  /**
   * Saves the given profile list from the current snapshot. Every profile except `replace` keeps
   * its saved environment. Only one save runs at a time, and never during a refresh.
   */
  const persist = async (
    profileId: string,
    next: readonly Instance[],
    replace?: ProfileDraft<Instance>,
  ): Promise<PersistOutcome> => {
    if (!editable) return "superseded";
    const instances = next.map((entry) => ({
      ...entry,
      environment: environmentDraftInput(
        entry.id === replace?.instance.id
          ? replace.environment
          : (savedEnvironments[entry.id] ?? []),
        environmentPolicy,
      ),
    }));
    setBusy(profileId);
    setError(profileId, null);
    try {
      const result = await serialize(() => runtime.update({ instances }));
      accept(result.instances);
      return "saved";
    } catch (cause) {
      return { failure: failureMessage(cause) };
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = (profileId: string, enabled: boolean) => {
    const draft = drafts[profileId];
    if (!savedEntry(profileId)) {
      if (draft) edit(profileId, { instance: { ...draft.instance, enabled } });
      return;
    }
    setToggling({ id: profileId, enabled });
    void persist(
      profileId,
      savedProfiles.map((entry) => (entry.id === profileId ? { ...entry, enabled } : entry)),
    ).then((outcome) => {
      setToggling(null);
      if (typeof outcome === "object") toast.danger(outcome.failure);
    });
  };
  const save = async (profileId: string) => {
    const draft = current(profileId);
    if (!drafts[profileId] || !draft) return;
    const validation = validateEnvironmentDraft(draft.environment, environmentPolicy);
    if (validation) {
      setError(profileId, validation);
      return;
    }
    const outcome = await persist(
      profileId,
      savedEntry(profileId)
        ? savedProfiles.map((profile) => (profile.id === profileId ? draft.instance : profile))
        : [...savedProfiles, draft.instance],
      draft,
    );
    if (typeof outcome === "object") setError(profileId, outcome.failure);
    else if (outcome === "saved") dropDraft(profileId);
  };
  const remove = async (profileId: string) => {
    setConfirmRemove(null);
    if (savedEntry(profileId)) {
      const outcome = await persist(
        profileId,
        savedProfiles.filter((entry) => entry.id !== profileId),
      );
      if (typeof outcome === "object") setError(profileId, outcome.failure);
      if (outcome !== "saved") return;
    }
    dropDraft(profileId);
    if (expanded === profileId) setExpanded(null);
  };
  const add = () => {
    const instance = {
      ...createInstance(),
      displayName: nextProfileName(
        label,
        profiles.map((profile) => profile.displayName),
      ),
    };
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [instance.id]: { instance, environment: [] },
    }));
    setExpanded(instance.id);
  };

  const profileEditor = (profileId: string) => {
    const draft = current(profileId);
    if (!draft) return null;
    const { instance } = draft;
    const entry = savedEntry(profileId);
    const isChanged = changed(profileId);
    const disabled = !editable;
    const error = errors[profileId];
    const change = (patch: Partial<Instance>) =>
      edit(profileId, { instance: { ...instance, ...patch } });
    return (
      <>
        <NodexSettingsRow variant="nested" label="Name">
          <Input
            aria-label={`${label} profile name`}
            className={fieldClassName}
            value={instance.displayName}
            disabled={disabled}
            onChange={(event) => change({ displayName: event.target.value } as Partial<Instance>)}
          />
        </NodexSettingsRow>
        <NodexSettingsRow
          variant="nested"
          label="Executable"
          description={
            executableStatus?.({
              saved: entry,
              draft: instance,
              environment: draft.environment,
            }) || executableDescription
          }
        >
          <Input
            aria-label={`${label} executable`}
            className={fieldClassName}
            value={instance.binaryPath}
            disabled={disabled}
            placeholder={executablePlaceholder}
            spellCheck={false}
            onChange={(event) => change({ binaryPath: event.target.value } as Partial<Instance>)}
          />
        </NodexSettingsRow>
        {fields({ draft: instance, disabled, change })}
        <AgentEnvironmentEditor
          rows={draft.environment}
          disabled={disabled}
          policy={environmentPolicy}
          suggestedNames={environmentSuggestions}
          onChange={(environment) => edit(profileId, { environment })}
        />
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          {confirmRemove === profileId ? (
            <>
              <span className="text-sm">Remove {instance.displayName || "this profile"}?</span>
              <NodexButton
                size="sm"
                variant="destructive"
                disabled={disabled}
                onClick={() => void remove(profileId)}
              >
                Remove
              </NodexButton>
              <NodexButton
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => setConfirmRemove(null)}
              >
                Keep
              </NodexButton>
            </>
          ) : (
            <NodexButton
              size="sm"
              variant="ghost"
              className="text-danger"
              disabled={disabled}
              onClick={() => setConfirmRemove(profileId)}
            >
              Remove profile
            </NodexButton>
          )}
          <span className="min-w-0 flex-1 text-end text-xs">
            {error ? (
              <span role="alert" className="text-danger">
                {error}
              </span>
            ) : !entry ? (
              <span className="text-token-text-secondary">Not saved yet</span>
            ) : null}
          </span>
          {isChanged ? (
            <NodexButton
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                setError(profileId, null);
                if (entry) dropDraft(profileId);
                else void remove(profileId);
              }}
            >
              Discard
            </NodexButton>
          ) : null}
          <NodexButton
            size="sm"
            variant="secondary"
            disabled={
              disabled || !isChanged || !instance.binaryPath.trim() || !instance.displayName.trim()
            }
            onClick={() => void save(profileId)}
          >
            {busy === profileId ? "Saving…" : "Save"}
          </NodexButton>
        </div>
      </>
    );
  };

  return (
    <NodexSettingsSection
      id={id}
      title={label}
      icon={icon}
      description={description}
      summary={loadError ? "Couldn't load" : agentProfilesSummary(saved)}
      disclosure={disclosure}
    >
      {loadError ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-danger">
            Couldn't load {label} profiles. {loadError}
          </p>
          <NodexButton size="xs" variant="secondary" onClick={retry}>
            Try again
          </NodexButton>
        </div>
      ) : saved === null ? (
        <p role="status" className="px-4 py-3 text-xs text-token-text-secondary">
          Loading profiles…
        </p>
      ) : profiles.length === 0 ? (
        <NodexSettingsRow label={`Set up ${label}`} description={setupDescription}>
          <NodexButton size="sm" variant="secondary" onClick={add}>
            Add profile
          </NodexButton>
        </NodexSettingsRow>
      ) : (
        <>
          {profiles.map((profile) => {
            const shown = current(profile.id)?.instance ?? profile;
            const isSaved = savedEntry(profile.id) !== null;
            const isChanged = changed(profile.id);
            const error = errors[profile.id];
            return (
              <NodexSettingsExpandableRow
                key={profile.id}
                id={`${id}-profile-${profile.id}`}
                label={shown.displayName || "Untitled profile"}
                detail={profileDetail(shown)}
                expanded={expanded === profile.id}
                onExpandedChange={(next) => {
                  setConfirmRemove(null);
                  setExpanded(next ? profile.id : null);
                }}
                controls={
                  <>
                    {expanded !== profile.id && (isChanged || error) ? (
                      <span
                        className={
                          error
                            ? "max-w-[40%] truncate text-xs text-danger"
                            : "text-xs text-token-text-secondary"
                        }
                      >
                        {error ? "Couldn't save" : isSaved ? "Unsaved changes" : "Not saved yet"}
                      </span>
                    ) : null}
                    <NodexSwitch
                      size="compact"
                      ariaLabel={`${enabledOf(profile.id) ? "Turn off" : "Turn on"} ${shown.displayName || label}`}
                      checked={enabledOf(profile.id)}
                      disabled={!editable}
                      onCheckedChange={(enabled) => setEnabled(profile.id, enabled)}
                    />
                  </>
                }
              >
                {profileEditor(profile.id)}
              </NodexSettingsExpandableRow>
            );
          })}
          <NodexSettingsAddRow
            label="Add profile"
            disabled={!editable || profiles.length >= PROFILE_LIMIT}
            onClick={add}
          />
        </>
      )}
    </NodexSettingsSection>
  );
}
