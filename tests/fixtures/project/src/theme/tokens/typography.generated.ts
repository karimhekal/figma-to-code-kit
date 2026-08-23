/* eslint-disable */
// Stand-in for what build-typography.js emits (that script fetches Figma TEXT STYLES, which are
// not variables and so never appear in a variables export). Committed as a fixture so the
// extractor's text-style suggestions can be tested without the network.
//
// `body` and `subheadline` deliberately SHARE a font size: that is what forces the extractor to
// disambiguate on lineHeight, and a ramp without a collision would never exercise it.
export const textStyles = {
  caption: { fontSize: 12, lineHeight: 16 },
  body: { fontSize: 15, lineHeight: 20 },
  subheadline: { fontSize: 15, lineHeight: 18 },
  title: { fontSize: 22, lineHeight: 28 },
} as const;
