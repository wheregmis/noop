import type { JSX, ViewStyle } from "nsh";
import { effect, Text, token, View } from "nsh";
import { reduceMotion } from "nsh";
import { type AnimatedValue, createAnimatedValue } from "nsh";
import { platform } from "nsh";
import { keymap } from "nsh";
import { Button as BaseButton, Sheet as BaseSheet, Switch } from "nsh/base";
import { safeArea } from "nsh";
import { Icon, type IconName } from "./icons";
import { createPresence, type PopupSide } from "./popup";
import { alpha, colors, finish, focusRing, hovered, isDark, mono, motion, radius, tints, toneColor, toneTint, type Tone } from "./theme";

export * from "./theme";
export { Segmented } from "./segmented";
export * from "./popup";
export * from "./data-table";
export * from "./slider";
export * from "./scrollbar-theme";
export * from "./avatar";
export * from "./menu";
export * from "./sidebar";
export * from "./settings";

/**
 * The thumb of a resize handle (`handleThumbClass`), as gpui-component
 * draws it: none at rest, so the hairlines stay quiet; a faint pill
 * grows in under the pointer, and a long solid one while pressed or
 * dragged.
 */
export const handleThumb =
  "h-11 w-[3px] rounded-full bg-muted-foreground opacity-0 scale-y-0 transition duration-150 ease-out group-hover:opacity-40 group-hover:scale-y-[0.45] group-active:opacity-90 group-active:scale-y-100";

/**
 * Instructions for the device's input: `touch` on phones and tablets,
 * `pointer` on desktops (a mouse, a touchpad, a keyboard).
 */
export const hint = (touch: string, pointer: string) => ((platform.idiom === "desktop" || platform.idiom === "mac") ? pointer : touch);

/**
 * Desktops' way to refresh what phones pull down (the mouse does not drag
 * scroll views): Ctrl+R / Cmd+R calls `refresh` while the calling component
 * shows, next to the refresh button the demo shows. Browsers keep the key to
 * reload the page, and the development hosts to reload the app. Returns the
 * key's label for the hint, or null where it is not bound.
 */
export function bindRefresh(refresh: () => void): string | null {
  if (!(platform.idiom === "desktop" || platform.idiom === "mac") || platform.os === "web") return null;
  keymap.bind("mod+r", refresh);
  return keymap.label("mod+r");
}

/**
 * A pressable that sinks a little under the finger and springs back (the
 * spring runs natively; only press in / out reach JS).
 */
export function Press(props: {
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /** How far it shrinks (default 0.97). */
  scale?: number;
  style?: ViewStyle;
  role?: "button" | "tab" | "switch" | "link";
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean; checked?: boolean; disabled?: boolean };
  hitSlop?: number;
  /** Under the pointer (default: a slight dim, whatever its children
   * draw; when the look is on `style`, pass the look's own hover). */
  hoverStyle?: ViewStyle;
  children: JSX.Element;
}) {
  const s = createAnimatedValue(1);
  return (
    <View
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      disabled={props.disabled}
      hoverStyle={props.disabled ? undefined : (props.hoverStyle ?? { opacity: 0.86 })}
      onPressDown={() => s.spring(props.scale ?? 0.97, motion.press)}
      onPressUp={() => s.spring(1, motion.press)}
      role={props.role ?? "button"}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={props.accessibilityState}
      hitSlop={props.hitSlop}
      style={[props.style ?? null, { transform: [{ scale: s }], opacity: props.disabled ? 0.4 : 1 }]}
    >
      {props.children}
    </View>
  );
}

/**
 * `Press`'s feedback for a `Tab` of `nsh/base`, which reports no press down
 * to spring with: it sinks a little while pressed and eases back, and takes
 * presses 4 pt around it without taking more room (a hit slop). Spread
 * `style` and `activeStyle` into the tab's.
 */
export const tabPress = {
  style: { margin: -4, padding: 4, transitionProperty: "transform", transitionDuration: 150, transitionTimingFunction: "ease-out" },
  activeStyle: { transform: [{ scale: 0.97 }] },
} satisfies { style: ViewStyle; activeStyle: ViewStyle };

/**
 * Fades and lifts its content in once mounted; `index` staggers siblings
 * (40 ms apart). `flex` lets it wrap a page that fills its parent.
 */
export function Appear(props: { index?: number; flex?: boolean; children: JSX.Element }) {
  const t = createAnimatedValue(0);
  t.timing(1, { ...motion.enter, delay: Math.min(8, props.index ?? 0) * 40 });
  return (
    <View style={{ flex: props.flex ? 1 : undefined, opacity: t, transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }}>
      {props.children}
    </View>
  );
}

