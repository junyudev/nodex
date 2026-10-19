import { lazy } from "react";
import { ApplicationSurface } from "@/bootstrap/application-surface";
import { PageStageLoadingFrame } from "../board/page-stage/frame";
import type { PageStageProps } from "../board/page-stage/types";

const PageStageView = lazy(async () => ({
  default: (await import("../board/page-stage")).PageStage,
}));

export function PageStage(props: PageStageProps) {
  const title = props.page?.page.title;
  return (
    <ApplicationSurface
      fallback={
        <PageStageLoadingFrame
          titleSnapshot={title}
          breadcrumb={
            props.breadcrumb ? { ...props.breadcrumb, currentTitle: title ?? "" } : undefined
          }
        />
      }
    >
      <PageStageView {...props} />
    </ApplicationSurface>
  );
}
