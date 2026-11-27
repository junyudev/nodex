import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { toastFailure } from "@/lib/failure-toast";
import { NodexButton, NodexIconButton, NodexSwitch } from "@/components/ui/button";
import { NodexPopover, NodexPopoverAnchor, NodexPopoverContent } from "@/components/ui/popover";
import {
  CodeIcon,
  NfmSideMenuTextBlockIcon,
  NodexLogoMarkIcon,
  TextActionCommentIcon,
} from "@/components/shared/icons";
import { TableLightIcon } from "@/components/shared/icons/page-chrome-icons";
import { usePageDiscussionsControllerContext } from "@/features/page-discussions/page-discussions-context";
import { DiscussionComposer } from "@/features/page-discussions/view/discussion-composer";
import type {
  VisualDatumGeometry,
  VisualPageContext,
  VisualRect,
} from "../../../shared/visual/bridge";
import {
  visualRowKey,
  type VisualFigure,
  type VisualKey,
  type VisualParam,
  type VisualRewrite,
  type VisualRow,
  type VisualScalar,
} from "../../../shared/visual/contract";
import type { VisualFrameState } from "./use-visual-frame";
import { editVisualSource, refreshVisualQuery } from "./visual-source";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { useEscapeToLeave } from "./visual-block-area";
import { findAnchoredDatum, publishVisualDatumGeometry } from "./visual-datum-geometry";
import type { DiscussionView } from "@/features/page-discussions/discussion-view-model";

type ChromeMode = "view" | "comment" | "text";

interface ComposerTarget {
  readonly rect: VisualRect;
  readonly datum: VisualDatumGeometry | null;
  readonly toNodex: boolean;
}

const sameKey = (a: VisualKey, b: VisualKey) => JSON.stringify(a) === JSON.stringify(b);

/** The row and value a data point stands for, from the rows the guest rendered. */
function datumValue(state: VisualFrameState, datum: VisualDatumGeometry) {
  const figure = state.figures[datum.figure];
  const source = figure?.sources[datum.source];
  const rows = state.rows?.[datum.figure]?.[datum.source] ?? [];
  if (!source) return null;
  const row = rows.find((candidate) => {
    const key = visualRowKey(candidate, source.key);
    return key !== undefined && sameKey(key, datum.key);
  });
  if (!row) return null;
  const keyText = Array.isArray(datum.key) ? datum.key.join(" · ") : String(datum.key);
  const value = datum.field ? row[datum.field] : null;
  return { keyText, field: datum.field ?? null, value };
}

/** Where this Visual draws the data points that open Discussions are anchored to. */
function anchoredData(
  datum: readonly VisualDatumGeometry[],
  views: readonly DiscussionView[],
  blockId: string,
): { readonly discussionId: string; readonly rect: VisualRect }[] {
  return views.flatMap((view) => {
    const { anchor } = view;
    if (view.resolved || anchor.kind !== "datum" || anchor.blockId !== blockId) return [];
    const match = findAnchoredDatum(datum, anchor);
    return match ? [{ discussionId: view.id, rect: match.rect }] : [];
  });
}

function hitTest<T extends { rect: VisualRect }>(
  items: readonly T[],
  x: number,
  y: number,
): T | null {
  // Smaller targets win, so a bar inside a highlighted band is still reachable.
  let best: T | null = null;
  for (const item of items) {
    const { rect } = item;
    if (x < rect.x || y < rect.y || x > rect.x + rect.width || y > rect.y + rect.height) continue;
    if (!best || rect.width * rect.height < best.rect.width * best.rect.height) best = item;
  }
  return best;
}

/**
 * Everything a person does with a Visual besides reading it: hover a data point, comment on it or
 * on the whole figure, ask Nodex, edit its words in place, move its controls, edit its data, and
 * open its source. Every change rewrites one literal in the source, so it is an ordinary
 * attributed edit, or a Suggested edit while the person is suggesting.
 */
