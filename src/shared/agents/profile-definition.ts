import type { ZodType } from "zod";
import { defineMessage, type MessageDescriptor } from "../i18n/messages.ts";
import type { FormatEnvironmentValidation } from "../agent-environment.ts";

type ProfileCopy = string | MessageDescriptor;
export type ProfileValues = Readonly<Record<string, unknown>>;
type ProfilePredicate = (values: ProfileValues) => boolean;
type ProfileMessage = (message: MessageDescriptor, values?: { count: number }) => string;

interface ProfileFieldCopy {
  readonly label: MessageDescriptor;
  readonly description?:
    | MessageDescriptor
    | ((values: ProfileValues) => MessageDescriptor | undefined);
  readonly accessibleLabel: MessageDescriptor;
  readonly placeholder?: ProfileCopy;
  readonly when?: ProfilePredicate;
}

export type AgentProfileField =
  | (ProfileFieldCopy & {
      readonly control: "text" | "path";
      readonly maxLength?: number;
      readonly format?: "http-url";
    } & (
        | { readonly empty: "null"; readonly defaultValue: string | null }
        | { readonly empty?: "string"; readonly defaultValue: string }
      ))
  | (ProfileFieldCopy & {
      readonly control: "secret";
      readonly savedPlaceholder: MessageDescriptor;
      readonly maxLength: number;
      readonly defaultValue: null;
    })
  | (ProfileFieldCopy & {
      readonly control: "select";
      readonly options: readonly { readonly value: string; readonly label: MessageDescriptor }[];
      readonly defaultValue: string;
    })
  | {
      readonly control: "custom";
      readonly schema: ZodType;
      readonly defaultValue: unknown;
    };

interface ProfilePresentation {
  readonly binaryPath: string;
  readonly settings: ProfileValues;
  readonly environment?: readonly { readonly name: string }[];
}

export interface AgentProfileDefinition {
  readonly defaultName: string;
  /** A built-in profile supplied until the Profile first saves its own list. */
  readonly initialId?: string;
  readonly description: MessageDescriptor;
  readonly setupDescription: MessageDescriptor;
  readonly executable: {
    readonly defaultValue: string;
    readonly placeholder: ProfileCopy;
    readonly description: MessageDescriptor;
    readonly allowEmpty?: true;
    readonly position?: "afterFields";
  };
  /** Declaration order is form order. Custom fields are rendered by the bespoke editor slot. */
  readonly fields: Readonly<Record<string, AgentProfileField>>;
  readonly environment?: {
    readonly nameError: (
      name: string,
      formatMessage?: FormatEnvironmentValidation,
    ) => string | null;
    readonly suggestions: readonly string[];
  };
  readonly detail: (
    profile: ProfilePresentation,
    format: ProfileMessage,
  ) => readonly (string | null | undefined)[];
  readonly usesHostExecutable?: (profile: ProfilePresentation) => boolean;
  readonly search: readonly {
    readonly label: ProfileCopy;
    readonly description: MessageDescriptor;
    readonly keywords?: readonly ProfileCopy[];
  }[];
}

const environmentCount = defineMessage({
  id: "settings.agentProfiles.environmentVariableCount",
  defaultMessage: "{count, plural, one {# variable} other {# variables}}",
});

export const profileEnvironmentDetail = (count: number, format: ProfileMessage) =>
  count ? format(environmentCount, { count }) : null;
