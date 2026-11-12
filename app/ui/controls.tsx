/**
 * Noop's base controls. App code composes these and does not restyle them: a new look goes here, once.
 * API in gpui-component's shape: an enum `variant` and `size`, positive flags (`loading`, `selected`, `checked`).
 * Look in ReUI / shadcn's: flat fills, no decorative edges, the radius ladder of `tokens.ts`.
 *
 * States, the same on every control: hover is a whisper of the text color (`fill.hover`), a press a step more
 * (`fill.press`), keyboard focus the field's ring (`focusRing`), disabled half strength with no hover or press.
 */
import type { JSX, ViewStyle } from "nsh";
import { signal, Text, View } from "nsh";
import { Input as BaseInput, NumberInput as BaseNumberInput, Switch as BaseSwitch } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { alpha, colors, focusRing, motion, tints } from "./theme";
import { controlMetrics, corner, duration, edge, fill, font, leading, press as give, size, space, touch } from "./tokens";
import { follow, Spinner } from "./index";
import { Tooltip } from "./tooltip";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

/** The text color at `a`: the quiet fills of controls. */
const wash = (a: number): ViewStyle => ({ backgroundColor: alpha(colors.text, a) });

/** How strong a disabled control is drawn. */
const DISABLED = 0.45;

/** The metrics of a button size: frame, padding, gap, icon and type move together (`controlMetrics`). */
const metrics = controlMetrics;