export function VisualBlockChrome({
  blockId,
  source,
  state,
  page,
  editable,
  sourceShown,
  onToggleSource,
  onWriteSource,
  children,
}: {
  readonly blockId: string;
  readonly source: string;
  readonly state: VisualFrameState | null;
  /** The Page a query source runs against; absent outside a Page. */
  readonly page: VisualPageContext | null;
  readonly editable: boolean;
  readonly sourceShown: boolean;
  readonly onToggleSource: () => void;
  readonly onWriteSource: (next: string) => void;
  readonly children: React.ReactNode;
}) {
  const intl = useIntl();
  const discussions = usePageDiscussionsControllerContext();
  const suggesting = discussions?.suggesting ?? false;
  const [mode, setMode] = useState<ChromeMode>("view");
  const [dataOpen, setDataOpen] = useState(false);
  const [hover, setHover] = useState<VisualDatumGeometry | null>(null);
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const [editingText, setEditingText] = useState<{
    rect: VisualRect;
    start: number;
    end: number;
  } | null>(null);
  const frame = state?.frame ?? null;
  const [frameElement, setFrameElement] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!frameElement || !frame) return;
    publishVisualDatumGeometry(blockId, { element: frameElement, datum: frame.datum });
    return () => publishVisualDatumGeometry(blockId, null);
  }, [blockId, frame, frameElement]);
  useEscapeToLeave(mode !== "view", () => setMode("view"));

  const rewrite = async (change: VisualRewrite) => {
    const result = await editVisualSource(source, change);
    if (!result.ok) {
      toastFailure(
        intl.formatMessage({
          id: "visual.chrome.rewriteFailed",
          defaultMessage: "Couldn't change the Visual",
        }),
        result.diagnostics[0]?.message,
      );
      return;
    }
    if (suggesting && discussions) discussions.suggestVisualSource(blockId, source, result.source);
    else onWriteSource(result.source);
  };

  const localPoint = (event: ReactPointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!frame) return;
    const { x, y } = localPoint(event);
    const next = hitTest(frame.datum, x, y);
    setHover((current) => (current === next ? current : next));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!frame) return;
    const { x, y } = localPoint(event);
    if (mode === "view") {
      // Like highlighted text, a data point with a Discussion opens it.
      const hit = hitTest(anchored, x, y);
      if (hit) discussions?.setActiveId(hit.discussionId);
      return;
    }
    event.preventDefault();
    if (mode === "comment") {
      const datum = hitTest(frame.datum, x, y);
      setComposer({
        rect: datum?.rect ?? { x, y, width: 1, height: 1 },
        datum,
        toNodex: false,
      });
      setMode("view");
      return;
    }
    const text = hitTest(frame.text, x, y);
    if (text) setEditingText({ rect: text.rect, start: text.span.start, end: text.span.end });
  };

  const hovered = hover && state ? datumValue(state, hover) : null;
  const anchored =
    frame && discussions ? anchoredData(frame.datum, discussions.views, blockId) : [];
  const toolbarLabel = (id: string, defaultMessage: string) =>
    intl.formatMessage({ id, defaultMessage });

  return (
    <div className="group/visual relative" data-visual-chrome={mode}>
      <div
        ref={setFrameElement}
        className={cn("relative", mode !== "view" && "cursor-crosshair")}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onPointerDownCapture={onPointerDown}
      >
        {children}
        {frame ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {mode === "text"
              ? frame.text.map((text) => (
                  <span
                    key={`${text.span.start}:${text.span.end}`}
                    className="absolute rounded-[3px] ring-1 ring-(--color-text-info)/60"
                    style={rectStyle(text.rect, 2)}
                  />
                ))
              : null}
            {anchored.map(({ discussionId, rect }) => (
              <span
                key={discussionId}
                className={cn(
                  "absolute rounded-[3px]",
                  discussionId === discussions?.activeId
                    ? "ring-2 ring-(--color-token-charts-yellow) ring-offset-1 ring-offset-(--background)"
                    : "ring-[1.5px] ring-(--color-token-charts-yellow)/65",
                )}
                style={rectStyle(rect, 1)}
              />
            ))}
            {hover ? (
              <span
                className={cn(
                  "absolute rounded-[3px]",
                  mode === "comment"
                    ? "ring-2 ring-(--color-token-charts-yellow)"
                    : "ring-1 ring-token-foreground/30",
                )}
                style={rectStyle(hover.rect, 1)}
              />
            ) : null}
          </div>
        ) : null}
        {hover && hovered && mode !== "text" ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md bg-token-dropdown-background px-2 py-1 text-xs whitespace-nowrap shadow-lg ring-[0.5px] ring-token-border"
            style={{ left: hover.rect.x + hover.rect.width / 2, top: hover.rect.y - 6 }}
          >
            <span className="text-token-description-foreground">{hovered.keyText}</span>
            {hovered.field ? (
              <>
                <span className="text-token-description-foreground"> · {hovered.field} </span>
                <span className="font-medium tabular-nums">{formatValue(hovered.value)}</span>
              </>
            ) : null}
          </div>
        ) : null}
        {composer && discussions ? (
          <NodexPopover open onOpenChange={(open) => (open ? undefined : setComposer(null))}>
            <NodexPopoverAnchor>
              <span className="pointer-events-none absolute" style={rectStyle(composer.rect, 0)} />
            </NodexPopoverAnchor>
            <NodexPopoverContent
              side="bottom"
              align="start"
              className="w-[min(22rem,calc(100vw-24px))] rounded-xl bg-token-dropdown-background p-1.5 shadow-xl-spread ring-[0.5px] ring-token-border"
            >
              <DiscussionComposer
                autoFocus
                placeholder={intl.formatMessage(
                  composer.toNodex
                    ? {
                        id: "visual.chrome.askPlaceholder",
                        defaultMessage: "Ask Nodex about this figure…",
                      }
                    : composer.datum
                      ? {
                          id: "visual.chrome.commentDatumPlaceholder",
                          defaultMessage: "Comment on this data point…",
                        }
                      : {
                          id: "visual.chrome.commentPlaceholder",
                          defaultMessage: "Comment on this figure…",
                        },
                )}
                members={discussions.members}
                sendToNodex={composer.toNodex || discussions.sendToNodex}
                onSendToNodexChange={composer.toNodex ? () => {} : discussions.setSendToNodex}
                onCancel={() => setComposer(null)}
                onSubmit={({ bodyMarkdown, toNodex }) => {
                  const datum = composer.datum;
                  discussions.createAnchoredDiscussion({
                    anchor: datum
                      ? {
                          kind: "datum",
                          blockId,
                          source: datum.source,
                          key: datum.key,
                          field: datum.field ?? null,
                        }
                      : { kind: "blocks", blockIds: [blockId] },
                    body: bodyMarkdown,
                    toNodex,
                  });
                  setComposer(null);
                }}
              />
            </NodexPopoverContent>
          </NodexPopover>
        ) : null}
        {editingText ? (
          <TextLiteralEditor
            rect={editingText.rect}
            initial={literalText(source, editingText.start, editingText.end)}
            onCancel={() => setEditingText(null)}
            onCommit={(value) => {
              setEditingText(null);
              void rewrite({
                kind: "text",
                span: { start: editingText.start, end: editingText.end },
                value,
              });
            }}
          />
        ) : null}
      </div>

      <div
        contentEditable={false}
        className={cn(
          "absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-lg bg-token-dropdown-background/95 p-0.5 shadow-sm ring-[0.5px] ring-token-border",
          "opacity-0 group-focus-within/visual:opacity-100 group-hover/visual:opacity-100",
          (mode !== "view" || dataOpen || sourceShown) && "opacity-100",
        )}
      >
        {state?.figures.some((figure) => Object.keys(figure.sources).length > 0) ? (
          <NodexIconButton
            size="xs"
            icon={TableLightIcon}
            active={dataOpen}
            ariaLabel={toolbarLabel("visual.chrome.data", "Data")}
            onClick={() => setDataOpen((open) => !open)}
          />
        ) : null}
        {editable && frame && frame.text.length > 0 ? (
          <NodexIconButton
            size="xs"
            icon={NfmSideMenuTextBlockIcon}
            active={mode === "text"}
            ariaLabel={toolbarLabel("visual.chrome.editText", "Edit text")}
            onClick={() => setMode((current) => (current === "text" ? "view" : "text"))}
          />
        ) : null}
        {discussions ? (
          <>
            <NodexIconButton
              size="xs"
              icon={TextActionCommentIcon}
              active={mode === "comment"}
              ariaLabel={toolbarLabel(
                "visual.chrome.comment",
                "Comment on a data point or the figure",
              )}
              onClick={() => setMode((current) => (current === "comment" ? "view" : "comment"))}
            />
            <NodexIconButton
              size="xs"
              icon={MonochromeNodexIcon}
              ariaLabel={toolbarLabel("visual.chrome.askNodex", "Ask Nodex about this figure")}
              onClick={() =>
                setComposer({
                  rect: { x: 0, y: 0, width: frame?.width ?? 1, height: 1 },
                  datum: null,
                  toNodex: true,
                })
              }
            />
          </>
        ) : null}
        <NodexIconButton
          size="xs"
          icon={CodeIcon}
          active={sourceShown}
          ariaLabel={toolbarLabel("visual.chrome.source", "Source")}
          onClick={onToggleSource}
        />
      </div>

      {state ? (
        <VisualParamsStrip
          figures={state.figures}
          editable={editable}
          onChange={(figure, param, value) => void rewrite({ kind: "param", figure, param, value })}
        />
      ) : null}
      {dataOpen && state ? (
        <VisualDataPanel
          state={state}
          editable={editable}
          onEdit={(change) => void rewrite(change)}
          onRefresh={
            page && editable
              ? async (figure, sourceName) => {
                  const result = await refreshVisualQuery({ source, page, figure, sourceName });
                  if (!result.ok) {
                    toastFailure(
                      intl.formatMessage({
                        id: "visual.data.refreshFailed",
                        defaultMessage: "Couldn't refresh the data",
                      }),
                      result.message,
                    );
                    return;
                  }
                  await rewrite({
                    kind: "query",
                    figure,
                    source: sourceName,
                    data: result.rows,
                    refreshedAt: result.refreshedAt,
                  });
                }
              : null
          }
        />
      ) : null}
      {mode !== "view" ? (
        <p className="px-[22px] pt-2 text-xs text-token-description-foreground">
          {mode === "comment" ? (
            <FormattedMessage
              id="visual.chrome.commentHint"
              defaultMessage="Choose a data point, or anywhere on the figure. Esc to cancel."
            />
          ) : (
            <FormattedMessage
              id="visual.chrome.textHint"
              defaultMessage="Choose a label to rewrite it."
            />
          )}
        </p>
      ) : null}
    </div>
  );
}

