interface SideMenuFreezeRuntime {
  freezeMenu: () => void;
  unfreezeMenu: () => void;
}

interface SideMenuBlockRemovingEditor<Block> {
  removeBlocks: (blocks: Block[]) => unknown;
}

export interface SideMenuFreezeController {
  handleMenuOpenChange: (open: boolean) => void;
  release: () => void;
}

export function createSideMenuFreezeController(
  sideMenu: SideMenuFreezeRuntime,
): SideMenuFreezeController {
  let frozen = false;

  const release = () => {
    if (!frozen) return;
    frozen = false;
    sideMenu.unfreezeMenu();
  };

  return {
    handleMenuOpenChange(open) {
      if (open) {
        if (frozen) return;
        frozen = true;
        sideMenu.freezeMenu();
        return;
      }

      release();
    },
    release,
  };
}

export function deleteSideMenuBlock<Block>(options: {
  block: Block;
  editor: SideMenuBlockRemovingEditor<Block>;
  releaseSideMenuFreeze: () => void;
}): void {
  options.releaseSideMenuFreeze();
  options.editor.removeBlocks([options.block]);
}