/** A labelled button. `primary` is the one main action of an area; `outline` a quiet secondary choice. */
export function Button(props: {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** A key shown before the label (a shortcut, a number to press). */
  kbd?: string;
  /** A short faint note below the label, sharing its available width. */
  note?: string;
  /** Work started by it is going on: a spinner in the icon's place, no presses. */
  loading?: boolean;
  disabled?: boolean;
  /** The option the owner picked: a blue check at the end and a selected fill, not dimmed. */
  checked?: boolean;
  /** Grows to share a row with its siblings. */
  grow?: boolean;
  /** An outline button's color: the label and edge take the accent (the main action) or danger (a destructive one). */
  tone?: "accent" | "danger";
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const variant = () => props.variant ?? "secondary";
  const m = () => metrics(props.size === "sm");
  const over = signal(false);
  const idle = () => props.disabled || props.loading;
  const toned = () => (props.tone === "danger" ? colors.danger : props.tone === "accent" ? colors.accent : null);
  const fg = () => {
    if (props.checked) return colors.text;
    if (toned()) return toned()!;
    switch (variant()) {
      case "primary":
        return colors.onAccent;
      case "danger":
        return colors.danger;
      case "ghost":
        // A ghost button's label comes up to full strength under the pointer, as its fill comes in.
        return over() && !idle() ? colors.text : colors.muted;
      default:
        return colors.text;
    }
  };
  const look = (): ViewStyle => {
    if (props.checked) return { ...wash(fill.selected), borderColor: "transparent" };
    switch (variant()) {
      case "primary":
        return { backgroundColor: colors.accentFill, borderColor: "transparent", boxShadow: "0 1px 2px rgba(0,0,0,0.12)" };
      // a raised control: a hairline edge and a soft drop, on the field's fill
      case "secondary":
        return { backgroundColor: colors.field, borderColor: alpha(colors.text, edge.rest), boxShadow: "0 1px 2px rgba(0,0,0,0.06)" };
      case "outline":
        return { backgroundColor: "transparent", borderColor: toned() ? alpha(toned()!, 0.45) : alpha(colors.text, edge.rest), boxShadow: "0 1px 2px rgba(0,0,0,0.04)" };
      case "ghost":
        return { backgroundColor: "transparent", borderColor: "transparent" };
      case "danger":
        return { backgroundColor: tints.danger, borderColor: "transparent" };
    }
  };
  const hover = (): ViewStyle | undefined => {
    if (idle() || props.checked) return undefined;
    switch (variant()) {
      case "primary":
        return { opacity: 0.88 };
      case "danger":
        return { backgroundColor: alpha(colors.danger, 0.16) };
      case "secondary":
      case "outline":
        return toned() ? { backgroundColor: alpha(toned()!, 0.08), borderColor: alpha(toned()!, 0.7) } : { ...wash(fill.ghostHover / 2), borderColor: alpha(colors.text, edge.hover) };
      default:
        return wash(fill.ghostHover);
    }
  };
  const press = (): ViewStyle | undefined => {
    if (idle() || props.checked) return undefined;
    switch (variant()) {
      case "primary":
        return { opacity: 0.78 };
      case "danger":
        return { backgroundColor: alpha(colors.danger, 0.22) };
      case "secondary":
      case "outline":
        return toned() ? { backgroundColor: alpha(toned()!, 0.14), borderColor: alpha(toned()!, 0.7), boxShadow: "none" } : { ...wash(fill.ghostPress / 2), borderColor: alpha(colors.text, edge.hover), boxShadow: "none" };
      default:
        return wash(fill.ghostPress);
    }
  };
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: !!props.disabled, ...(props.checked ? { checked: true } : {}) }}
      onPress={() => !idle() && props.onPress()}
      onMouseEnter={() => over.set(true)}
      onMouseLeave={() => over.set(false)}
      hoverStyle={hover()}
      activeStyle={idle() || props.checked ? undefined : { ...press(), transform: [{ scale: give.control }] }}
      focusStyle={focusRing()}
      style={{
        minHeight: m().height,
        maxWidth: "100%",
        flexShrink: 1,
        flexGrow: props.grow ? 1 : 0,
        flexDirection: "row",
        // top-aligned, so a label that wraps (an option's sentence) keeps its first line beside the icon; the padding
        // centres a single line in the size's height
        alignItems: "flex-start",
        justifyContent: props.grow ? "center" : "flex-start",
        gap: m().gap,
        paddingHorizontal: m().padX,
        paddingVertical: (m().height - m().line) / 2 - 1,
        borderRadius: corner.control,
        borderCurve: "continuous",
        borderWidth: 1,
        opacity: props.disabled && !props.checked ? DISABLED : 1,
        cursor: "default",
        transitionProperty: "background-color, border-color, box-shadow, opacity, transform",
        transitionDuration: duration.settle,
        transitionTimingFunction: "ease-out",
        ...look(),
      }}
    >
      <If when={props.kbd}>
        <Kbd keys={props.kbd!} inverted={variant() === "primary" && !props.checked} />
      </If>
      <If when={props.loading}>
        <View style={{ marginTop: (m().line - m().icon) / 2 + 1 }}><Spinner size={m().icon - 2} tint={fg()} /></View>
      </If>
      <If when={!props.loading && !props.checked && props.icon}>
        <View style={{ marginTop: (m().line - m().icon) / 2 }}><Icon name={props.icon!} size={m().icon} tint={fg()} /></View>
      </If>
      <View style={{ flexShrink: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ textAlign: props.grow ? "center" : "left", fontSize: m().font, lineHeight: m().line, fontWeight: "500", color: fg() }}>{props.label}</Text>
        <If when={props.note}>
          <Text style={{ fontSize: font.sm, lineHeight: leading.sm, color: variant() === "primary" && !props.checked ? alpha(colors.onAccent, 0.7) : colors.faint }}>{props.note}</Text>
        </If>
      </View>
      {/* the picked option: a blue check at the end */}
      <If when={props.checked}>
        <View style={{ marginTop: (m().line - m().icon) / 2 }}><Icon name="check" size={m().icon} tint={colors.info} /></View>
      </If>
    </View>
  );
}

/**
 * An icon-only button. `ghost` (default) is the square quiet button of toolbars and the sidebar, in two sizes;
 * `primary` the composer's round send, which keeps its circle. `label` is its accessible name and tooltip.
 */
