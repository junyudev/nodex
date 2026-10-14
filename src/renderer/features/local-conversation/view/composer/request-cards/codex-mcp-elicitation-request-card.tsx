import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDownIcon, CloseIcon } from "@/components/shared/icons";
import type {
  CodexMcpServerElicitationRequest,
  CodexMcpServerElicitationResponse,
  CodexProtocolRequestId,
} from "../../../../../lib/types";
import { cn } from "../../../../../lib/utils";
import { buildTextPreview, INLINE_TEXT_PREVIEW_MAX_CHARS } from "../../../../../lib/text-preview";
import {
  buildCodexMcpElicitationFormModel,
  buildCodexMcpServerElicitationResponse,
  createInitialCodexMcpElicitationFormValues,
  validateCodexMcpElicitationFormValues,
  type CodexMcpElicitationFieldValue,
  type CodexMcpElicitationFormField,
  type CodexMcpElicitationFormModel,
} from "../../../../../../shared/codex-mcp-elicitation";
import { ToolActivityIcon, resolveMcpElicitationIcon } from "../../shared/tools/tool-call-icons";
import { ToolCallCodePanel, stringifyToolCallValue } from "../../shared/tools/tool-call-inspection";

interface CodexMcpElicitationRequestCardProps {
  request: CodexMcpServerElicitationRequest;
  onRespond: (
    requestId: CodexProtocolRequestId,
    response: CodexMcpServerElicitationResponse,
  ) => Promise<void>;
}

function formatServerName(serverName: string): string {
  const trimmed = serverName.trim();
  return trimmed.length > 0 ? trimmed : "Server";
}

function fieldValueAsString(value: CodexMcpElicitationFieldValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function ErrorMessage({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="text-size-chat-sm leading-5 px-2 pt-1 text-token-editor-error-foreground">
      Complete this field to continue
    </div>
  );
}

function FieldDescription({
  description,
  inset = true,
}: {
  description: string | null;
  inset?: boolean;
}) {
  if (!description) return null;
  return (
    <div
      className={cn(
        "text-size-chat-sm leading-5 text-token-description-foreground",
        inset && "px-2",
      )}
    >
      {description}
    </div>
  );
}

function TextField({
  field,
  value,
  invalid,
  autoFocus,
  onChange,
}: {
  field: Extract<CodexMcpElicitationFormField, { kind: "text" }>;
  value: CodexMcpElicitationFieldValue | undefined;
  invalid: boolean;
  autoFocus: boolean;
  onChange: (value: CodexMcpElicitationFieldValue) => void;
}) {
  return (
    <label className="flex flex-col gap-1 px-2 text-sm">
      <div className="text-size-chat-sm leading-5 font-medium text-token-foreground">
        {field.label}
      </div>
      <FieldDescription description={field.description} inset={false} />
      <input
        autoFocus={autoFocus}
        aria-label={field.label}
        aria-invalid={invalid || undefined}
        className="bg-token-background h-8 rounded-xl border border-token-border px-3 outline-none focus:border-token-foreground/30 aria-invalid:border-token-error-foreground"
        maxLength={field.maxLength}
        minLength={field.minLength}
        type={field.inputType}
        value={fieldValueAsString(value)}
        onChange={(event) => onChange(event.currentTarget.value)}
        onInput={(event) => onChange(event.currentTarget.value)}
      />
      <ErrorMessage visible={invalid} />
    </label>
  );
}

function NumberField({
  field,
  value,
  invalid,
  autoFocus,
  onChange,
}: {
  field: Extract<CodexMcpElicitationFormField, { kind: "number" }>;
  value: CodexMcpElicitationFieldValue | undefined;
  invalid: boolean;
  autoFocus: boolean;
  onChange: (value: CodexMcpElicitationFieldValue) => void;
}) {
  return (
    <label className="flex flex-col gap-1 px-2 text-sm">
      <div className="text-size-chat-sm leading-5 font-medium text-token-foreground">
        {field.label}
      </div>
      <FieldDescription description={field.description} inset={false} />
      <input
        autoFocus={autoFocus}
        aria-label={field.label}
        aria-invalid={invalid || undefined}
        className="bg-token-background h-8 rounded-xl border border-token-border px-3 outline-none focus:border-token-foreground/30 aria-invalid:border-token-error-foreground"
        max={field.maximum}
        min={field.minimum}
        step={field.integer ? 1 : "any"}
        type="number"
        value={fieldValueAsString(value)}
        onChange={(event) => onChange(event.currentTarget.value)}
        onInput={(event) => onChange(event.currentTarget.value)}
      />
      <ErrorMessage visible={invalid} />
    </label>
  );
}

function ChoiceIndicator({
  selected,
  variant,
}: {
  selected: boolean;
  variant: "radio" | "checkbox";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center border",
        variant === "radio" ? "rounded-full" : "rounded-[4px]",
        selected
          ? "border-token-foreground bg-token-foreground text-token-dropdown-background"
          : "border-token-border text-transparent",
      )}
    >
      {variant === "radio" ? <span className="size-1.5 rounded-full bg-current" /> : "✓"}
    </span>
  );
}

