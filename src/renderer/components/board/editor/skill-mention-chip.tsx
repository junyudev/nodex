import { isRemoteSpace } from "@/lib/renderer-space";
import { createContext, useContext, type ReactNode } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import { SkillMentionIcon } from "@/components/shared/skill-mention-icon";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  NodexDialog,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal, type ModalCloseProps } from "@/lib/modal-registry";
import { useOpenSkill } from "@/features/skills/open-skill";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { cn } from "@/lib/utils";
import { inlineSkillMentionClassName } from "@/lib/skill-mention-presentation";
import {
  pageSkillLocationsLabel,
  usePageSkillMentions,
  type PageSkillLocation,
  type PageSkillMention,
} from "@/features/skills/use-page-skill-mentions";
import type { ContentRoutingContext } from "../../../../shared/content-routing-context";
import { skillMentionInlineContentConfig } from "../../../../shared/block-documents/blocknote-schema-config";

export type OpenSkillMention = (input: {
  readonly name: string;
  readonly context: ContentRoutingContext;
}) => void | Promise<void>;

interface SkillMentionPresentation {
  readonly candidates: readonly PageSkillMention[];
  readonly context: ContentRoutingContext;
  readonly openSkill: OpenSkillMention;
}

const SkillMentionContext = createContext<SkillMentionPresentation | null>(null);

export const SkillMentionPresentationProvider = SkillMentionContext.Provider;
export const useSkillMentionPresentation = () => useContext(SkillMentionContext);

function SkillFileChooser({
  name,
  files,
  open,
  onClose,
}: ModalCloseProps & {
  readonly name: string;
  readonly files: readonly (readonly PageSkillLocation[])[];
  readonly open: (location: PageSkillLocation) => void;
}) {
  return (
    <NodexDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <NodexDialogContent>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>Open {`$${name}`}</NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogBody className="max-h-72 overflow-auto">
            {files.map((locations) => {
              const location = locations[0]!;
              return (
                <button
                  type="button"
                  key={JSON.stringify([location.hostId, location.path])}
                  className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left hover:bg-token-foreground/5"
                  onClick={() => {
                    onClose();
                    open(location);
                  }}
                >
                  <span className="truncate text-sm">{pageSkillLocationsLabel(locations)}</span>
                  <span className="max-w-full truncate text-xs text-token-text-secondary">
                    {location.path}
                  </span>
                </button>
              );
            })}
          </NodexDialogBody>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

/** Bind skill discovery to a Page route and let its surface choose the open action. */
export function PageSkillMentionProvider({
  context,
  openSkill,
  children,
}: {
  readonly context: ContentRoutingContext;
  readonly openSkill?: OpenSkillMention;
  readonly children: ReactNode;
}) {
  const router = useFileReferenceRouter();
  const appHandle = useScopeHandle(appScope);
  const candidates = usePageSkillMentions(context, router.hostId, true);
  const openSkillPage = useOpenSkill();
  const openFile = (location: PageSkillLocation, name: string) => {
    // A host catalog may supply a display path even when this surface has only a local file router.
    if (isRemoteSpace() && location.hostId === "local") {
      toast.danger("Skill files open on the Space host");
      return;
    }
    // The skill's own page when this window can show it; its SKILL.md as a file otherwise.
    void openSkillPage({ hostId: location.hostId, name, path: location.path })
      .then(
        (opened) =>
          opened ||
          router.open({ path: location.path }, { hostId: location.hostId, title: "SKILL.md" }),
      )
      .then((opened) => {
        if (!opened) toast.danger("Could not open the skill");
      })
      .catch(() => toast.danger("Could not open the skill"));
  };
  const openDefault: OpenSkillMention = ({ name }) => {
    const locations = candidates.find((skill) => skill.name === name)?.locations ?? [];
    const byFile = new Map<string, PageSkillLocation[]>();
    for (const location of locations) {
      const key = JSON.stringify([location.hostId, location.path]);
      const group = byFile.get(key) ?? [];
      group.push(location);
      byFile.set(key, group);
    }
    const files = [...byFile.values()];
    if (files.length === 1) openFile(files[0]![0]!, name);
    if (files.length > 1) {
      openModal(appHandle, SkillFileChooser, {
        name,
        files,
        open: (location: PageSkillLocation) => openFile(location, name),
      });
    }
  };
  return (
    <SkillMentionPresentationProvider
      value={{ context, candidates, openSkill: openSkill ?? openDefault }}
    >
      {children}
    </SkillMentionPresentationProvider>
  );
}

export function SkillMentionChip({ name }: { readonly name: string }) {
  const presentation = useSkillMentionPresentation();
  const skill = presentation?.candidates.find((candidate) => candidate.name === name);
  const label = skill?.displayName ?? `$${name}`;
  const tooltip = skill ? (
    <div className="flex max-w-64 flex-col gap-0.5">
      <span className="font-medium">{skill.displayName}</span>
      {skill.description && <span>{skill.description}</span>}
      <span>{pageSkillLocationsLabel(skill.locations)}</span>
    </div>
  ) : (
    `$${name} is unavailable in this context.`
  );
  const open =
    skill && presentation
      ? () => {
          void presentation.openSkill({ name, context: presentation.context });
        }
      : undefined;
  const className = cn(
    inlineSkillMentionClassName,
    "items-center max-w-[18rem]",
    !open && "cursor-default",
  );
  const content = (
    <>
      <SkillMentionIcon iconUrl={skill?.iconUrl} brandColor={skill?.brandColor} />
      <span className="truncate">{label}</span>
    </>
  );
  return (
    <NodexTooltip tooltipContent={tooltip}>
      {open ? (
        <button
          type="button"
          className={className}
          contentEditable={false}
          data-inline-reference-chip="true"
          data-skill-mention={name}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
        >
          {content}
        </button>
      ) : (
        <span
          className={className}
          contentEditable={false}
          data-inline-reference-chip="true"
          data-skill-mention={name}
        >
          {content}
        </span>
      )}
    </NodexTooltip>
  );
}

export function createSkillMentionInlineContentSpec() {
  return createReactInlineContentSpec(skillMentionInlineContentConfig, {
    render: ({ inlineContent }) => <SkillMentionChip name={inlineContent.props.name} />,
    toExternalHTML: ({ inlineContent }) => <span>{`$${inlineContent.props.name}`}</span>,
  });
}
