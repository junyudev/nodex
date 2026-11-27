import { FormattedMessage, useIntl } from "@/lib/i18n";
import { PositionPopover, useBlockNoteEditor } from "@blocknote/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AskAiIcon, UpArrowIcon } from "@/components/shared/icons";
import { NodexFloatingLayerProvider } from "@/components/ui/floating-layer";
import {
  AgentConfigInlineContentView,
  normalizeAgentConfigProps,
  type AgentConfigProps,
} from "./agent-config-chip";
import {
  createNfmEditorFloatingMiddleware,
  NFM_EDITOR_FLOATING_UI_PORTAL_ELEMENT,
  NFM_EDITOR_FLOATING_UI_Z_INDEX,
} from "./nfm-blocknote-floating-ui";

/** What a person asked Nodex to do at one place in the Page. */
export interface NfmPageAskSubmission {
  /** The empty Block the request was typed in; it becomes the pending block. */
  readonly blockId: string;
  readonly request: string;
  /** Empty fields inherit the Agent Nodex runs with by default. */
  readonly agentConfig: AgentConfigProps;
}

export interface NfmPageAskController {
  /** Opens the composer on the Block that holds the caret. */
  readonly open: () => void;
}

const NfmPageAskContext = createContext<NfmPageAskController | null>(null);

/** Null when this editor cannot run Asks, such as a read-only preview. */
export function useNfmPageAsk(): NfmPageAskController | null {
  return useContext(NfmPageAskContext);
}

interface OpenAsk {
  readonly blockId: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Owns the in-place Ask composer for one Page editor. The composer floats at the caret's Block;
 * submitting hands the request to `onSubmit`, which turns that Block into a pending block and
 * starts the Ask. Escape, or pointing elsewhere, closes it without changing the Page.
 */
export function NfmPageAskProvider({
  enabled,
  onSubmit,
  children,
}: {
  readonly enabled: boolean;
  readonly onSubmit: (submission: NfmPageAskSubmission) => void;
  readonly children: ReactNode;
}) {
  const editor = useBlockNoteEditor();
  const [openAsk, setOpenAsk] = useState<OpenAsk | null>(null);
  const controller = useMemo<NfmPageAskController | null>(
    () =>
      enabled
        ? {
            open: () => {
              const block = editor.getTextCursorPosition().block;
              const selection = editor.prosemirrorState.selection;
              setOpenAsk({ blockId: block.id, from: selection.from, to: selection.to });
            },
          }
        : null,
    [editor, enabled],
  );
  return (
    <NfmPageAskContext value={controller}>
      {children}
      {openAsk ? (
        <PageAskPanel
          ask={openAsk}
          onClose={() => setOpenAsk(null)}
          onSubmit={(request, agentConfig) => {
            setOpenAsk(null);
            onSubmit({ blockId: openAsk.blockId, request, agentConfig });
          }}
        />
      ) : null}
    </NfmPageAskContext>
  );
}

const PANEL_FLOATING_OPTIONS = {
  useFloatingOptions: {
    open: true,
    placement: "bottom-start" as const,
    strategy: "fixed" as const,
    middleware: createNfmEditorFloatingMiddleware(6),
  },
  focusManagerProps: { disabled: true },
  elementProps: { style: { zIndex: NFM_EDITOR_FLOATING_UI_Z_INDEX } },
};

function PageAskPanel({
  ask,
  onClose,
  onSubmit,
}: {
  readonly ask: OpenAsk;
  readonly onClose: () => void;
  readonly onSubmit: (request: string, agentConfig: AgentConfigProps) => void;
}) {
  const intl = useIntl();
  const editor = useBlockNoteEditor();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");
  const [agentConfig, setAgentConfig] = useState<AgentConfigProps>(() =>
    normalizeAgentConfigProps(undefined),
  );

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (panelRef.current?.contains(event.target)) return;
      // The Agent config popover portals outside the panel; it belongs to this composer.
      if (event.target instanceof Element && event.target.closest("[data-slot='popover-content']"))
        return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  const submit = () => {
    const request = draft.trim();
    if (request) onSubmit(request, agentConfig);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      editor.focus();
    }
  };

  return (
    <PositionPopover
      position={{ from: ask.from, to: ask.to }}
      portalElement={NFM_EDITOR_FLOATING_UI_PORTAL_ELEMENT}
      {...PANEL_FLOATING_OPTIONS}
    >
      <NodexFloatingLayerProvider zIndex={NFM_EDITOR_FLOATING_UI_Z_INDEX}>
        <div
          ref={panelRef}
          role="dialog"
          aria-label={intl.formatMessage({
            id: "editor.nfmPageAsk.title",
            defaultMessage: "Ask Nodex",
          })}
          data-nfm-page-ask="compose"
          onKeyDown={onKeyDown}
          className="pointer-events-auto flex w-[min(34rem,calc(100vw-24px))] flex-col gap-1 rounded-[14px] bg-token-dropdown-background p-1.5 text-sm text-token-foreground shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-xl"
        >
          <form
            className="flex min-h-8 items-start gap-2 pr-1 pl-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <AskAiIcon className="mt-2 size-3.5 shrink-0 text-token-description-foreground" />
            <textarea
              autoFocus
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              aria-label={intl.formatMessage({
                id: "editor.nfmPageAsk.requestLabel",
                defaultMessage: "What should Nodex do here",
              })}
              placeholder={intl.formatMessage({
                id: "editor.nfmPageAsk.placeholder",
                defaultMessage: "Ask Nodex to write, chart or find something here…",
              })}
              className="max-h-48 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1.5 leading-5 outline-none [field-sizing:content] placeholder:text-token-description-foreground"
            />
            <button
              type="submit"
              aria-label={intl.formatMessage({
                id: "editor.nfmPageAsk.ask",
                defaultMessage: "Ask",
              })}
              disabled={!draft.trim()}
              className="mt-1 flex size-6 shrink-0 cursor-interaction items-center justify-center rounded-full bg-composer-primary text-composer-primary disabled:cursor-default disabled:opacity-40"
            >
              <UpArrowIcon className="size-3.5" />
            </button>
          </form>
          <div className="flex items-center gap-1 px-1.5 pb-0.5 text-xs text-token-description-foreground">
            <AgentConfigInlineContentView
              inlineContent={{ props: agentConfig }}
              updateInlineContent={(update) => setAgentConfig(update.props)}
            />
            <span className="min-w-0 flex-1 truncate">
              <FormattedMessage
                id="editor.nfmPageAsk.hint"
                defaultMessage="Nodex works in a chat and puts the result here"
              />
            </span>
          </div>
        </div>
      </NodexFloatingLayerProvider>
    </PositionPopover>
  );
}