/**
 * An animated value that springs to `target` each time it changes (a
 * control's state: 1 while on, 0 while off), natively: JS only starts each
 * spring. A change mid-way turns it from where it is, with its velocity;
 * with reduced motion it lands at once. For discrete changes only: what
 * the pointer drives (a dragged thumb, a hover's place) is set in the same
 * frame, never sprung toward the pointer.
 */
export function follow(target: () => number, spring: { stiffness: number; damping: number } = motion.control): AnimatedValue {
  const v = createAnimatedValue(target());
  let shown = target();
  effect(() => {
    const next = target();
    if (next === shown) return;
    shown = next;
    if (reduceMotion()) v.set(next);
    else v.spring(next, spring);
  });
  return v;
}

/** A rounded icon tile. */
export function IconTile(props: { name: IconName; tint?: string; size?: number }) {
  const size = props.size ?? 40;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.raised,
        ...finish.raised,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={props.name} size={size * 0.5} tint={props.tint ?? colors.text} />
    </View>
  );
}

/** A pointer and a keyboard: the compact sizes of desktops. */
const pointer = (platform.idiom === "desktop" || platform.idiom === "mac");

/**
 * The page's density: compact with a pointer (desktops), roomier on a touch
 * screen. Section titles, surfaces, rows and their padding take these, so a
 * demo's sections read the same on every page.
 */
export const density = pointer
  ? { title: 13, note: 12, body: 13, row: 36, pad: 14, gap: 12, surface: 10 }
  : { title: 13, note: 13, body: 15, row: 48, pad: 16, gap: 12, surface: 16 };

/**
 * A section's title and what it shows, above its surface: 13 pt semibold on
 * a desktop, 15 on a touch screen, `right` at the trailing
 * edge (a badge, an action).
 */
function SectionHead(props: { title: string; subtitle?: JSX.Element; right?: JSX.Element }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: pointer ? 2 : 4 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={
            pointer
              ? { fontSize: density.title, fontWeight: "600", color: colors.text }
              : { fontSize: 15, fontWeight: "600", color: colors.text }
          }
        >
          {props.title}
        </Text>
        <If when={props.subtitle}>
          <Text style={{ fontSize: density.note, color: colors.muted }}>{props.subtitle}</Text>
        </If>
      </View>
      {props.right}
    </View>
  );
}

/** The flat surface a section's content sits on: one hairline edge, no shadow. */
const surface = (): ViewStyle => ({
  backgroundColor: colors.surface,
  borderRadius: density.surface,
  borderCurve: "continuous",
  borderWidth: 1,
  borderColor: colors.border,
  overflow: "hidden",
});

/**
 * A section of a demo: its title and subtitle above, then one flat surface
 * holding the content, padded (or bare with `flush`, for rows and stages that
 * reach its edges). `icon` names what it shows for callers that list it; the
 * section itself draws none.
 */
export function Card(props: {
  icon?: IconName;
  title?: string;
  subtitle?: JSX.Element;
  right?: JSX.Element;
  flush?: boolean;
  style?: ViewStyle;
  children: JSX.Element;
}) {
  return (
    <View style={[{ gap: 8 }, props.style ?? null]}>
      <If when={props.title}>
        <SectionHead title={props.title!} subtitle={props.subtitle} right={props.right} />
      </If>
      <View style={surface()}>
        <If when={!props.flush} else={props.children}>
          <Inset>{props.children}</Inset>
        </If>
      </View>
    </View>
  );
}

/**
 * A section's content area: padded and spaced, on the surface it sits on
 * (no surface of its own, so sections never nest boxes).
 */
export function Inset(props: { gap?: number; padding?: number; children: JSX.Element }) {
  return <View style={{ padding: props.padding ?? density.pad, gap: props.gap ?? density.gap }}>{props.children}</View>;
}

/** A caption row: a label on the left, a quieter note on the right. */
export function Caption(props: { label: JSX.Element; note?: JSX.Element }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
      <Text style={{ flex: 1, fontSize: density.body, color: colors.muted }}>{props.label}</Text>
      <If when={props.note}>
        <Text style={{ fontSize: density.note, color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.note}</Text>
      </If>
    </View>
  );
}

