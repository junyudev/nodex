import type { AgentBackendBinding } from "../../../../shared/agent-backend";
import type {
  AgentModelSelection,
  ExternalAgentBinding,
} from "../../../../shared/agent-model-catalog";
import type {
  AgentSessionConfigOption,
  AgentSessionModeState,
} from "../../../../shared/agent-conversation";
import type { AgentModelOption } from "../../../../shared/types";

export interface AgentModelPickerEntry {
  readonly spendsCredit?: boolean;
  readonly binding: AgentBackendBinding;
  readonly label: string;
  readonly model: AgentModelOption;
  readonly selection: AgentModelSelection;
  /** Why this chat cannot use the model now; the model stays listed but cannot be chosen. */
  readonly unavailableReason?: string;
  /** The word beside an unavailable model; `Unavailable` unless the reason has a better name. */
  readonly unavailableLabel?: string;
}

/** A runtime whose models become available after setup, offered beside the model list. */
export interface AgentModelSetupPresentation {
  readonly key?: string;
  readonly kind: AgentBackendBinding["kind"];
  readonly label: string;
  /** The next step or live state, such as `Install` or `42%`. */
  readonly hint?: string;
  readonly tone: "default" | "danger";
  /** `open` runs after the menu closes; `settings` routes through `manage`. */
  readonly action?:
    | {
        readonly kind: "open";
        readonly open: (port: { readonly showModels: () => void }) => void;
      }
    | { readonly kind: "settings" };
}

/** The composer chooses one complete runtime/model tuple; options belong to the selected runtime. */
export interface AgentModelCatalogPresentation {
  /** This chat's own model is off, so it can't run until the person chooses or turns it on. */
  readonly currentModelOff?: {
    readonly code: "model_off" | "credit_requires_person";
    readonly message: string;
    /** Names the condition in the person's words. */
    readonly title: string;
    /** Absent when turning it on takes a deliberate visit to Settings, as credit does. */
    readonly turnOn?: () => Promise<void>;
  } | null;
  /** Models that are off: gone from the list, found again only by searching for them. */
  readonly off?: {
    /** What a search can bring back; narrower than `count` while a whole provider is off. */
    readonly entries: readonly AgentModelPickerEntry[];
    readonly count: number;
    readonly choose: (selection: AgentModelSelection) => Promise<void>;
  };
  /** Opens Settings → Models, at one provider's card when named. */
  readonly manageModels?: (providerKey?: string) => void;
  readonly entries: readonly AgentModelPickerEntry[];
  readonly selected: AgentModelSelection;
  readonly loading: boolean;
  readonly error?: string | null;
  readonly choose: (selection: AgentModelSelection) => Promise<void> | void;
  /** Forces providers to check again, as the Refresh button does; without it there is none. */
  readonly refresh?: () => void;
  /** Reads the catalog as it is now without forcing a check; opening the picker calls it. */
  readonly reload?: () => void;
  /** Opens the providers' settings, as the Manage button does; without it there is none. */
  readonly manage?: () => void;
  readonly runtimeOptions?: readonly { binding: ExternalAgentBinding; label: string }[];
  readonly chooseRuntime?: (binding: ExternalAgentBinding) => void;
  readonly configOptions?: readonly AgentSessionConfigOption[];
  readonly changeConfig?: (id: string, value: string | boolean) => Promise<void>;
  readonly modes?: AgentSessionModeState | null;
  readonly changeMode?: (modeId: string) => Promise<void>;
  /** Runtimes whose models become available after setup; each keeps its own entry. */
  readonly setups?: readonly AgentModelSetupPresentation[];
  /** Settings that belong to the choice itself, switched in place without closing the menu. */
  readonly toggles?: readonly {
    readonly label: string;
    readonly checked: boolean;
    readonly change: (checked: boolean) => void;
  }[];
  /** Owner actions about the choice itself, listed last; each closes the menu first. */
  readonly actions?: readonly { readonly label: string; readonly run: () => void }[];
}