export function IconButton(props: {
  icon: IconName;
  label: string;
  variant?: "ghost" | "primary";
  size?: ButtonSize;
  shortcut?: string;
  /** Shows as on (an open panel, a toggled mode). */
  selected?: boolean;
  disabled?: boolean;
  /** Show `label` as a tooltip on hover (default on with a pointer). */
  tooltip?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const primary = () => props.variant === "primary";
  const sm = () => props.size === "sm";
  // the same scale, fills, corner and press as `Button` (gpui-kit's icon-only button): a square of the size's height
  const m = () => metrics(sm());
  const box = () => (primary() ? (touch ? 44 : 36) : m().height);
  const glyph = () => m().icon;
  const over = signal(false);
  const showTip = () => !touch && props.tooltip !== false;
  // The glyph comes up from muted to the text color under the pointer and while selected.
  const tint = () => (props.selected || (over() && !props.disabled) ? colors.text : colors.muted);
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={props.disabled ? { disabled: true } : props.selected === undefined ? undefined : { selected: props.selected }}
      onPress={() => !props.disabled && props.onPress()}
      onMouseEnter={() => over.set(true)}
      onMouseLeave={() => over.set(false)}
      tooltip={showTip() ? <Tooltip label={props.label} shortcut={props.shortcut} /> : undefined}
      hoverStyle={props.disabled ? undefined : primary() ? { opacity: 0.88 } : wash(fill.ghostHover)}
      activeStyle={props.disabled ? undefined : { ...(primary() ? { opacity: 0.78 } : wash(fill.ghostPress)), transform: [{ scale: give.control }] }}
      focusStyle={focusRing()}
      style={{
        width: box(),
        height: box(),
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: primary() ? box() / 2 : corner.control,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: "transparent",
        opacity: props.disabled ? DISABLED : 1,
        cursor: "default",
        transitionProperty: "background-color, opacity, transform",
        transitionDuration: duration.settle,
        transitionTimingFunction: "ease-out",
        ...(props.selected && !primary() ? wash(fill.selected) : {}),
      }}
    >
      <If when={primary()} else={<Glyph name={props.icon} size={glyph()} tint={tint()} />}>
        <View style={{ width: touch ? 32 : 28, height: touch ? 32 : 28, borderRadius: touch ? 16 : 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentFill }}>
          <Icon name={props.icon} size={touch ? 18 : 16} tint={colors.onAccent} />
        </View>
      </If>
    </View>
  );
}

/**
 * An icon button's glyph: when it swaps (copy → check), the new one pops in from a little smaller. A single icon is kept and re-scaled
 * in place: swapping keyed children let the outgoing glyph linger beside the incoming one, so copy and check showed overlapped.
 */
function Glyph(props: { name: IconName; size: number; tint: string }) {
  const pop = signal(false);
  let last = props.name;
  let t: ReturnType<typeof setTimeout> | undefined;
  const name = () => {
    const n = props.name;
    if (n !== last) {
      last = n;
      pop.set(true);
      clearTimeout(t);
      t = setTimeout(() => pop.set(false), 16);
    }
    return n;
  };
  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
        opacity: pop() ? 0 : 1,
        transform: [{ scale: pop() ? 0.6 : 1 }],
        transitionProperty: pop() ? "none" : "opacity, transform",
        transitionDuration: duration.settle,
        transitionTimingFunction: "ease-out",
      }}
    >
      <Icon name={name()} size={props.size} tint={props.tint} />
    </View>
  );
}

export type BadgeVariant = "neutral" | "accent" | "info" | "warn" | "danger";

/** A short tag: a tone's tint behind its color. Most badges stay neutral. */
export function Badge(props: { label: string; variant?: BadgeVariant }) {
  const v = () => props.variant ?? "neutral";
  const fg = () => (v() === "neutral" ? colors.muted : v() === "accent" ? colors.text : colors[v() as "info" | "warn" | "danger"]);
  const bg = () => (v() === "neutral" ? alpha(colors.text, fill.rest) : tints[v() as "accent" | "info" | "warn" | "danger"]);
  return (
    <View style={{ height: 20, paddingHorizontal: space.sm, justifyContent: "center", borderRadius: corner.badge, borderCurve: "continuous", backgroundColor: bg() }}>
      <Text style={{ fontSize: font.badge, lineHeight: leading.badge, fontWeight: "500", color: fg() }}>{props.label}</Text>
    </View>
  );
}

