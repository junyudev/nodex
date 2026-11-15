/** Monochrome geometry shared by generated glyphs and review exports. Missing fill means icon color. */
export interface IconPathDescriptor {
  readonly d: string;
  readonly fillRule?: "evenodd";
  readonly opacity?: number;
  readonly fill?: "none";
  readonly stroke?: "currentColor";
  readonly strokeWidth?: number;
  readonly strokeLinecap?: "round" | "square";
  readonly strokeLinejoin?: "round" | "bevel";
}

export interface IconGlyph {
  readonly viewBox: string;
  readonly paths: readonly IconPathDescriptor[];
}
