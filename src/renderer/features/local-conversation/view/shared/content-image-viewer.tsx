import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { showConversationImageMenu } from "@/components/conversation-media/conversation-image-menu";
import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import {
  conversationMediaFilename,
  createConversationImageActions,
  downloadImageDataUrl,
  fetchImageSourceAsDataUrl,
  useContentImage,
  useContentImageScope,
  type ContentImage,
} from "@/lib/content-image";
import { classifyImageSource } from "../../../../../shared/image-source";

/**
 * An image's actions at the pointer, as every image in a chat has them, for an image read from
 * `source` and shown from `url`; nothing shows until the image has loaded. A pending action ends
 * once the image shows other bytes, leaves, or its chat no longer shows this content.
 */
export function useContentImageMenu(source: string, url: string | null, alt: string) {
  const scope = useContentImageScope();
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!url) return;
    return () => lifetime.current?.abort();
  }, [url]);
  return (event: ReactMouseEvent<HTMLElement>) => {
    if (!url) return;
    lifetime.current?.abort();
    const controller = new AbortController();
    lifetime.current = controller;
    const image = event.currentTarget.querySelector("img") ?? undefined;
    const classified = classifyImageSource(source);
    const isCurrent = () =>
      !controller.signal.aborted && (image?.isConnected ?? true) && scope.isCurrent();
    const filename = conversationMediaFilename(source);
    const actions = createConversationImageActions({
      url,
      image,
      raw: source,
      alt,
      hostId: scope.hostId,
      threadId: scope.conversationId ?? undefined,
      path: classified.kind === "path" ? classified.path : null,
      composerTarget: scope.composerTarget ?? undefined,
      isCurrent,
      signal: controller.signal,
      download: async () => {
        const data = await fetchImageSourceAsDataUrl(url, undefined, {
          signal: controller.signal,
          isCurrent,
          image,
        });
        if (isCurrent()) await downloadImageDataUrl(data, filename);
      },
    });
    if (showConversationImageMenu(actions, { x: event.clientX, y: event.clientY }, isCurrent)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
}

/** One shown image as its viewer knows it, for as long as it shows these bytes. */
interface ViewerImage {
  readonly trigger: HTMLButtonElement;
  readonly src: string;
  readonly downloadSrc?: string;
  readonly alt: string;
  readonly isCurrent: () => boolean;
}

interface ViewerGroup {
  readonly register: (key: string, image: ViewerImage) => () => void;
  readonly open: (key: string) => void;
}

const ViewerGroupContext = createContext<ViewerGroup | null>(null);

function inDocumentOrder(left: ViewerImage, right: ViewerImage): number {
  return left.trigger.compareDocumentPosition(right.trigger) & Node.DOCUMENT_POSITION_FOLLOWING
    ? -1
    : 1;
}

/**
 * One viewer for the images a surface shows together, such as one tool call's output: any of them
 * opens full size, and the viewer moves between the surface's loaded images in the order they
 * appear. Closing it returns focus to the image it last showed; an image that leaves or changes
 * while shown closes it.
 */
export function ContentImageViewer({ children }: { readonly children: ReactNode }) {
  const [images, setImages] = useState<ReadonlyMap<string, ViewerImage>>(() => new Map());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const group = useMemo<ViewerGroup>(
    () => ({
      register: (key, image) => {
        setImages((current) => new Map(current).set(key, image));
        return () => {
          setOpenKey((current) => (current === key ? null : current));
          setImages((current) => {
            if (current.get(key) !== image) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
        };
      },
      open: setOpenKey,
    }),
    [],
  );
  const sequence =
    openKey === null
      ? []
      : [...images]
          .filter(([, image]) => image.trigger.isConnected)
          .toSorted(([, left], [, right]) => inDocumentOrder(left, right));
  const index = sequence.findIndex(([key]) => key === openKey);
  const active = sequence[index]?.[1];
  const previousKey = sequence[index - 1]?.[0];
  const nextKey = sequence[index + 1]?.[0];

  return (
    <ViewerGroupContext value={group}>
      {children}
      {active ? (
        <ImagePreviewDialog
          open
          onOpenChange={(open) => {
            if (!open) setOpenKey(null);
          }}
          src={active.src}
          downloadSrc={active.downloadSrc}
          alt={active.alt}
          isCurrent={active.isCurrent}
          onPreviousImage={previousKey ? () => setOpenKey(previousKey) : undefined}
          onNextImage={nextKey ? () => setOpenKey(nextKey) : undefined}
          finalFocus={() => (active.trigger.isConnected ? active.trigger : false)}
        />
      ) : null}
    </ViewerGroupContext>
  );
}

export interface ViewableContentImage {
  /** The image's bytes, until they turn out not to be a picture. */
  readonly src: string | null;
  readonly isLoading: boolean;
  /** The image could not be read, or read as something no picture decodes from. */
  readonly isError: boolean;
  /** Binds the image's button, which the viewer returns focus to. */
  readonly bindTrigger: (element: HTMLButtonElement | null) => void;
  /** Opens the image in its surface's viewer; absent until its bytes are read. */
  readonly open: (() => void) | undefined;
  readonly onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Reports that the shown bytes did not decode, which retires the image from its viewer. */
  readonly onImageError: () => void;
}

function shownImage(asset: ContentImage, undecodable: string | null): string | null {
  return asset.isError || asset.previewSrc === undecodable ? null : asset.previewSrc;
}

/**
 * An image read where its content lives, viewable in the `ContentImageViewer` around it, with the
 * image actions every chat image has. The viewer shows the same bytes the image already read.
 */
export function useViewableContentImage(source: string, alt: string): ViewableContentImage {
  const group = useContext(ViewerGroupContext);
  const scope = useContentImageScope();
  const key = useId();
  const asset = useContentImage(source);
  const [undecodable, setUndecodable] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const src = shownImage(asset, undecodable);
  const downloadSrc = asset.downloadSrc ?? undefined;
  useEffect(() => {
    if (!group || !trigger || !src) return;
    let shown = true;
    const release = group.register(key, {
      trigger,
      src,
      downloadSrc,
      alt,
      isCurrent: () => shown && trigger.isConnected && scope.isCurrent(),
    });
    return () => {
      shown = false;
      release();
    };
  }, [alt, downloadSrc, group, key, scope, src, trigger]);
  const onContextMenu = useContentImageMenu(source, src, alt);
  return {
    src,
    isLoading: asset.isLoading,
    isError: asset.isError || (asset.previewSrc !== null && src === null),
    bindTrigger: setTrigger,
    open: group && src ? () => group.open(key) : undefined,
    onContextMenu,
    onImageError: () => setUndecodable(asset.previewSrc),
  };
}
