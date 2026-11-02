/** A window-scoped projection of Main's native application menu. */
export type ApplicationMenuEntry =
  | { readonly type: "separator"; readonly id: string }
  | {
      readonly type: "item" | "checkbox" | "radio";
      readonly id: string;
      readonly label: string;
      readonly enabled: boolean;
      readonly accelerator?: string;
      readonly checked: boolean;
    }
  | {
      readonly type: "submenu";
      readonly id: string;
      readonly label: string;
      readonly enabled: boolean;
      readonly items: readonly ApplicationMenuEntry[];
    };

export interface ApplicationMenuSnapshot {
  readonly menus: readonly Extract<ApplicationMenuEntry, { type: "submenu" }>[];
}

export interface WindowAppearanceInput {
  readonly theme: "light" | "dark" | "system";
  /** CSS shell zoom only. Main separately reads Electron's page zoom. */
  readonly shellZoom: number;
}
