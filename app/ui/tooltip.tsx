import type { ViewStyle } from "nsh";
import { Text, View } from "nsh";
import { Tooltip as BaseTooltip } from "nsh/base";
import { createPresence, type PopupSide } from "./popup";
import { alpha, colors } from "./theme";
import { corner, font, leading, space } from "./tokens";

/** The bubble: the popup surface (the theme's `popover`, one hairline, a soft shadow) at the badge's tighter radius. */
const bubble = (): ViewStyle => ({
  flexDirection: "row",
  alignItems: "center",
  gap: space.md,
  paddingHorizontal: space.md,
  paddingVertical: space.xs,
  borderRadius: corner.icon,
  borderCurve: "continuous",
  borderWidth: 0.5,
  borderColor: alpha(colors.text, 0.12),
  backgroundColor: colors.popover,
  boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
});

/** What a tooltip shows: its text, then the keys of a `shortcut`, faint. Also the static sample of the preview. */
export function TooltipContent(props: { label: string; shortcut?: string; style?: ViewStyle }) {
  return (
    <View style={[bubble(), props.style ?? null]}>
      <Text style={{ fontSize: font.badge, lineHeight: leading.badge, color: colors.popoverText }}>{props.label}</Text>
      <If when={props.shortcut}>
        <Text style={{ fontSize: font.badge, lineHeight: leading.badge, color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.shortcut}</Text>
      </If>
    </View>
  );
}

/**
 * A short text as an element's `tooltip`: a `Tooltip` of `nsh/base` around `TooltipContent`, which comes in with
 * `popIn` from its side (`placement`, default above).
 */
export function Tooltip(props: { label: string; shortcut?: string; placement?: PopupSide; delay?: number }) {
  const presence = createPresence(props.placement ?? "top");
  return (
    <BaseTooltip placement={props.placement} delay={props.delay} onOpen={presence.show} onClose={presence.hide}>
      <TooltipContent label={props.label} shortcut={props.shortcut} style={presence.style} />
    </BaseTooltip>
  );
}
