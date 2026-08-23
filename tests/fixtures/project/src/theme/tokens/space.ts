// Hand-authored spacing ramp. In this synthetic design system, as in most real ones, Figma does
// NOT bind variables to gap/padding — so the ramp is code-owned and the extractor checks measured
// spacing against it (`tokens.spacing.tokenizedInFigma: false`).
//
// Keyed by its own value, so `refTemplate: "space[{n}]"` renders `space[8]`.
export const space = {
  0: 0,
  4: 4,
  8: 8,
  12: 12,
  16: 16,
  24: 24,
  32: 32,
} as const;
