type HostStyleProperty =
  | "color"
  | "font-family"
  | "font-size"
  | "font-weight"
  | "border-radius"
  | "box-shadow";

const HOST_STYLE_ROLES = {
  "--color-background-primary": [
    "color",
    "--app-color-background-surface",
    "--color-surface-tertiary",
  ],
  "--color-background-secondary": ["color", "--color-surface-elevated"],
  "--color-background-tertiary": ["color", "--color-surface-secondary"],
  "--color-background-inverse": ["color", "--color-text"],
  "--color-background-info": [
    "color",
    "--app-color-background-accent",
    "--color-background-info-soft",
  ],
  "--color-background-danger": ["color", "--color-background-danger-surface"],
  "--color-background-disabled": ["color", "--color-background-primary-soft-active"],
  "--color-text-primary": ["color", "--color-text"],
  "--color-text-secondary": ["color", "--color-codex-description"],
  "--color-text-tertiary": ["color", "--color-codex-description"],
  "--color-text-inverse": ["color", "--color-text-inverse", "--color-surface-tertiary"],
  "--color-text-ghost": ["color", "--color-codex-description"],
  "--color-text-info": ["color", "--color-text-info"],
  "--color-text-danger": ["color", "--color-text-danger"],
  "--color-text-success": ["color", "--color-codex-git-added"],
  "--color-text-warning": ["color", "--color-text-warning"],
  "--color-text-disabled": ["color", "--color-codex-description"],
  "--color-border-primary": ["color", "--color-border-primary-outline"],
  "--color-border-secondary": ["color", "--color-border"],
  "--color-border-tertiary": ["color", "--color-border"],
  "--color-border-inverse": ["color", "--color-text"],
  "--color-border-info": ["color", "--color-ring"],
  "--color-border-danger": ["color", "--color-text-danger"],
  "--color-border-success": ["color", "--color-codex-git-added"],
  "--color-border-warning": ["color", "--color-text-warning"],
  "--color-border-disabled": ["color", "--color-border-primary-outline"],
  "--color-ring-primary": ["color", "--color-ring"],
  "--color-ring-secondary": ["color", "--color-ring"],
  "--color-ring-inverse": ["color", "--color-ring"],
  "--color-ring-info": ["color", "--color-ring"],
  "--color-ring-danger": ["color", "--color-text-danger"],
  "--color-ring-success": ["color", "--color-codex-git-added"],
  "--color-ring-warning": ["color", "--color-text-warning"],
  "--font-sans": ["font-family", "--font-sans"],
  "--font-mono": ["font-family", "--font-mono"],
  "--font-weight-normal": ["font-weight", "--font-ui-weight", "--font-weight-normal"],
  "--font-weight-medium": ["font-weight", "--font-weight-medium"],
  "--font-weight-semibold": ["font-weight", "--font-weight-semibold"],
  "--font-weight-bold": ["font-weight", "--font-weight-bold"],
  "--font-text-xs-size": ["font-size", "--text-xs"],
  "--font-text-sm-size": ["font-size", "--text-sm"],
  "--font-text-md-size": ["font-size", "--text-base"],
  "--font-text-lg-size": ["font-size", "--text-lg"],
  "--font-heading-xs-size": ["font-size", "--text-heading-sm"],
  "--font-heading-sm-size": ["font-size", "--text-heading-md"],
  "--font-heading-md-size": ["font-size", "--text-heading-lg"],
  "--font-heading-lg-size": ["font-size", "--text-xl"],
  "--font-heading-xl-size": ["font-size", "--text-2xl"],
  "--font-heading-2xl-size": ["font-size", "--text-3xl"],
  "--font-heading-3xl-size": ["font-size", "--text-4xl"],
  "--border-radius-xs": ["border-radius", "--radius-xs"],
  "--border-radius-sm": ["border-radius", "--radius-sm"],
  "--border-radius-md": ["border-radius", "--radius-md"],
  "--border-radius-lg": ["border-radius", "--radius-lg"],
  "--border-radius-xl": ["border-radius", "--radius-xl"],
  "--border-radius-full": ["border-radius", "--radius-full"],
  "--shadow-hairline": ["box-shadow", "--shadow-hairline"],
  "--shadow-sm": ["box-shadow", "--shadow-sm"],
  "--shadow-md": ["box-shadow", "--shadow-md"],
  "--shadow-lg": ["box-shadow", "--shadow-lg"],
} as const satisfies Readonly<Record<string, readonly [HostStyleProperty, ...string[]]>>;

const HOST_LINE_HEIGHTS = {
  "--font-text-xs-line-height": "--text-xs--line-height",
  "--font-text-sm-line-height": "--text-sm--line-height",
  "--font-text-md-line-height": "--text-base--line-height",
  "--font-text-lg-line-height": "--text-lg--line-height",
} as const;

/** Resolve host roles to portable CSS values; guest documents cannot inherit host variables. */
export function readMcpAppHostStyleVariables(): Record<string, string> {
  const rootStyles = getComputedStyle(document.documentElement);
  const probe = document.createElement("div");
  probe.hidden = true;
  probe.setAttribute("aria-hidden", "true");
  document.body.append(probe);
  const read = (token: string, property: HostStyleProperty): string | undefined => {
    const value = rootStyles.getPropertyValue(token).trim();
    if (!value) return undefined;
    probe.style.setProperty(property, `var(${token})`);
    const resolved = getComputedStyle(probe).getPropertyValue(property).trim();
    return resolved && resolved !== `var(${token})` ? resolved : value;
  };

  try {
    const variables: Record<string, string> = {
      "--color-background-ghost": "transparent",
      "--color-border-ghost": "transparent",
      "--border-width-regular": "1px",
      "--font-heading-xs-line-height": "1.33",
      "--font-heading-sm-line-height": "1.33",
      "--font-heading-md-line-height": "1.2",
      "--font-heading-lg-line-height": "1.2",
      "--font-heading-xl-line-height": "1",
      "--font-heading-2xl-line-height": "1",
      "--font-heading-3xl-line-height": "1",
    };
    for (const [name, [property, ...tokens]] of Object.entries(HOST_STYLE_ROLES)) {
      const value = tokens.map((token) => read(token, property)).find(Boolean);
      if (!value) continue;
      variables[name] = value;
    }
    for (const [name, token] of Object.entries(HOST_LINE_HEIGHTS)) {
      const value = rootStyles.getPropertyValue(token).trim();
      if (!value) continue;
      variables[name] = value;
    }
    const surface = read("--color-surface-tertiary", "color");
    if (!surface) return variables;
    for (const [name, token] of [
      ["--color-background-success", "--color-codex-git-added"],
      ["--color-background-warning", "--color-text-warning"],
    ] as const) {
      const value = read(token, "color");
      if (!value) continue;
      variables[name] = `color-mix(in srgb, ${value} 12%, ${surface})`;
    }
    return variables;
  } finally {
    probe.remove();
  }
}
