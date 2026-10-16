import { memo, type ComponentType } from "react";
import { ApplicationSurface } from "@/bootstrap/application-surface";
import {
  appScope,
  scopedAtom,
  type ScopeHandle,
  useScopeHandle,
  useScopedAtomValue,
} from "@/lib/maitai";

export interface ModalCloseProps {
  readonly onClose: () => void;
}

export type ModalOpenProps<Props extends ModalCloseProps> = Omit<Props, "onClose"> &
  Partial<Pick<Props, "onClose">>;

interface ModalEntry {
  readonly key: number;
  readonly component: unknown;
  readonly props: Readonly<Record<string, unknown>>;
}

interface ModalRegistryState {
  readonly modals: readonly ModalEntry[];
  readonly nextKey: number;
}

const modalRegistryAtom = scopedAtom<ModalRegistryState>(
  appScope,
  {
    modals: [],
    nextKey: 1,
  },
  { debugLabel: "modal-registry" },
);

export function openModal<Props extends ModalCloseProps>(
  appHandle: ScopeHandle,
  component: ComponentType<Props>,
  props: ModalOpenProps<Props>,
): void {
  appHandle.set(modalRegistryAtom, (previous) => {
    const existing = previous.modals.find((entry) => entry.component === component);
    const entry: ModalEntry = {
      key: existing?.key ?? previous.nextKey,
      component,
      props,
    };

    return {
      modals: [...previous.modals.filter((candidate) => candidate.component !== component), entry],
      nextKey: existing ? previous.nextKey : previous.nextKey + 1,
    };
  });
}

export function closeModal<Props extends ModalCloseProps>(
  appHandle: ScopeHandle,
  component: ComponentType<Props>,
): void {
  appHandle.set(modalRegistryAtom, (previous) => {
    const modals = previous.modals.filter((entry) => entry.component !== component);
    if (modals.length === previous.modals.length) return previous;
    return { ...previous, modals };
  });
}

export function updateOpenModalProps<Props extends ModalCloseProps>(
  appHandle: ScopeHandle,
  component: ComponentType<Props>,
  patch: Partial<ModalOpenProps<Props>>,
): boolean {
  if (!isModalOpen(appHandle, component)) return false;
  appHandle.set(modalRegistryAtom, (previous) => ({
    ...previous,
    modals: previous.modals.map((entry) =>
      entry.component === component ? { ...entry, props: { ...entry.props, ...patch } } : entry,
    ),
  }));
  return true;
}

export function isModalOpen<Props extends ModalCloseProps>(
  appHandle: ScopeHandle,
  component: ComponentType<Props>,
): boolean {
  return appHandle.get(modalRegistryAtom).modals.some((entry) => entry.component === component);
}

export function useIsModalOpen<Props extends ModalCloseProps>(
  component: ComponentType<Props>,
): boolean {
  return useScopedAtomValue(modalRegistryAtom).modals.some(
    (entry) => entry.component === component,
  );
}

const NodexModalHostEntry = memo(function NodexModalHostEntry({
  entry,
}: {
  readonly entry: ModalEntry;
}) {
  const appHandle = useScopeHandle(appScope);
  const ModalComponent = entry.component as ComponentType<
    ModalCloseProps & Readonly<Record<string, unknown>>
  >;
  const callerOnClose = entry.props.onClose;

  return (
    <ModalComponent
      {...entry.props}
      onClose={() => {
        if (typeof callerOnClose === "function") callerOnClose();
        closeModal(appHandle, ModalComponent);
      }}
    />
  );
});

export function NodexModalHost() {
  const { modals } = useScopedAtomValue(modalRegistryAtom);

  return modals.map((entry) => (
    <ApplicationSurface key={entry.key}>
      <NodexModalHostEntry entry={entry} />
    </ApplicationSurface>
  ));
}
