/**
 * Noop's design tokens: the one place for sizes, the corner-radius ladder, spacing, type and the floating glass.
 * Colors live in `theme.ts` (from `theme.json`); components in `controls.tsx` read only these.
 */
import type { ViewStyle } from "nsh";
import { platform } from "nsh";
import { alpha, colors } from "./theme";

/** A touch screen: 44-point targets. */
export const touch = !(platform.idiom === "desktop" || platform.idiom === "mac");

/**
 * Sizes: one scale for every control, as gpui-kit's `Size`: a `md` control (a button, an icon button, a field, a
 * number input) is `control` high, a `sm` one `controlSm`, so any of them line up in a row. An icon button is a
 * square of its size's height.
 */
export const size = {
  text: 17,
  line: 26,
  small: 15,
  tiny: 13,
  field: touch ? 44 : 32,
  control: touch ? 44 : 32,
  controlSm: touch ? 36 : 24,
  row: touch ? 44 : 34,
  bar: touch ? 56 : 52,
  sidebar: 288,
  column: 880,
};

/**
 * Type steps (points), each with its line height: a label never sets its own. On a touch screen they follow iOS's
 * Dynamic Type defaults: xs Footnote 13, sm Subheadline 15, md Body 17.
 */
export const font = touch
  ? ({ key: 12, badge: 12, xs: 13, sm: 15, md: 17, lg: 20 } as const)
  : ({ key: 12, badge: 12, xs: 12, sm: 14, md: 16, lg: 17 } as const);
export const leading = touch
  ? ({ key: 16, badge: 16, xs: 18, sm: 20, md: 22, lg: 25 } as const)
  : ({ key: 16, badge: 16, xs: 16, sm: 20, md: 22, lg: 24 } as const);

/** What moves with a control's size: its height, side padding, gaps, glyph and type. Shared by every control. */
export const controlMetrics = (sm: boolean) =>
  sm
    ? { height: size.controlSm, padX: 8, gap: 4, icon: 14, font: font.xs, line: leading.xs }
    : { height: size.control, padX: 12, gap: 6, icon: 16, font: font.sm, line: leading.sm };

/**
 * The corner-radius ladder, largest first: the composer, then fields, then buttons and rows, then icon buttons, then
 * badges and keys. Restrained on purpose: a small button never gets a pill.
 */
export const corner = {
  composer: 24,
  /** A sheet or an iOS menu: the softest floating surface, as the system's. */
  sheet: 24,
  field: 10,
  control: 8,
  item: 8,
  icon: 6,
  badge: 5,
  key: 4,
} as const;

/** Spacing steps (points). */
export const space = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24 } as const;


/**
 * The quiet fills of controls, as the text color's opacity over whatever surface they sit on: the same steps in light
 * and dark. `rest` is a secondary control's own fill, `hover` and `press` its states; a ghost control starts clear and
 * takes `hover` / `press`, and the selected or checked one keeps `selected`.
 */
export const fill = { rest: 0.07, hover: 0.12, press: 0.16, ghostHover: 0.1, ghostPress: 0.15, selected: 0.12, menuOpen: 0.06 } as const;

/** A control's edge: a neutral hairline of the text color, so it reads as part of the surface rather than a grey line. */
export const edge = { rest: 0.11, hover: 0.18 } as const;

/** Durations shared by hover / state transitions (milliseconds). */
export const duration = { quick: 120, settle: 180, enter: 420 } as const;

/**
 * Press feedback, kept small: a control gives a little under the finger and settles back (`duration.settle`). Rows
 * barely move.
 */
export const press = { control: 0.96, row: 0.985 } as const;

/**
 * A floating surface, for the composer and the sidebar: Apple's Liquid Glass where it is drawn (iOS 26, macOS 26), a
 * blur elsewhere. Linux and Android before 12 draw no backdrop, so they stay opaque there, or what is behind would show
 * through the text on it.
 */
export const glass = (tint: string, cornerRadius: number): ViewStyle => ({
  borderRadius: cornerRadius,
  borderCurve: "continuous",
  borderWidth: 1,
  borderColor: alpha(colors.text, 0.1),
  boxShadow: "0 8px 28px rgba(0,0,0,0.1)",
  ...(platform.os === "linux" || (platform.os === "android" && Number(platform.version) < 31)
    ? { backgroundColor: tint }
    : { backgroundColor: alpha(tint, 0.55), glassEffect: "regular" as const, backdropFilter: "blur(20px)" }),
});

/** iOS 26 and later draw Liquid Glass; earlier iOS falls back to a blur. */
export const iosGlass = platform.os === "ios" && Number.parseFloat(platform.version) >= 26;

/**
 * The surface of a menu or sheet on iOS. On iOS 26 it is the bare native glass: no fill over the material, which would
 * hide it, and no hairline or shadow, since the material draws its own edge. Earlier iOS has no glass, so the blur
 * there carries a nearly opaque `tint` with a hairline, which keeps the rows readable over whatever is behind.
 */
export const menuGlass = (tint: string, cornerRadius: number): ViewStyle => ({
  borderRadius: cornerRadius,
  borderCurve: "continuous",
  ...(iosGlass
    ? { borderWidth: 0, backgroundColor: "transparent", boxShadow: "none", glassEffect: "regular" as const, backdropFilter: "blur(20px)" }
    : { borderWidth: 1, borderColor: alpha(colors.text, 0.1), backgroundColor: alpha(tint, 0.9), backdropFilter: "blur(20px)",
        boxShadow: "0 10px 32px rgba(0,0,0,0.16)" }),
});

/** The floating surface of a message composer, which the conversation scrolls under. */
export const composerGlass = (active = false): ViewStyle => ({
  ...glass(colors.field, corner.composer),
  ...(platform.os === "ios" ? { backgroundColor: alpha(colors.field, 0.25) } : {}),
  boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
  borderWidth: platform.os === "ios" || platform.os === "macos" ? 0 : 1,
  borderColor: alpha(colors.text, active ? 0.22 : 0.1),
  transitionProperty: "border-color",
  transitionDuration: duration.quick,
});
