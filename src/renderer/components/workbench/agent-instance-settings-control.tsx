import {
  AGENT_PROFILE_LIMIT,
  agentProfileInput,
  createAgentProfile,
  agentProfileEnvironment,
  type AgentProfile,
  type AgentProfileInput,
} from "../../../shared/agents/profiles";
import type { AgentProfileDefinition } from "../../../shared/agents/profile-definition";
import type { ProfileAgentDefinition, ProfileAgentDriver } from "../../../shared/agents/registry";
import { readAgentProfiles, updateAgentProfiles } from "../../lib/agent-profiles-runtime";
import { AgentProviderIcon } from "../shared/icons";
import { AgentProfileFieldRow, agentProfileInputClassName } from "./agent-profile-field";
import {
  agentProfileSettingsSlots,
  type EditableAgentProfile,
} from "./agent-profile-settings-slots";
import { settingsMessages } from "./workbench-settings-search-catalog";
import { getIntl, useIntl } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useState } from "react";
import type { AgentEnvironmentVariable } from "../../../shared/agent-environment";
import {
  environmentDraftInput,
  validateEnvironmentDraft,
  type AgentEnvironmentDraft,
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

export interface AgentProfileSettingsRuntime {
  readonly read: (driver: ProfileAgentDriver) => Promise<{ readonly instances: AgentProfile[] }>;
  readonly update: typeof updateAgentProfiles;
}

const desktopProfiles: AgentProfileSettingsRuntime = {
  read: readAgentProfiles,
  update: updateAgentProfiles,
};

interface ProfileDraft {
  readonly instance: EditableAgentProfile;
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

const sameInstance = (left: EditableAgentProfile, right: EditableAgentProfile) =>
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

/** What the collapsed section says about the saved profiles. */
export function agentProfilesSummary(
  profiles: readonly Pick<AgentProfile, "enabled">[] | null,
  intl = getIntl(),
): string | null {
  if (!profiles) return null;
  if (profiles.length === 0)
    return intl.formatMessage({
      id: "settings.agentProfiles.notSetUp",
      defaultMessage: "Not set up",
    });
  const enabled = profiles.filter((profile) => profile.enabled).length;
  if (profiles.length === 1)
    return enabled
      ? intl.formatMessage({ id: "settings.agentProfiles.on", defaultMessage: "On" })
      : intl.formatMessage({ id: "settings.agentProfiles.off", defaultMessage: "Off" });
  return enabled === 0
    ? intl.formatMessage(
        { id: "settings.agentProfiles.profilesOff", defaultMessage: "{length} profiles · Off" },
        { length: profiles.length },
      )
    : intl.formatMessage(
        { id: "settings.agentProfiles.ofOn", defaultMessage: "{enabled} of {length} on" },
        { enabled: enabled, length: profiles.length },
      );
}

interface AgentProfileSettingsProps {
  readonly definition: ProfileAgentDefinition;
  readonly open: boolean;
  readonly disclosure: NodexSettingsDisclosureState;
  readonly anchor?: string | null;
  readonly runtime?: AgentProfileSettingsRuntime;
}

/** A Profile's settings open in place, while its on/off switch saves immediately. */
export function AgentProfileSettingsSection(props: AgentProfileSettingsProps) {
  const runtime = props.runtime ?? desktopProfiles;
  return <AgentProfiles key={runtimeKey(runtime)} {...props} runtime={runtime} />;
}

function AgentProfiles({
  definition,
  open,
  disclosure,
  anchor = null,
  runtime = desktopProfiles,
}: AgentProfileSettingsProps) {
  const intl = useIntl();
  const { driver, label, settingsAnchor: id } = definition;
  const profileDefinition: AgentProfileDefinition = definition.profile;
  const slots = agentProfileSettingsSlots[driver];
  const profileAnchorPrefix =
    "profileAnchorPrefix" in definition ? definition.profileAnchorPrefix : `${id}-profile-`;
  const executablePlaceholder = profileDefinition.executable.placeholder;
  const environment = agentProfileEnvironment(driver);
  const [saved, setSaved] = useState<readonly AgentProfile[] | null>(null);
  const [savedEnvironments, setSavedEnvironments] = useState<
    Record<string, AgentEnvironmentDraft[]>
  >({});
  const [drafts, setDrafts] = useState<Record<string, ProfileDraft>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openedAnchor, setOpenedAnchor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** A saved profile's switch while its new state is being saved. */
  const [toggling, setToggling] = useState<{
    readonly id: string;
    readonly enabled: boolean;
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const accept = (next: readonly AgentProfile[]) => {
    setSaved(next);
    setSavedEnvironments(
      Object.fromEntries(next.map((entry) => [entry.id, environmentRows(entry.environment ?? [])])),
    );
  };
  const {
    reading,
    error: loadError,
    retry,
    serialize,
  } = useSettingsRead(
    open,
    () => runtime.read(driver),
    (next) => accept(next.instances),
  );

  const savedProfiles = saved ?? [];
  const anchorOf = (profileId: string) => `${profileAnchorPrefix}${profileId}`;
  const anchored =
    "profileAnchorPrefix" in definition && anchor
      ? (savedProfiles.find((profile) => anchorOf(profile.id) === anchor)?.id ?? null)
      : null;
  // A deep link opens its profile once, when that profile first becomes known.
  if (anchored && anchored !== openedAnchor) {
    setOpenedAnchor(anchored);
    setExpanded(anchored);
  }
  const unsaved = Object.values(drafts)
    .map(({ instance }) => instance)
    .filter((instance) => !savedProfiles.some(({ id: savedId }) => savedId === instance.id));
  const profiles = [...savedProfiles, ...unsaved];
  const savedEntry = (profileId: string) =>
    savedProfiles.find((entry) => entry.id === profileId) ?? null;
  /** A saved profile's on/off state is never a draft edit: it is whatever Main last saved. */
  const current = (profileId: string): ProfileDraft | null => {
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
  const edit = (profileId: string, patch: Partial<ProfileDraft>) => {
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
    next: readonly EditableAgentProfile[],
    replace?: ProfileDraft,
  ): Promise<PersistOutcome> => {
    if (!editable) return "superseded";
    const instances: AgentProfileInput[] = next.map((entry) =>
      agentProfileInput(
        environment
          ? {
              ...entry,
              environment: environmentDraftInput(
                entry.id === replace?.instance.id
                  ? replace.environment
                  : (savedEnvironments[entry.id] ?? []),
                environment,
              ),
            }
          : entry,
      ),
    );
    setBusy(profileId);
    setError(profileId, null);
    return runWithCleanup<PersistOutcome>(
      async () => {
        const result = await serialize(() => runtime.update({ driver, instances }));
        accept(result.instances);
        return "saved";
      },
      {
        onError: (cause) => {
          return { failure: failureMessage(cause) };
        },
        cleanup: () => {
          setBusy(null);
        },
      },
    );
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
    const validation = environment
      ? validateEnvironmentDraft(draft.environment, environment)
      : null;
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
      ...createAgentProfile(definition),
      displayName: nextProfileName(
        profileDefinition.defaultName,
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
    const change = (patch: { readonly binaryPath?: string; readonly displayName?: string }) =>
      edit(profileId, { instance: { ...instance, ...patch } });
    const executable = (
      <NodexSettingsRow
        variant="nested"
        label={intl.formatMessage(settingsMessages.agentProfilesExecutable)}
        description={
          slots?.executableStatus?.({
            saved: entry,
            draft: instance,
            environment: draft.environment,
            open,
          }) || intl.formatMessage(profileDefinition.executable.description)
        }
      >
        <Input
          aria-label={intl.formatMessage(
            { id: "settings.agentProfiles.executable2", defaultMessage: "{label} executable" },
            { label: label },
          )}
          className={agentProfileInputClassName}
          value={instance.binaryPath}
          disabled={disabled}
          placeholder={
            typeof executablePlaceholder === "string"
              ? executablePlaceholder
              : intl.formatMessage(executablePlaceholder)
          }
          spellCheck={false}
          onChange={(event) => change({ binaryPath: event.target.value })}
        />
      </NodexSettingsRow>
    );
    return (
      <>
        <NodexSettingsRow
          variant="nested"
          label={intl.formatMessage(settingsMessages.agentProfilesName)}
        >
          <Input
            aria-label={intl.formatMessage(
              { id: "settings.agentProfiles.profileName", defaultMessage: "{label} profile name" },
              { label: label },
            )}
            className={agentProfileInputClassName}
            value={instance.displayName}
            disabled={disabled}
            onChange={(event) => change({ displayName: event.target.value })}
          />
        </NodexSettingsRow>
        {slots?.account?.({ saved: entry })}
        {profileDefinition.executable.position !== "afterFields" ? executable : null}
        {Object.entries(profileDefinition.fields).map(([key, field]) => {
          if (field.control === "custom") return null;
          const values: Readonly<Record<string, unknown>> = instance.settings;
          return (
            <AgentProfileFieldRow
              key={key}
              field={field}
              value={values[key]}
              settings={values}
              saved={instance.savedSecrets.includes(key)}
              disabled={disabled}
              onChange={(value) =>
                edit(profileId, {
                  // The field comes from the definition for this draft's driver.
                  instance: {
                    ...instance,
                    settings: { ...instance.settings, [key]: value },
                  } as EditableAgentProfile,
                })
              }
            />
          );
        })}
        {slots?.bespokeEditors?.({
          draft: instance,
          disabled,
          change: (instance) => edit(profileId, { instance }),
        })}
        {profileDefinition.executable.position === "afterFields" ? executable : null}
        {environment ? (
          <AgentEnvironmentEditor
            rows={draft.environment}
            disabled={disabled}
            policy={environment}
            suggestedNames={environment.suggestions}
            onChange={(rows) => edit(profileId, { environment: rows })}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          {confirmRemove === profileId ? (
            <>
              <span className="text-sm">
                {intl.formatMessage(
                  {
                    id: "settings.agentProfiles.confirmRemove",
                    defaultMessage: "Remove {profile}?",
                  },
                  {
                    profile:
                      instance.displayName ||
                      intl.formatMessage({
                        id: "settings.agentProfiles.thisProfile",
                        defaultMessage: "this profile",
                      }),
                  },
                )}
              </span>
              <NodexButton
                size="sm"
                variant="destructive"
                disabled={disabled}
                onClick={() => void remove(profileId)}
              >
                {intl.formatMessage({
                  id: "settings.agentProfiles.remove2",
                  defaultMessage: "Remove",
                })}
              </NodexButton>
              <NodexButton
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => setConfirmRemove(null)}
              >
                {intl.formatMessage({ id: "settings.agentProfiles.keep", defaultMessage: "Keep" })}
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
              {intl.formatMessage({
                id: "settings.agentProfiles.removeProfile",
                defaultMessage: "Remove profile",
              })}
            </NodexButton>
          )}
          <span className="min-w-0 flex-1 text-end text-xs">
            {error ? (
              <span role="alert" className="text-danger">
                {error}
              </span>
            ) : !entry ? (
              <span className="text-token-text-secondary">
                {intl.formatMessage({
                  id: "settings.agentProfiles.notSavedYet",
                  defaultMessage: "Not saved yet",
                })}
              </span>
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
              {intl.formatMessage({
                id: "settings.agentProfiles.discard",
                defaultMessage: "Discard",
              })}
            </NodexButton>
          ) : null}
          <NodexButton
            size="sm"
            variant="secondary"
            disabled={
              disabled ||
              !isChanged ||
              !instance.displayName.trim() ||
              (!profileDefinition.executable.allowEmpty && !instance.binaryPath.trim())
            }
            onClick={() => void save(profileId)}
          >
            {busy === profileId
              ? intl.formatMessage({
                  id: "settings.agentProfiles.saving",
                  defaultMessage: "Saving…",
                })
              : intl.formatMessage({ id: "settings.agentProfiles.save", defaultMessage: "Save" })}
          </NodexButton>
        </div>
      </>
    );
  };

  return (
    <NodexSettingsSection
      id={id}
      title={label}
      icon={<AgentProviderIcon kind={driver} />}
      description={intl.formatMessage(profileDefinition.description)}
      summary={
        loadError
          ? intl.formatMessage({
              id: "settings.agentProfiles.couldntLoad",
              defaultMessage: "Couldn't load",
            })
          : agentProfilesSummary(saved, intl)
      }
      disclosure={disclosure}
    >
      {loadError ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-danger">
            {intl.formatMessage(
              {
                id: "settings.agentProfiles.loadProfilesError",
                defaultMessage: "Couldn't load {agent} profiles. {reason}",
              },
              { agent: label, reason: loadError },
            )}
          </p>
          <NodexButton size="xs" variant="secondary" onClick={retry}>
            {intl.formatMessage({
              id: "settings.agentProfiles.tryAgain",
              defaultMessage: "Try again",
            })}
          </NodexButton>
        </div>
      ) : saved === null ? (
        <p role="status" className="px-4 py-3 text-xs text-token-text-secondary">
          {intl.formatMessage({
            id: "settings.agentProfiles.loadingProfiles",
            defaultMessage: "Loading profiles…",
          })}
        </p>
      ) : profiles.length === 0 ? (
        <>
          {slots?.sharedRuntime?.({ open: open && disclosure.open, profileCount: 0 })}
          <NodexSettingsRow
            label={intl.formatMessage(
              { id: "settings.agentProfiles.setUp", defaultMessage: "Set up {label}" },
              { label: label },
            )}
            description={intl.formatMessage(profileDefinition.setupDescription)}
          >
            <NodexButton size="sm" variant="secondary" onClick={add}>
              {intl.formatMessage(settingsMessages.agentProfilesAddProfile)}
            </NodexButton>
          </NodexSettingsRow>
        </>
      ) : (
        <>
          {slots?.sharedRuntime?.({ open: open && disclosure.open, profileCount: profiles.length })}
          {profiles.map((profile) => {
            const shown = current(profile.id)?.instance ?? profile;
            const isSaved = savedEntry(profile.id) !== null;
            const isChanged = changed(profile.id);
            const error = errors[profile.id];
            return (
              <NodexSettingsExpandableRow
                key={profile.id}
                id={anchorOf(profile.id)}
                label={
                  shown.displayName ||
                  intl.formatMessage({
                    id: "settings.agentProfiles.untitledProfile",
                    defaultMessage: "Untitled profile",
                  })
                }
                detail={profileDefinition
                  .detail(shown, intl.formatMessage)
                  .filter(Boolean)
                  .join(" · ")}
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
                        {error
                          ? intl.formatMessage({
                              id: "settings.agentProfiles.couldntSave",
                              defaultMessage: "Couldn't save",
                            })
                          : isSaved
                            ? intl.formatMessage({
                                id: "settings.agentProfiles.unsavedChanges",
                                defaultMessage: "Unsaved changes",
                              })
                            : intl.formatMessage({
                                id: "settings.agentProfiles.notSavedYet",
                                defaultMessage: "Not saved yet",
                              })}
                      </span>
                    ) : null}
                    <NodexSwitch
                      size="compact"
                      ariaLabel={intl.formatMessage(
                        {
                          id: "settings.agentProfiles.toggleProfile",
                          defaultMessage:
                            "{state, select, on {Turn off {profile}} other {Turn on {profile}}}",
                        },
                        {
                          state: enabledOf(profile.id) ? "on" : "off",
                          profile: shown.displayName || label,
                        },
                      )}
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
            label={intl.formatMessage(settingsMessages.agentProfilesAddProfile)}
            disabled={!editable || profiles.length >= AGENT_PROFILE_LIMIT}
            onClick={add}
          />
        </>
      )}
    </NodexSettingsSection>
  );
}
