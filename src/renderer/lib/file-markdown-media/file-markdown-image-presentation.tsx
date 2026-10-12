import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DownloadIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { openExternalUrl } from "../file-system-operations";

interface ImagePresentation {
  readonly failed: boolean;
  readonly attach: (image: HTMLImageElement | null) => void;
  readonly loaded: (image: HTMLImageElement) => void;
  readonly registerResources: (names: ReadonlyMap<string, string>, settled: boolean) => () => void;
  readonly errored: (image: HTMLImageElement) => void;
}

const ImagePresentationContext = createContext<ImagePresentation | null>(null);
export const useFileMarkdownImagePresentation = () => useContext(ImagePresentationContext);

interface ImageState {
  readonly identity: string;
  readonly status: "loaded" | "error";
  readonly alt: string;
  readonly hasDimensions: boolean;
}

/** User-triggered save consumes the selected resolved URL, never an authored file locator. */
async function saveImage(href: string, name: string, signal: AbortSignal) {
  const response = await fetch(href, { signal, credentials: "omit" });
  if (signal.aborted) return;
  if (!response.ok) throw new Error("Unable to download image");
  const blob = await response.blob();
  if (signal.aborted) return;
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A picture has one surrounding frame; its native img remains a direct child. */
export function FileMarkdownImageFrame({
  identity,
  children,
  expectedResources = 1,
}: {
  readonly identity: string;
  readonly children: ReactNode;
  readonly expectedResources?: number;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const downloadRef = useRef<AbortController | null>(null);
  const resources = useRef(
    new Map<symbol, { identity: string; names: ReadonlyMap<string, string>; settled: boolean }>(),
  );
  const lifetime = useRef({ mounted: true, identity });
  useLayoutEffect(() => {
    lifetime.current = { mounted: true, identity };
    return () => {
      lifetime.current.mounted = false;
      downloadRef.current?.abort();
    };
  }, [identity]);
  const [state, setState] = useState<ImageState | null>(null);
  const [download, setDownload] = useState<{
    identity: string;
    status: "pending" | "error";
  } | null>(null);
  const current = state?.identity === identity ? state : null;
  const pending = download?.identity === identity && download.status === "pending";
  const downloadImage = async () => {
    const image = imageRef.current;
    const selected = image?.currentSrc || image?.src;
    const name = selected
      ? [...resources.current.values()]
          .find((entry) => entry.identity === identity && entry.names.has(selected))
          ?.names.get(selected)
      : undefined;
    if (!selected || !name || current?.status !== "loaded" || pending) return;
    downloadRef.current?.abort();
    const controller = new AbortController();
    downloadRef.current = controller;
    setDownload({ identity, status: "pending" });
    try {
      await saveImage(selected, name, controller.signal);
      if (!controller.signal.aborted) setDownload(null);
    } catch {
      if (controller.signal.aborted) return;
      if (/^https?:/iu.test(selected)) {
        const opened = await openExternalUrl(selected).catch(() => false);
        if (controller.signal.aborted) return;
        if (opened) {
          setDownload(null);
          return;
        }
      }
      setDownload({ identity, status: "error" });
    }
  };
  const failed = current?.status === "error" && !current.hasDimensions;
  const presentation = useMemo<ImagePresentation>(
    () => ({
      failed,
      attach: (image) => {
        imageRef.current = image;
      },
      loaded: (image) => {
        if (image !== imageRef.current) return;
        setState((previous) =>
          previous?.identity === identity &&
          previous.status === "loaded" &&
          previous.alt === image.alt
            ? previous
            : {
                identity,
                status: "loaded",
                alt: image.alt,
                hasDimensions: image.hasAttribute("width") || image.hasAttribute("height"),
              },
        );
      },
      errored: (image) => {
        if (image !== imageRef.current) return;
        setState((previous) =>
          previous?.identity === identity &&
          previous.status === "error" &&
          previous.alt === image.alt
            ? previous
            : {
                identity,
                status: "error",
                alt: image.alt,
                hasDimensions: image.hasAttribute("width") || image.hasAttribute("height"),
              },
        );
      },
      registerResources: (names, settled) => {
        const key = Symbol();
        resources.current.set(key, { identity, names, settled });
        queueMicrotask(() => {
          if (!lifetime.current.mounted || lifetime.current.identity !== identity) return;
          const entries = [...resources.current.values()].filter(
            (entry) => entry.identity === identity,
          );
          if (
            entries.length < expectedResources ||
            entries.some((entry) => !entry.settled || entry.names.size > 0)
          )
            return;
          const image = imageRef.current;
          if (image)
            setState((previous) =>
              previous?.identity === identity && previous.status === "error"
                ? previous
                : {
                    identity,
                    status: "error",
                    alt: image.alt,
                    hasDimensions: image.hasAttribute("width") || image.hasAttribute("height"),
                  },
            );
        });
        return () => {
          resources.current.delete(key);
        };
      },
    }),
    [identity, failed, expectedResources],
  );
  return (
    <ImagePresentationContext.Provider value={presentation}>
      <span className="group relative my-3 inline-block max-w-full">
        {children}
        {failed ? (
          <span role="status" className="text-token-description-foreground">
            {current?.alt || "Image unavailable"}
          </span>
        ) : null}
        {current?.status === "loaded" ? (
          <NodexTooltip tooltipContent="Download image">
            <button
              type="button"
              aria-label="Download image"
              disabled={pending}
              onClick={() => {
                void downloadImage();
              }}
              className="absolute bottom-2 right-2 rounded-md border border-token-border bg-token-background px-1.5 py-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
            >
              <DownloadIcon className="icon-xs" />
            </button>
          </NodexTooltip>
        ) : null}
        {download?.identity === identity && download.status === "error" ? (
          <span role="status" className="text-token-description-foreground">
            Unable to download image
          </span>
        ) : null}
      </span>
    </ImagePresentationContext.Provider>
  );
}
