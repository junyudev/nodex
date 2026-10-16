import { lazy } from "react";
import { ApplicationSurface } from "@/bootstrap/application-surface";
import { PageStageContentSkeleton } from "../board/page-stage/content-skeleton";
import type { PageStageProps } from "../board/page-stage/types";

const PageStageView = lazy(async () => ({
  default: (await import("../board/page-stage")).PageStage,
}));

export function PageStage(props: PageStageProps) {
  return (
    <ApplicationSurface fallback={<PageStageContentSkeleton />}>
      <PageStageView {...props} />
    </ApplicationSurface>
  );
}