function ChoiceButton({
  selected,
  role,
  autoFocus,
  children,
  onSelect,
}: {
  selected: boolean;
  role: "radio" | "checkbox";
  autoFocus: boolean;
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      autoFocus={autoFocus}
      className={cn(
        "cursor-interaction flex min-h-8 w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border",
        selected ? "bg-token-foreground/5" : "hover:bg-token-foreground/5",
      )}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

function SingleSelectField({
  field,
  value,
  invalid,
  autoFocus,
  onChange,
}: {
  field: Extract<CodexMcpElicitationFormField, { kind: "singleSelect" }>;
  value: CodexMcpElicitationFieldValue | undefined;
  invalid: boolean;
  autoFocus: boolean;
  onChange: (value: CodexMcpElicitationFieldValue) => void;
}) {
  const selectedValue = fieldValueAsString(value);
  return (
    <fieldset className="flex flex-col gap-1" aria-label={field.label}>
      <legend className="text-size-chat-sm px-2 font-medium text-token-foreground">
        {field.label}
      </legend>
      <FieldDescription description={field.description} />
      {field.options.map((option, index) => {
        const selected = selectedValue === option.value;
        return (
          <ChoiceButton
            key={option.value}
            role="radio"
            selected={selected}
            autoFocus={autoFocus && index === 0}
            onSelect={() => onChange(option.value)}
          >
            <ChoiceIndicator selected={selected} variant="radio" />
            <span>{option.label}</span>
          </ChoiceButton>
        );
      })}
      <ErrorMessage visible={invalid} />
    </fieldset>
  );
}

function MultiSelectField({
  field,
  value,
  invalid,
  autoFocus,
  onChange,
}: {
  field: Extract<CodexMcpElicitationFormField, { kind: "multiSelect" }>;
  value: CodexMcpElicitationFieldValue | undefined;
  invalid: boolean;
  autoFocus: boolean;
  onChange: (value: CodexMcpElicitationFieldValue) => void;
}) {
  const selectedValues = Array.isArray(value) ? value : [];
  return (
    <fieldset className="flex flex-col gap-1" aria-label={field.label}>
      <legend className="text-size-chat-sm px-2 font-medium text-token-foreground">
        {field.label}
      </legend>
      <FieldDescription description={field.description} />
      {field.options.map((option, index) => {
        const selected = selectedValues.includes(option.value);
        return (
          <ChoiceButton
            key={option.value}
            role="checkbox"
            selected={selected}
            autoFocus={autoFocus && index === 0}
            onSelect={() => {
              onChange(
                selected
                  ? selectedValues.filter((value) => value !== option.value)
                  : [...selectedValues, option.value],
              );
            }}
          >
            <ChoiceIndicator selected={selected} variant="checkbox" />
            <span>{option.label}</span>
          </ChoiceButton>
        );
      })}
      <ErrorMessage visible={invalid} />
    </fieldset>
  );
}

function BooleanField({
  field,
  value,
  invalid,
  autoFocus,
  onChange,
}: {
  field: Extract<CodexMcpElicitationFormField, { kind: "boolean" }>;
  value: CodexMcpElicitationFieldValue | undefined;
  invalid: boolean;
  autoFocus: boolean;
  onChange: (value: CodexMcpElicitationFieldValue) => void;
}) {
  const selected = value === true;
  return (
    <div className="flex flex-col gap-1">
      <ChoiceButton
        role="checkbox"
        selected={selected}
        autoFocus={autoFocus}
        onSelect={() => onChange(!selected)}
      >
        <ChoiceIndicator selected={selected} variant="checkbox" />
        <span>{field.label}</span>
      </ChoiceButton>
      <FieldDescription description={field.description} />
      <ErrorMessage visible={invalid} />
    </div>
  );
}

function FormField({
  field,
  value,
  invalid,
  autoFocus,
  onChange,
}: {
  field: CodexMcpElicitationFormField;
  value: CodexMcpElicitationFieldValue | undefined;
  invalid: boolean;
  autoFocus: boolean;
  onChange: (value: CodexMcpElicitationFieldValue) => void;
}) {
  switch (field.kind) {
    case "text":
      return (
        <TextField
          field={field}
          value={value}
          invalid={invalid}
          autoFocus={autoFocus}
          onChange={onChange}
        />
      );
    case "number":
      return (
        <NumberField
          field={field}
          value={value}
          invalid={invalid}
          autoFocus={autoFocus}
          onChange={onChange}
        />
      );
    case "singleSelect":
      return (
        <SingleSelectField
          field={field}
          value={value}
          invalid={invalid}
          autoFocus={autoFocus}
          onChange={onChange}
        />
      );
    case "multiSelect":
      return (
        <MultiSelectField
          field={field}
          value={value}
          invalid={invalid}
          autoFocus={autoFocus}
          onChange={onChange}
        />
      );
    case "boolean":
      return (
        <BooleanField
          field={field}
          value={value}
          invalid={invalid}
          autoFocus={autoFocus}
          onChange={onChange}
        />
      );
  }
}

function FormShell({ children }: { children: ReactNode }) {
  return (
    <div className="border-token-border bg-token-input-background/70 text-token-foreground flex flex-col overflow-hidden rounded-2xl border backdrop-blur-sm">
      {children}
    </div>
  );
}

function McpFormRequestCard({
  request,
  model,
  onRespond,
}: {
  request: CodexMcpServerElicitationRequest;
  model: Extract<CodexMcpElicitationFormModel, { kind: "supported" }>;
  onRespond: (
    requestId: CodexProtocolRequestId,
    response: CodexMcpServerElicitationResponse,
  ) => Promise<void>;
}) {
  const [values, setValues] = useState(() =>
    createInitialCodexMcpElicitationFormValues(model.fields),
  );
  const [invalidFieldNames, setInvalidFieldNames] = useState<string[]>([]);

  useEffect(() => {
    setValues(createInitialCodexMcpElicitationFormValues(model.fields));
    setInvalidFieldNames([]);
  }, [model.fields, request.requestId]);

  const respond = (response: CodexMcpServerElicitationResponse) => {
    void onRespond(request.requestId, response);
  };
  const cancel = () => respond(buildCodexMcpServerElicitationResponse("cancel"));
  const decline = () => respond(buildCodexMcpServerElicitationResponse("decline"));

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validateCodexMcpElicitationFormValues(model.fields, values);
    setInvalidFieldNames(result.invalidFieldNames);
    if (!result.content) return;
    respond(buildCodexMcpServerElicitationResponse("accept", result.content));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancel();
  };

  const updateField = (fieldName: string, value: CodexMcpElicitationFieldValue) => {
    setValues((current) => ({
      ...current,
      [fieldName]: value,
    }));
    setInvalidFieldNames((current) => current.filter((name) => name !== fieldName));
  };

  return (
    <FormShell>
      <form className="flex flex-col" onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
        <div
          className={cn(
            "flex items-start justify-between gap-3",
            request.mode === "openai/form" ? "px-4 pt-4 pb-3" : "px-3 pt-3 pb-2",
          )}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <div className="text-sm font-medium">{model.message}</div>
            <div className="text-size-chat-sm text-token-description-foreground">
              {model.serverLabel}
            </div>
          </div>
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground"
            aria-label="Cancel"
            onClick={cancel}
          >
            <CloseIcon className="icon-xs" />
          </button>
        </div>
        <div
          className={cn(
            "flex flex-col",
            request.mode === "openai/form" ? "gap-4 px-4 pb-3" : "gap-3 px-2 pb-2",
          )}
        >
          {model.fields.map((field, index) => (
            <FormField
              key={field.name}
              field={field}
              value={values[field.name]}
              invalid={invalidFieldNames.includes(field.name)}
              autoFocus={index === 0}
              onChange={(value) => updateField(field.name, value)}
            />
          ))}
        </div>
        <div
          className={cn(
            "flex justify-end gap-2 border-t border-token-border/50",
            request.mode === "openai/form" ? "px-4 py-3" : "mt-1 px-2 py-2",
          )}
        >
          <button
            type="button"
            className="inline-flex h-token-button-composer items-center rounded-full border border-transparent px-2 text-sm text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground"
            onClick={decline}
          >
            Skip
          </button>
          <button
            type="submit"
            className="inline-flex h-token-button-composer items-center gap-1 rounded-full bg-token-foreground px-2 text-sm font-medium text-token-dropdown-background hover:bg-token-foreground/80"
          >
            <span>Continue</span>
            <span className="inline-flex items-center rounded-sm bg-token-dropdown-background/15 px-1.5 py-px text-sm leading-none text-token-dropdown-background">
              <span className="font-mono">⏎</span>
            </span>
          </button>
        </div>
      </form>
    </FormShell>
  );
}

function UnsupportedMcpFormRequestCard({
  request,
  model,
  onRespond,
}: {
  request: CodexMcpServerElicitationRequest;
  model: Extract<CodexMcpElicitationFormModel, { kind: "unsupported" }>;
  onRespond: (
    requestId: CodexProtocolRequestId,
    response: CodexMcpServerElicitationResponse,
  ) => Promise<void>;
}) {
  const respond = (action: "decline" | "cancel") => {
    void onRespond(request.requestId, buildCodexMcpServerElicitationResponse(action));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    respond("cancel");
  };

  return (
    <FormShell>
      <div className="flex flex-col" onKeyDown={handleKeyDown}>
        <div className="flex flex-col gap-1 p-4">
          <div className="text-sm font-medium">Nodex can’t show this request yet</div>
          <div className="text-size-chat-sm text-token-description-foreground">
            {model.serverName} requested this form. You can skip it and keep going, or dismiss the
            request.
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-token-border/50 px-4 py-3">
          <button
            type="button"
            className="inline-flex h-token-button-composer items-center rounded-full border border-token-editor-error-foreground px-2 text-sm text-token-editor-error-foreground hover:bg-token-editor-error-foreground/10"
            onClick={() => respond("cancel")}
          >
            Dismiss
          </button>
          <button
            type="button"
            autoFocus
            className="inline-flex h-token-button-composer items-center rounded-full bg-token-foreground px-2 text-sm font-medium text-token-dropdown-background hover:bg-token-foreground/80"
            onClick={() => respond("decline")}
          >
            Skip
          </button>
        </div>
      </div>
    </FormShell>
  );
}

function CompactMcpRequestCard({ request, onRespond }: CodexMcpElicitationRequestCardProps) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const serverName = formatServerName(request.serverName);
  const hasDetails =
    request.mode === "url" ? Boolean(request.url) : request.requestedSchema !== undefined;
  const detailsText = useMemo(() => {
    if (!detailsExpanded) return null;
    if (request.mode === "url") return request.url ?? "";
    return stringifyToolCallValue(request.requestedSchema ?? {});
  }, [detailsExpanded, request.mode, request.requestedSchema, request.url]);

  return (
    <div className="text-size-chat border-token-border bg-token-input-background/70 flex flex-col overflow-hidden rounded-2xl border text-token-foreground backdrop-blur-sm">
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-2 text-token-description-foreground">
          <ToolActivityIcon
            descriptor={resolveMcpElicitationIcon(request)}
            className="icon-sm text-token-text-secondary"
          />
          <span>{serverName}</span>
        </div>
        <div className="font-sans text-base leading-5 font-medium">{request.message}</div>
        {hasDetails ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="font-sans text-size-chat-sm leading-5 flex w-fit items-center gap-1 rounded-full px-1 text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground"
              onClick={() => {
                setDetailsExpanded((current) => !current);
              }}
            >
              <span>Details</span>
              <ChevronDownIcon
                className={cn("transition-transform duration-200", detailsExpanded && "rotate-180")}
              />
            </button>
            {detailsExpanded && detailsText ? (
              <ToolCallCodePanel
                title={request.mode === "url" ? "URL" : "json"}
                preview={buildTextPreview(detailsText, INLINE_TEXT_PREVIEW_MAX_CHARS)}
                getCopyText={() => detailsText}
                getFullText={() => detailsText}
                preClassName="codex-tool-code font-mono text-size-code text-token-description-foreground"
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-token-border/70 px-3 py-2">
        <button
          type="button"
          className="inline-flex h-token-button-composer items-center rounded-full border border-transparent px-2 text-sm text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground"
          onClick={() => {
            void onRespond(request.requestId, buildCodexMcpServerElicitationResponse("decline"));
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="inline-flex h-token-button-composer items-center rounded-full bg-token-foreground px-2 text-sm font-medium text-token-dropdown-background hover:bg-token-foreground/80"
          onClick={() => {
            if (request.mode === "url" && request.url) {
              window.open(request.url, "_blank", "noopener,noreferrer");
            }
            void onRespond(request.requestId, buildCodexMcpServerElicitationResponse("accept"));
          }}
        >
          {request.mode === "url" ? "Open" : "Approve"}
        </button>
      </div>
    </div>
  );
}

export function CodexMcpElicitationRequestCard({
  request,
  onRespond,
}: CodexMcpElicitationRequestCardProps) {
  const formModel = useMemo(() => buildCodexMcpElicitationFormModel(request), [request]);
  if (formModel?.kind === "supported") {
    return <McpFormRequestCard request={request} model={formModel} onRespond={onRespond} />;
  }
  if (formModel?.kind === "unsupported") {
    return (
      <UnsupportedMcpFormRequestCard request={request} model={formModel} onRespond={onRespond} />
    );
  }
  return <CompactMcpRequestCard request={request} onRespond={onRespond} />;
}
