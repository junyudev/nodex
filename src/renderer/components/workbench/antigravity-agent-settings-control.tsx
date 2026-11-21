import { defineMessage, getIntl, useIntl, type MessageDescriptor } from "@/lib/i18n";
import type { ReactNode } from "react";
import type {
  AntigravityAgentInstanceConfig,
  AntigravityAuthMethod,
  UpdateAntigravityAgentSettingsInput,
} from "../../../shared/antigravity-agent-settings";
import {
  readAntigravityAgentSettings,
  updateAntigravityAgentSettings,
} from "../../lib/antigravity-agent-settings-runtime";
import { AntigravityAccountRow } from "../../features/agent-account/antigravity-account-row";
import {
  AntigravityProfileExecutable,
  AntigravityRuntimeRow,
} from "../../features/antigravity-runtime/antigravity-runtime-status";
import { antigravityAgentAnchor } from "../../lib/agent-settings-navigation";
import { AntigravityIcon } from "../shared/icons";
import { settingsMessages } from "./workbench-settings-search-catalog";
import { Input } from "../ui/input";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "../ui/dropdown";
import { NodexSettingsRow, type NodexSettingsDisclosureState } from "../ui/settings";
import {
  AgentInstanceSettingsControl,
  type AgentInstanceSettingsRuntime,
} from "./agent-instance-settings-control";

/** A profile as it is edited: a typed key replaces the saved one, and null keeps it. */
export type AntigravityProfile = Omit<AntigravityAgentInstanceConfig, "apiKey"> & {
  readonly apiKey: string | null;
};
export type AntigravityAgentSettingsRuntime = AgentInstanceSettingsRuntime<AntigravityProfile>;

/** Which of a profile's credentials its sign-in method reads. */
export const antigravityMethodFields = (method: AntigravityAuthMethod) => ({
  apiKey: method === "gemini-api-key" || method === "agent-platform",
  cloudProject: method === "oauth-business" || method === "agent-platform",
});

/** What a save sends: a method that reads no key drops the saved one, so no secret outlives its use. */
export const antigravitySettingsUpdate = (
  profiles: readonly AntigravityProfile[],
): UpdateAntigravityAgentSettingsInput => ({
  instances: profiles.map(({ hasApiKey: _saved, ...profile }) => ({
    ...profile,
    apiKey: antigravityMethodFields(profile.authMethod).apiKey ? profile.apiKey : "",
  })),
});

const defaultRuntime: AntigravityAgentSettingsRuntime = {
  read: readAntigravityAgentSettings,
  update: ({ instances }) => updateAntigravityAgentSettings(antigravitySettingsUpdate(instances)),
};

const createInstance = (): AntigravityProfile => ({
  id: crypto.randomUUID(),
  displayName: "Antigravity",
  enabled: true,
  authMethod: "oauth-personal",
  apiKey: null,
  hasApiKey: false,
  gcpProject: "",
  gcpLocation: "",
  binaryPath: "",
});

const SIGN_IN_METHODS: ReadonlyArray<{
  readonly value: AntigravityAuthMethod;
  readonly label: MessageDescriptor;
}> = [
  {
    value: "oauth-personal",
    label: defineMessage({
      id: "settings.antigravity.method.googleAccount",
      defaultMessage: "Google account",
    }),
  },
  {
    value: "oauth-business",
    label: defineMessage({
      id: "settings.antigravity.method.geminiEnterprise",
      defaultMessage: "Gemini Enterprise",
    }),
  },
  {
    value: "gemini-api-key",
    label: defineMessage({
      id: "settings.antigravity.method.geminiApiKey",
      defaultMessage: "Gemini API key",
    }),
  },
  {
    value: "agent-platform",
    label: defineMessage({
      id: "settings.antigravity.method.agentPlatform",
      defaultMessage: "Agent Platform (Vertex AI)",
    }),
  },
];

const methodLabel = (method: AntigravityAuthMethod) =>
  SIGN_IN_METHODS.find(({ value }) => value === method)!.label;