/** A large figure with a tinted note after it ("38 / 1k  would pass"). */
export function Figure(props: { value: string; unit?: string; note?: string; tone?: Tone }) {
  return (
    <Text style={{ fontSize: 32, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"], letterSpacing: -0.5 }}>
      {props.value}
      <If when={props.unit}>
        <Text style={{ fontSize: 17, fontWeight: "400", color: colors.muted }}> {props.unit}</Text>
      </If>
      <If when={props.note}>
        <Text style={{ fontSize: 15, fontWeight: "500", color: toneColor(props.tone ?? "accent") }}> {props.note}</Text>
      </If>
    </Text>
  );
}

export function Stat(props: { label: string; value: string; tone?: Tone; width?: `${number}%` }) {
  return (
    <View style={{ width: props.width, gap: 3, paddingVertical: 4 }}>
      <Text style={{ fontSize: 12, color: colors.muted }}>{props.label}</Text>
      <Text style={{ fontSize: 15, color: props.tone ? toneColor(props.tone) : colors.text, fontVariant: ["tabular-nums"] }}>
        {props.value}
      </Text>
    </View>
  );
}

/** A colored square and a label, for chart legends. */
export function Legend(props: { color: string; label: string; value?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 9, height: 9, borderRadius: 2.5, backgroundColor: props.color }} />
      <Text style={{ fontSize: 13, color: colors.muted }}>
        {props.label}
        <If when={props.value}>
          <Text style={{ color: colors.text, fontVariant: ["tabular-nums"] }}> {props.value}</Text>
        </If>
      </Text>
    </View>
  );
}

/** A row inside an inset, with a hairline above all but the first. */
export function Row(props: { first?: boolean; onPress?: () => void; children: JSX.Element }) {
  return (
    <View
      onPress={props.onPress}
      activeStyle={props.onPress ? { backgroundColor: colors.raised } : undefined}
      style={{
        minHeight: density.row,
        // Room above and below for two-line rows (a title and a note) and
        // their icon tiles, so nothing touches the lines between rows.
        paddingVertical: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderTopWidth: props.first ? 0 : 1,
        borderTopColor: colors.line,
      }}
    >
      {props.children}
    </View>
  );
}


/** A ring turning with its top arc in `tint`: work going on. */
export function Spinner(props: { size: number; tint: string }) {
  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        borderRadius: props.size / 2,
        borderWidth: Math.max(1.5, props.size / 8),
        borderColor: alpha(props.tint, 0.25),
        borderTopColor: props.tint,
        animationName: "spin",
        animationDuration: 800,
        animationTimingFunction: "linear",
        animationIterationCount: "infinite",
      }}
    />
  );
}

/** A titled section of controls (the demos' sections): `Card`'s look, `note` at its trailing edge. */
export function Section(props: { title: string; note?: string; style?: ViewStyle; children: JSX.Element }) {
  return (
    <Card
      title={props.title}
      right={
        props.note ? <Text style={{ fontSize: density.note, color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.note}</Text> : undefined
      }
      style={props.style}
    >
      {props.children}
    </Card>
  );
}

/** A horizontal meter with an optional marker (a limit). */
export function Meter(props: { value: number; tone?: Tone; marker?: number }) {
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.track, borderWidth: 1, ...finish.track }}>
      <View
        style={{
          width: `${Math.max(0, Math.min(1, props.value)) * 100}%`,
          height: 4,
          borderRadius: 2,
          backgroundColor: props.tone && props.tone !== "accent" ? toneColor(props.tone) : colors.accentFill,
        }}
      />
      <If when={props.marker !== undefined}>
        <View style={{ position: "absolute", left: `${(props.marker ?? 0) * 100}%`, top: -4, width: 2, height: 12, borderRadius: 1, backgroundColor: colors.text }} />
      </If>
    </View>
  );
}

/**
 * A panel at the bottom over a dimmed backdrop while `open` (`nsh/base`'s
 * `Sheet`, in the gallery's look); a press on the backdrop, Escape or the
 * back button closes it (`onClose`: set `open` to false).
 */
export function Sheet(props: { open: boolean; onClose: () => void; children: JSX.Element }) {
  return (
    <BaseSheet
      open={props.open}
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropStyle={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      popupStyle={{
        gap: 12,
        paddingTop: 8,
        paddingHorizontal: 16,
        paddingBottom: safeArea().bottom + 16,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        backgroundColor: colors.surface,
      }}
    >
      <View style={{ width: 36, height: 5, borderRadius: 3, alignSelf: "center", backgroundColor: colors.raised }} />
      {props.children}
    </BaseSheet>
  );
}

export { Icon, type IconName } from "./icons";

export { Tooltip, TooltipContent } from "./tooltip";
export * from "./tokens";
export * from "./controls";
export * from "./page";