/**
 * A count (unread messages, decisions waiting), a small round pill: `accent` is the filled one that asks to be seen, `neutral` a quiet
 * number. Over 99 it reads `99+`.
 */
export function Count(props: { value: number | string; variant?: "accent" | "neutral"; testID?: string; accessibilityLabel?: string }) {
  const accent = () => props.variant !== "neutral";
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      style={{
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: accent() ? colors.accentFill : alpha(colors.text, fill.rest),
      }}
    >
      <Text style={{ fontSize: 10.5, lineHeight: 14, fontWeight: "600", color: accent() ? colors.onAccent : colors.muted, fontVariant: ["tabular-nums"] }}>
        {typeof props.value === "number" && props.value > 99 ? "99+" : String(props.value)}
      </Text>
    </View>
  );
}

/** A status: running blue, waiting yellow, online / done green, error red; queued and idle are grey. */
export type IndicatorStatus = "online" | "running" | "queued" | "waiting" | "done" | "idle" | "error";

/** The color of a status, for anything else that shows one (a task chip's dot). */
export const statusColor = (status: IndicatorStatus): string =>
  ({ online: colors.up, running: colors.info, queued: colors.muted, waiting: colors.pending, done: colors.up, idle: colors.faint, error: colors.danger })[status];

/** A status dot. */
export function Indicator(props: { status: IndicatorStatus }) {
  return <View accessibilityLabel={props.status} style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, backgroundColor: statusColor(props.status) }} />;
}

/** A key, or keys: `1`, `Enter`, `⌘K`. `inverted` sits on a filled (primary) surface. */
export function Kbd(props: { keys: string; inverted?: boolean }) {
  return (
    <View
      style={{
        minWidth: 20,
        height: 20,
        paddingHorizontal: 5,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: corner.key,
        borderCurve: "continuous",
        backgroundColor: props.inverted ? alpha(colors.onAccent, 0.18) : alpha(colors.text, fill.rest),
      }}
    >
      <Text style={{ fontSize: font.key, lineHeight: leading.key, fontWeight: "500", color: props.inverted ? colors.onAccent : colors.muted, fontVariant: ["tabular-nums"] }}>{props.keys}</Text>
    </View>
  );
}

/**
 * A hairline. In flow by default (`vertical` for a column divider); `top` lays it on the top edge of a row instead,
 * inset `inset` points from the leading side (16 by default), so stacked rows read as one list.
 */
export function Separator(props: { vertical?: boolean; top?: boolean; inset?: number }) {
  return (
    <View
      style={
        props.top
          ? { position: "absolute", top: 0, left: props.inset ?? 16, right: 0, height: 0.5, backgroundColor: colors.line }
          : props.vertical
            ? { width: 0.5, alignSelf: "stretch", backgroundColor: colors.line }
            : { height: 0.5, marginLeft: props.inset ?? 0, backgroundColor: colors.line }
      }
    />
  );
}

/** Room to press around a switch, on every side, without taking more room: on touch 26 + 2 × 9 = 44. */
const SWITCH_SLOP = touch ? 9 : 8;

/**
 * An on / off switch: a flat track whose color springs to green, and a round knob whose checked position comes from
 * layout (a leading margin), so it moves to the trailing end in place. 32 × 18 with a pointer, 44 × 26 on a touch screen.
 */
