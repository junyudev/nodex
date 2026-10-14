import { toast } from "@/components/ui/toast";
import { useApplyLibraryOperation } from "@/lib/use-library-navigation";
import { buildLibraryMoveOperation } from "@/lib/library-operations";
import { SidebarPagesSection, type SidebarPagesSectionProps } from "./sidebar-pages-section";
import { SidebarReorderDndProvider } from "./sidebar-reorder-dnd";

/** Library roots share the sidebar's existing gesture controller and Library mutation boundary. */
export function WorkbenchSpaceSidebarContent(props: SidebarPagesSectionProps) {
  const { mutation } = useApplyLibraryOperation();

  return (
    <SidebarReorderDndProvider
      onLibraryMove={async ({ resource, parent }) => {
        try {
          await mutation.mutateAsync(
            buildLibraryMoveOperation({
              target: resource.target,
              expectedLocationRevision: resource.expectedLocationRevision,
              parent,
            }),
          );
        } catch (error) {
          toast.danger(error instanceof Error ? error.message : "Could not move content");
        }
      }}
    >
      <SidebarPagesSection {...props} />
    </SidebarReorderDndProvider>
  );
}
