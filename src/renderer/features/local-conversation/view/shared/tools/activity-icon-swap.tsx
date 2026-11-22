import codeSearchingSpriteUrl from "@/assets/activity-sprites/code-searching.webp?url&no-inline";
import codeThinkingSpriteUrl from "@/assets/activity-sprites/code-thinking.webp?url&no-inline";
import computerSpriteUrl from "@/assets/activity-sprites/computer.webp?url&no-inline";
import readingSpriteUrl from "@/assets/activity-sprites/reading.webp?url&no-inline";
import webSearchSpriteUrl from "@/assets/activity-sprites/web-search.webp?url&no-inline";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "../../../../../lib/utils";
import styles from "./activity-sprite-icon.module.css";

/** Animated stand-ins for a static glyph while its tool is working. */
export type ActivitySpriteName =
  | "code-thinking"
  | "code-searching"
  | "reading"
  | "web-search"
  | "computer";

const SPRITES: Readonly<Record<ActivitySpriteName, { url: string; className: string }>> = {
  "code-thinking": { url: codeThinkingSpriteUrl, className: styles.codeThinking },
  "code-searching": { url: codeSearchingSpriteUrl, className: styles.codeSearching },
  reading: { url: readingSpriteUrl, className: styles.reading },
  "web-search": { url: webSearchSpriteUrl, className: styles.webSearch },
  computer: { url: computerSpriteUrl, className: styles.computer },
};

/** The glyph a row rests on, and the sprite that replaces it while its work runs. */
export interface ActivityIconPair {
  original: ReactNode;
  alternate: ActivitySpriteName | null;
}

const ICON_FADE: Transition = { duration: 0.15, ease: "easeOut" };

// Without a decoder (outside a browser) there is nothing to wait for; sprites show at once.
const canDecodeSprites =
  typeof HTMLImageElement !== "undefined" && "decode" in HTMLImageElement.prototype;
const decodedSprites = new Set<string>();
const pendingSprites = new Map<string, Promise<void>>();

function decodeSprite(url: string): Promise<void> {
  const pending = pendingSprites.get(url);
  if (pending) return pending;
  const image = new Image();
  image.src = url;
  const decoding = image
    .decode()
    .then(() => {
      decodedSprites.add(url);
    })
    .catch(() => undefined)
    .finally(() => {
      pendingSprites.delete(url);
    });
  pendingSprites.set(url, decoding);
  return decoding;
}

/** The sprite stays hidden until its strip has decoded, so the swap never flashes empty. */
function useDecodedSprite(name: ActivitySpriteName | null): boolean {
  const url = name == null ? null : SPRITES[name].url;
  const [decodedUrl, setDecodedUrl] = useState<string | null>(() =>
    url != null && decodedSprites.has(url) ? url : null,
  );
  useEffect(() => {
    if (url == null || !canDecodeSprites || decodedSprites.has(url)) return;
    let current = true;
    void decodeSprite(url).then(() => {
      if (current && decodedSprites.has(url)) setDecodedUrl(url);
    });
    return () => {
      current = false;
    };
  }, [url]);
  return url != null && (!canDecodeSprites || decodedUrl === url || decodedSprites.has(url));
}

export function ActivitySpriteIcon({
  className,
  name,
}: {
  className?: string;
  name: ActivitySpriteName;
}) {
  const sprite = SPRITES[name];
  return (
    <span
      aria-hidden="true"
      className={cn(styles.icon, sprite.className, className)}
      data-activity-sprite={name}
      data-rtl-flip={name === "reading" ? "" : undefined}
    >
      <span className={styles.viewport}>
        <span className={styles.rows}>
          <span className={styles.frames} style={{ maskImage: `url("${sprite.url}")` }} />
        </span>
      </span>
    </span>
  );
}

/**
 * A leading activity glyph. A new `transitionKey` crossfades glyph families in one grid cell;
 * while `active`, the glyph hands over to its animated sprite and takes it back when work stops.
 */
export function ActivityIconSwap({
  active,
  className,
  icons,
  transitionKey,
}: {
  active: boolean;
  className?: string;
  icons: ActivityIconPair;
  transitionKey?: string;
}) {
  const reducedMotion = useResolvedReducedMotion();
  const requestedSprite = active && !reducedMotion ? icons.alternate : null;
  const spriteReady = useDecodedSprite(requestedSprite);
  const showSprite = requestedSprite != null && spriteReady;
  const [spritePresent, setSpritePresent] = useState(false);

  if (transitionKey === undefined && !showSprite && !spritePresent) {
    return icons.original == null ? null : (
      <span className={cn("contents", className)}>{icons.original}</span>
    );
  }

  const original =
    icons.original == null ? null : transitionKey === undefined || reducedMotion ? (
      <span
        className={cn(
          "col-start-1 row-start-1 inline-flex transition-opacity duration-basic ease-out motion-reduce:transition-none",
          showSprite && "opacity-0",
        )}
      >
        {icons.original}
      </span>
    ) : (
      <AnimatePresence initial={false}>
        <motion.span
          key={transitionKey}
          className="col-start-1 row-start-1 inline-flex"
          initial={{ opacity: 0 }}
          animate={{ opacity: showSprite ? 0 : 1 }}
          exit={{ opacity: 0 }}
          transition={ICON_FADE}
        >
          {icons.original}
        </motion.span>
      </AnimatePresence>
    );

  return (
    <span
      className={cn("inline-grid shrink-0 place-items-center align-middle empty:hidden", className)}
      data-activity-icon-key={transitionKey}
    >
      {original}
      <AnimatePresence onExitComplete={() => setSpritePresent(false)}>
        {showSprite && requestedSprite != null ? (
          <motion.span
            key={requestedSprite}
            className="pointer-events-none col-start-1 row-start-1 inline-flex"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={ICON_FADE}
            onAnimationStart={() => setSpritePresent(true)}
          >
            <ActivitySpriteIcon name={requestedSprite} />
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