/** The collapsed profile's second line: how it signs in, and its executable when chosen by hand. */
export const antigravityProfileDetail = (
  profile: Pick<AntigravityProfile, "authMethod" | "binaryPath">,
  intl = getIntl(),
) =>
  [intl.formatMessage(methodLabel(profile.authMethod)), profile.binaryPath]
    .filter(Boolean)
    .join(" · ");

const fieldClassName = "h-8 w-[min(28rem,45vw)] text-sm";

function SignInMethodControl({
  value,
  disabled,
  onChange,
}: {
  readonly value: AntigravityAuthMethod;
  readonly disabled: boolean;
  readonly onChange: (value: AntigravityAuthMethod) => void;
}) {
  const intl = useIntl();
  return (
    <NodexDropdownMenu
      disabled={disabled}
      contentWidth="menuWide"
      align="end"
      triggerButton={
        <NodexSettingsDropdownTrigger
          className="min-w-52"
          aria-label={intl.formatMessage({
            id: "settings.antigravity.signInMethod.label",
            defaultMessage: "Antigravity sign-in method",
          })}
        >
          <span className="truncate">{intl.formatMessage(methodLabel(value))}</span>
        </NodexSettingsDropdownTrigger>
      }
    >
      {SIGN_IN_METHODS.map((method) => (
        <NodexDropdownItem
          key={method.value}
          onSelect={() => onChange(method.value)}
          rightSlot={method.value === value ? <NodexDropdownSelectedIcon /> : null}
        >
          <span className="truncate">{intl.formatMessage(method.label)}</span>
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

const profileAccount = (profile: AntigravityProfile) => (
  <AntigravityAccountRow
    backend={{ kind: "antigravity", instanceConfigId: profile.id }}
    authMethod={profile.authMethod}
  />
);

export function AntigravityAgentSettingsControl({
  open,
  anchor = null,
  disclosure,
  runtime = defaultRuntime,
  shared,
  account = profileAccount,
  executableStatus,
}: {
  readonly open: boolean;
  /** A deep link into the section; one that names a profile opens it. */
  readonly anchor?: string | null;
  readonly disclosure: NodexSettingsDisclosureState;
  readonly runtime?: AntigravityAgentSettingsRuntime;
  /** The runtime every profile runs, with its install and update. */
  readonly shared?: (input: { readonly profileCount: number }) => ReactNode;
  /** A saved, enabled profile's sign-in. */
  readonly account?: (profile: AntigravityProfile) => ReactNode;
  /** Which executable a saved profile runs, or would with the path being typed. */
  readonly executableStatus?: (profile: AntigravityProfile, binaryPath: string) => ReactNode;
}) {
  const intl = useIntl();
  return (
    <AgentInstanceSettingsControl
      open={open}
      id="antigravity"
      label="Antigravity"
      icon={<AntigravityIcon />}
      description={intl.formatMessage(settingsMessages.antigravityDescription)}
      setupDescription={intl.formatMessage({
        id: "settings.antigravity.setupDescription",
        defaultMessage:
          "A profile is one account. Nodex keeps its sign-in apart from Antigravity in your terminal.",
      })}
      disclosure={disclosure}
      anchor={anchor}
      profileAnchor={antigravityAgentAnchor}
      executablePlaceholder={intl.formatMessage({
        id: "settings.antigravity.executable.automatic",
        defaultMessage: "Automatic",
      })}
      executableDescription={intl.formatMessage({
        id: "settings.antigravity.executable.description",
        defaultMessage: "Empty runs Nodex's download, or agy on this computer.",
      })}
      executableOptional
      executableStatus={({ saved, draft }) =>
        !saved ? null : executableStatus ? (
          executableStatus(saved, draft.binaryPath)
        ) : (
          <AntigravityProfileExecutable
            profileId={saved.id}
            binaryPath={draft.binaryPath}
            open={open}
          />
        )
      }
      runtime={runtime}
      createInstance={createInstance}
      shared={
        shared ?? ((input) => <AntigravityRuntimeRow open={open && disclosure.open} {...input} />)
      }
      account={({ saved }) =>
        saved?.enabled ? (
          account(saved)
        ) : (
          <NodexSettingsRow
            variant="nested"
            label={intl.formatMessage({
              id: "settings.antigravity.account",
              defaultMessage: "Account",
            })}
            description={
              saved
                ? intl.formatMessage({
                    id: "settings.antigravity.account.turnOnFirst",
                    defaultMessage: "Turn this profile on to sign in.",
                  })
                : intl.formatMessage({
                    id: "settings.antigravity.account.saveFirst",
                    defaultMessage: "Save this profile to sign in.",
                  })
            }
          >
            {null}
          </NodexSettingsRow>
        )
      }
      profileDetail={(profile) => antigravityProfileDetail(profile, intl)}
      fields={({ draft, disabled, change }) => {
        const needs = antigravityMethodFields(draft.authMethod);
        return (
          <>
            <NodexSettingsRow
              variant="nested"
              label={intl.formatMessage(settingsMessages.antigravitySignInMethod)}
              description={intl.formatMessage(settingsMessages.antigravitySignInMethodDescription)}
            >
              <SignInMethodControl
                value={draft.authMethod}
                disabled={disabled}
                onChange={(authMethod) => change({ authMethod })}
              />
            </NodexSettingsRow>
            {needs.apiKey ? (
              <NodexSettingsRow
                variant="nested"
                label={intl.formatMessage({
                  id: "settings.antigravity.apiKey",
                  defaultMessage: "API key",
                })}
                description={intl.formatMessage({
                  id: "settings.antigravity.apiKey.description",
                  defaultMessage: "Kept encrypted on this computer, and never shown again.",
                })}
              >
                <Input
                  type="password"
                  aria-label={intl.formatMessage({
                    id: "settings.antigravity.apiKey.label",
                    defaultMessage: "Antigravity API key",
                  })}
                  className={fieldClassName}
                  value={draft.apiKey ?? ""}
                  disabled={disabled}
                  placeholder={
                    draft.hasApiKey && draft.apiKey === null
                      ? intl.formatMessage({
                          id: "settings.antigravity.apiKey.saved",
                          defaultMessage: "Saved",
                        })
                      : undefined
                  }
                  autoComplete="off"
                  spellCheck={false}
                  // Clearing the field back to empty keeps a saved key; removing one is its own act.
                  onChange={(event) =>
                    change({
                      apiKey:
                        event.target.value === "" && draft.hasApiKey ? null : event.target.value,
                    })
                  }
                />
              </NodexSettingsRow>
            ) : null}
            {needs.cloudProject ? (
              <>
                <NodexSettingsRow
                  variant="nested"
                  label={intl.formatMessage({
                    id: "settings.antigravity.gcpProject",
                    defaultMessage: "Google Cloud project",
                  })}
                  description={
                    draft.authMethod === "agent-platform"
                      ? intl.formatMessage({
                          id: "settings.antigravity.gcpProject.optional",
                          defaultMessage: "Optional. The project your key's usage belongs to.",
                        })
                      : undefined
                  }
                >
                  <Input
                    aria-label={intl.formatMessage({
                      id: "settings.antigravity.gcpProject.label",
                      defaultMessage: "Antigravity Google Cloud project",
                    })}
                    className={fieldClassName}
                    value={draft.gcpProject}
                    disabled={disabled}
                    placeholder="my-project-id"
                    spellCheck={false}
                    onChange={(event) => change({ gcpProject: event.target.value })}
                  />
                </NodexSettingsRow>
                <NodexSettingsRow
                  variant="nested"
                  label={intl.formatMessage({
                    id: "settings.antigravity.gcpLocation",
                    defaultMessage: "Location",
                  })}
                >
                  <Input
                    aria-label={intl.formatMessage({
                      id: "settings.antigravity.gcpLocation.label",
                      defaultMessage: "Antigravity Google Cloud location",
                    })}
                    className={fieldClassName}
                    value={draft.gcpLocation}
                    disabled={disabled}
                    placeholder="us-central1"
                    spellCheck={false}
                    onChange={(event) => change({ gcpLocation: event.target.value })}
                  />
                </NodexSettingsRow>
              </>
            ) : null}
          </>
        );
      }}
    />
  );
}
