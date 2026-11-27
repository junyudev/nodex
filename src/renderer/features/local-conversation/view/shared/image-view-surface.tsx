import { useIntl, type IntlShape } from "@/lib/i18n";
import type { CodexStepImage, CodexUnavailableImage } from "@/lib/types";
import { ThreadActivityShell, ThreadRichActivityHeader } from "./tools/tool-primitives";
import { NO_UNAVAILABLE_IMAGES } from "./unavailable-image";
import { StepImageStrip } from "./step-images";
import { semanticToolIcon, ToolActivityIcon } from "./tools/tool-call-icons";

/** What an inspection says: the file it viewed by name, or how many it viewed. */
export function imageViewSummary(
  intl: IntlShape,
  images: readonly CodexStepImage[],
  unavailableImages: readonly CodexUnavailableImage[],
): string {
  const total = images.length + unavailableImages.length;
  const name = total === 1 ? (images[0]?.name ?? unavailableImages[0]?.name) : undefined;
  const summary = name
    ? intl.formatMessage(
        { id: "conversation.imageViewSurface.viewedNamedImage", defaultMessage: "Viewed {name}" },
        { name },
      )
    : intl.formatMessage(
        {
          id: "conversation.imageViewSurface.viewedImages",
          defaultMessage: "{count, plural, one {Viewed an image} other {Viewed # images}}",
        },
        { count: total },
      );
  const missing = unavailableImages.length;
  if (missing === 0) return summary;
  if (images.length > 0)
    return intl.formatMessage(
      {
        id: "conversation.imageViewSurface.someMissing",
        defaultMessage: "{summary} · {count} missing",
      },
      { summary, count: missing },
    );
  return intl.formatMessage(
    {
      id: "conversation.imageViewSurface.allMissing",
      defaultMessage: "{summary} · {count, plural, one {file missing} other {files missing}}",
    },
    { summary, count: total },
  );
}

/** A step that inspected pictures: what it viewed, with the pictures themselves beside it. */
export function ImageViewSurface({
  images,
  unavailableImages = NO_UNAVAILABLE_IMAGES,
}: {
  images: readonly CodexStepImage[];
  unavailableImages?: readonly CodexUnavailableImage[];
}) {
  const intl = useIntl();
  return (
    <ThreadActivityShell
      testId="image-view-activity"
      header={
        <ThreadRichActivityHeader
          icon={<ToolActivityIcon descriptor={semanticToolIcon("view-image")} />}
          summary={
            <span className="block truncate text-token-conversation-summary-trailing">
              {imageViewSummary(intl, images, unavailableImages)}
            </span>
          }
          media={<StepImageStrip images={images} unavailableImages={unavailableImages} />}
        />
      }
    />
  );
}