function MonochromeNodexIcon({ className }: { readonly className?: string }) {
  return <NodexLogoMarkIcon className={className} monochrome />;
}

function rectStyle(rect: VisualRect, outset: number) {
  return {
    left: rect.x - outset,
    top: rect.y - outset,
    width: rect.width + outset * 2,
    height: rect.height + outset * 2,
  };
}

function formatValue(value: unknown): string {
  if (typeof value === "number") return value.toLocaleString();
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The words of a text literal, without the quotes a string literal carries in source. */
function literalText(source: string, start: number, end: number): string {
  const raw = source.slice(start, end);
  const quoted = /^(["'`])([\s\S]*)\1$/u.exec(raw);
  return quoted ? quoted[2]! : raw.trim();
}

function TextLiteralEditor({
  rect,
  initial,
  onCommit,
  onCancel,
}: {
  readonly rect: VisualRect;
  readonly initial: string;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}) {
  const intl = useIntl();
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      aria-label={intl.formatMessage({
        id: "visual.chrome.labelText",
        defaultMessage: "Label text",
      })}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => (value !== initial ? onCommit(value) : onCancel())}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          if (value !== initial) onCommit(value);
          else onCancel();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      className="absolute z-20 rounded-[4px] bg-token-main-surface-primary px-1 text-sm shadow-md ring-1 ring-(--color-text-info) outline-none"
      style={{
        left: rect.x - 4,
        top: rect.y - 3,
        minWidth: Math.max(rect.width + 8, 80),
        height: rect.height + 6,
      }}
    />
  );
}

function VisualParamsStrip({
  figures,
  editable,
  onChange,
}: {
  readonly figures: readonly VisualFigure[];
  readonly editable: boolean;
  readonly onChange: (figure: number, param: string, value: VisualScalar) => void;
}) {
  const controls = figures.flatMap((figure, index) =>
    Object.entries(figure.params).map(([name, param]) => ({ figure: index, name, param })),
  );
  if (controls.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-[22px] pt-3 text-xs text-token-text-secondary">
      {controls.map(({ figure, name, param }) => (
        <VisualParamControl
          key={`${figure}:${name}`}
          name={name}
          param={param}
          disabled={!editable}
          onChange={(value) => onChange(figure, name, value)}
        />
      ))}
    </div>
  );
}

function VisualParamControl({
  name,
  param,
  disabled,
  onChange,
}: {
  readonly name: string;
  readonly param: VisualParam;
  readonly disabled: boolean;
  readonly onChange: (value: VisualScalar) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  switch (param.kind) {
    case "range":
      return (
        <label className="flex items-center gap-2">
          <span>{name}</span>
          <input
            type="range"
            min={param.min}
            max={param.max}
            step={param.step ?? "any"}
            value={draft ?? param.value}
            disabled={disabled}
            onChange={(event) => setDraft(Number(event.target.value))}
            onPointerUp={() => {
              if (draft !== null && draft !== param.value) onChange(draft);
              setDraft(null);
            }}
            onKeyUp={() => {
              if (draft !== null && draft !== param.value) onChange(draft);
              setDraft(null);
            }}
            className="w-28 accent-(--color-text-info)"
          />
          <span className="w-8 text-right tabular-nums text-token-foreground">
            {draft ?? param.value}
          </span>
        </label>
      );
    case "select":
      return (
        <div role="radiogroup" aria-label={name} className="flex items-center gap-1">
          <span className="mr-1">{name}</span>
          {param.options.map((option) => (
            <button
              key={String(option)}
              type="button"
              role="radio"
              aria-checked={option === param.value}
              disabled={disabled}
              onClick={() => onChange(option)}
              className={cn(
                "h-6 cursor-interaction rounded-md px-2",
                option === param.value
                  ? "bg-token-foreground/10 text-token-foreground"
                  : "hover:bg-token-foreground/5",
              )}
            >
              {String(option)}
            </button>
          ))}
        </div>
      );
    case "toggle":
      return (
        <label className="flex items-center gap-2">
          <span>{name}</span>
          <NodexSwitch
            size="compact"
            checked={param.value}
            disabled={disabled}
            ariaLabel={name}
            onCheckedChange={onChange}
          />
        </label>
      );
  }
}

const DATA_ROW_LIMIT = 200;

function VisualDataPanel({
  state,
  editable,
  onEdit,
  onRefresh,
}: {
  readonly state: VisualFrameState;
  readonly editable: boolean;
  readonly onEdit: (change: VisualRewrite) => void;
  /** Runs a query source again with the person's access; absent where it cannot be saved. */
  readonly onRefresh: ((figure: number, sourceName: string) => Promise<void>) | null;
}) {
  const intl = useIntl();
  const [refreshing, setRefreshing] = useState(false);
  const [openedAtMs] = useState(Date.now);
  const tabs = state.figures.flatMap((figure, index) =>
    Object.entries(figure.sources).map(([name, source]) => ({ figure: index, name, source })),
  );
  const [selected, setSelected] = useState(0);
  const tab = tabs[Math.min(selected, tabs.length - 1)];
  if (!tab) return null;
  const rows: readonly VisualRow[] = state.rows?.[tab.figure]?.[tab.name] ?? [];
  const columns = [...new Set(rows.slice(0, DATA_ROW_LIMIT).flatMap((row) => Object.keys(row)))];
  const rowsEditable = editable && (tab.source.kind === "data" || tab.source.kind === "query");
  return (
    <div className="mx-[22px] mt-3 overflow-hidden rounded-lg ring-[0.5px] ring-token-border">
      <div className="flex items-center gap-1 border-b-[0.5px] border-token-border bg-token-foreground/[0.02] px-1.5 py-1 text-xs">
        {tabs.map((candidate, index) => (
          <button
            key={`${candidate.figure}:${candidate.name}`}
            type="button"
            onClick={() => setSelected(index)}
            className={cn(
              "h-6 cursor-interaction rounded-md px-2 font-mono",
              index === selected
                ? "bg-token-foreground/10"
                : "text-token-description-foreground hover:bg-token-foreground/5",
            )}
          >
            {candidate.name}
          </button>
        ))}
        <span className="ml-auto pr-1 text-token-description-foreground">
          {tab.source.kind === "query"
            ? intl.formatMessage(
                {
                  id: "visual.data.queryRefreshed",
                  defaultMessage: "SQL result · {count} rows · refreshed {when}",
                },
                {
                  count: rows.length,
                  when: formatCompactRelativeTime(Date.parse(tab.source.refreshedAt), openedAtMs),
                },
              )
            : tab.source.kind === "file"
              ? intl.formatMessage({
                  id: "visual.data.file",
                  defaultMessage: "From a File of this Page",
                })
              : tab.source.kind === "table"
                ? intl.formatMessage({
                    id: "visual.data.table",
                    defaultMessage: "From a table on this Page",
                  })
                : intl.formatMessage(
                    {
                      id: "visual.data.inline",
                      defaultMessage: "{count, plural, one {# row} other {# rows}}",
                    },
                    { count: rows.length },
                  )}
        </span>
        {tab.source.kind === "query" && onRefresh ? (
          <NodexButton
            variant="ghostSecondary"
            size="xs"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void onRefresh(tab.figure, tab.name).finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? (
              <FormattedMessage id="visual.data.refreshing" defaultMessage="Refreshing…" />
            ) : (
              <FormattedMessage id="visual.data.refresh" defaultMessage="Refresh" />
            )}
          </NodexButton>
        ) : null}
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-token-main-surface-primary">
            <tr>
              {columns.map((column) => (
                <th
                  key={column}
                  className="border-b-[0.5px] border-token-border px-2 py-1 text-left font-medium text-token-description-foreground"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, DATA_ROW_LIMIT).map((row, index) => {
              const key = visualRowKey(row, tab.source.key);
              return (
                <tr
                  key={key === undefined ? index : JSON.stringify(key)}
                  className="hover:bg-token-foreground/[0.03]"
                >
                  {columns.map((column) => (
                    <DataCell
                      key={column}
                      value={row[column]}
                      editable={
                        rowsEditable &&
                        key !== undefined &&
                        !keyColumns(tab.source.key).includes(column)
                      }
                      onCommit={(value) =>
                        key !== undefined &&
                        onEdit({
                          kind: "row",
                          figure: tab.figure,
                          source: tab.name,
                          key,
                          field: column,
                          value,
                        })
                      }
                    />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > DATA_ROW_LIMIT ? (
          <p className="px-2 py-1.5 text-xs text-token-description-foreground">
            <FormattedMessage
              id="visual.data.more"
              defaultMessage="{count, plural, one {# more row} other {# more rows}}"
              values={{ count: rows.length - DATA_ROW_LIMIT }}
            />
          </p>
        ) : null}
      </div>
    </div>
  );
}

const keyColumns = (key: string | string[]) => (typeof key === "string" ? [key] : key);

function DataCell({
  value,
  editable,
  onCommit,
}: {
  readonly value: unknown;
  readonly editable: boolean;
  readonly onCommit: (value: VisualScalar) => void;
}) {
  const intl = useIntl();
  const [draft, setDraft] = useState<string | null>(null);
  const text = formatValue(value);
  if (draft !== null) {
    const commit = () => {
      setDraft(null);
      if (draft === text) return;
      const numeric =
        typeof value === "number" && draft.trim() !== "" && Number.isFinite(Number(draft));
      onCommit(numeric ? Number(draft) : draft);
    };
    return (
      <td className="border-b-[0.5px] border-token-border p-0">
        <input
          autoFocus
          value={draft}
          aria-label={intl.formatMessage({ id: "visual.chrome.value", defaultMessage: "Value" })}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setDraft(null);
          }}
          className="w-full bg-token-foreground/5 px-2 py-1 tabular-nums outline-none"
        />
      </td>
    );
  }
  return (
    <td
      className={cn(
        "border-b-[0.5px] border-token-border px-2 py-1 tabular-nums",
        editable && "cursor-text",
      )}
      onDoubleClick={editable ? () => setDraft(text === "—" ? "" : text) : undefined}
    >
      {text}
    </td>
  );
}