export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; label?: string; disabled?: boolean; testID?: string }) {
  const [width, height, inset] = touch ? [44, 26, 2] : [32, 18, 2];
  const knob = height - 2 * inset;
  const t = follow(() => (props.checked ? 1 : 0), motion.move);
  return (
    <BaseSwitch
      testID={props.testID}
      checked={props.checked}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange(checked)}
      accessibilityLabel={props.label}
      hoverStyle={{ opacity: 0.88 }}
      activeStyle={{ opacity: 0.75 }}
      disabledStyle={{ opacity: DISABLED }}
      // The ring lies around the track, inside the room to press.
      focusStyle={focusRing(-SWITCH_SLOP)}
      style={{ margin: -SWITCH_SLOP, padding: SWITCH_SLOP, borderRadius: height / 2 + SWITCH_SLOP, cursor: "default" }}
      trackStyle={{
        width,
        height,
        padding: inset,
        borderRadius: height / 2,
        backgroundColor: t.interpolate({ inputRange: [0, 1], outputRange: [colors.track, colors.switchOn] }),
      }}
      thumbStyle={{
        width: knob,
        height: knob,
        borderRadius: knob / 2,
        backgroundColor: colors.knob,
        boxShadow: "0 1px 2px rgba(0,0,0,0.18)",
        // The checked position comes from layout: a leading margin puts the knob at the trailing end.
        marginLeft: props.checked ? width - 2 * inset - knob : 0,
      }}
    />
  );
}

/** A one-line text field in the field look: the radius ladder's `field` step, as tall as a `md` button. */
export function Input(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Hides what is typed (a password, a code). */
  masked?: boolean;
  readonly?: boolean;
  onSubmit?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  /** Layout only (`flex`, a width): the look is the field's. */
  style?: ViewStyle;
}): JSX.Element {
  return (
    <BaseInput
      testID={props.testID}
      value={props.value}
      placeholder={props.placeholder}
      masked={props.masked}
      readonly={props.readonly}
      accessibilityLabel={props.accessibilityLabel ?? props.placeholder}
      class="placeholder:text-faint"
      onChange={({ value }) => props.onChange(value)}
      onSubmit={() => props.onSubmit?.()}
      hoverStyle={{ borderColor: alpha(colors.text, 0.28) }}
      focusStyle={focusRing()}
      style={{
        minHeight: size.field,
        paddingHorizontal: space.lg,
        borderRadius: corner.field,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.fieldBorder,
        backgroundColor: colors.field,
        color: colors.text,
        fontSize: font.md,
        transitionProperty: "border-color",
        transitionDuration: duration.quick,
        ...props.style,
      }}
    />
  );
}

/**
 * A number typed or stepped (`nsh/base`'s `NumberInput`) in the field's frame: the value in the middle, a minus and a
 * plus at the ends, each set off by a hairline and taking the ghost fills, as gpui-component's `NumberInput`.
 */
export function NumberField(props: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const h = size.field;
  const stepStyle = (left: boolean): ViewStyle => ({
    width: touch ? 44 : 30, alignItems: "center", justifyContent: "center",
    [left ? "borderRightWidth" : "borderLeftWidth"]: 1, borderColor: colors.line,
    transitionProperty: "background-color", transitionDuration: duration.quick,
  });
  const steps = "hover:bg-foreground/8 active:bg-foreground/14 disabled:opacity-35";
  return (
    <BaseNumberInput
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step}
      disabled={props.disabled}
      onChange={({ value }) => value != null && props.onChange(value)}
      hoverStyle={{ borderColor: alpha(colors.text, 0.28) }}
      focusStyle={focusRing()}
      style={{
        flexDirection: "row", alignItems: "stretch", height: h, overflow: "hidden",
        borderRadius: corner.field, borderCurve: "continuous", borderWidth: 1, borderColor: colors.fieldBorder,
        backgroundColor: colors.field, boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        opacity: props.disabled ? DISABLED : 1,
        transitionProperty: "border-color", transitionDuration: duration.quick,
      }}
      inputStyle={{ width: 44, textAlign: "center", fontSize: font.md, color: colors.text, fontVariant: ["tabular-nums"] }}
      decrementButtonClass={steps}
      incrementButtonClass={steps}
      decrementButtonStyle={stepStyle(true)}
      incrementButtonStyle={stepStyle(false)}
      decrementButton={<View testID={props.testID && `${props.testID}-dec`}><Icon name="minus" size={14} tint={colors.muted} /></View>}
      incrementButton={<View testID={props.testID && `${props.testID}-inc`}><Icon name="plus" size={14} tint={colors.muted} /></View>}
    />
  );
}
