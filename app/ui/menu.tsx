/**
 * Menus: the popup surface, a row and a separator, shared by every `Menu`, `ContextMenu` and `Submenu` in the app.
 * App code passes `menuPopup()` as `popupStyle` and fills it with `MenuRow` / `MenuSep`; it does not restyle them.
 */
import type { JSX, ViewStyle } from "nsh";
import { platform, Text, View } from "nsh";
import { MenuItem, MenuSeparator } from "nsh/base";
import { Icon, type IconName } from "./icons";
import type { PopupSide } from "./popup";
import { alpha, colors } from "./theme";
import { corner, duration, fill, font, leading, menuGlass, space, touch } from "./tokens";

/** iOS menus float as Liquid Glass with the system's rounder corners; other platforms keep the solid popup. */
const ios = platform.os === "ios";

/**
 * The popup of a menu: on iOS the glass surface (`menuGlass`), elsewhere the surface, one hairline, a soft shadow.
 */
export const menuPopup = (): ViewStyle => ios
  ? { minWidth: 200, padding: space.sm, ...menuGlass(colors.surface, corner.sheet) }
  : {
      minWidth: 160,
      padding: space.xs,
      borderRadius: corner.field,
      borderCurve: "continuous",
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      boxShadow: "0 4px 14px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05)",
    };

/** A row's corner inside the popup: concentric with the popup's corner across its padding. */
export const menuRowCorner = ios ? corner.sheet - space.sm : corner.control - 2;

/**
 * The popup box a `Menu` / `ContextMenu` gets (`popupStyle`, which its submenus take too): it carries the surface and
 * its shadow itself, since the menu scrolls its contents in a clipping view and a shadow drawn inside would be cut at
 * the box's edges. It comes in with `menuEnter` as `popupStartingStyle`.
 */
export const menuBox = (look: ViewStyle = menuPopup()): ViewStyle => ({
  ...look,
  transitionProperty: "opacity, transform",
  transitionDuration: 150,
  transitionTimingFunction: "ease-out",
});

/** The first frame of a menu's box (`popupStartingStyle`): `popIn`'s fade, grow and slide out of the trigger. */
export const menuEnter = (side: PopupSide = "bottom"): ViewStyle => {
  const away = side === "top" || side === "left" ? 4 : -4;
  const slide = side === "top" || side === "bottom" ? { translateY: away } : { translateX: away };
  return { opacity: 0, transform: [{ scale: 0.96 }, slide] };
};

/** A menu's contents; the surface is the popup box's (`menuBox`). */
export function MenuPanel(props: { style?: ViewStyle; children: JSX.Element }) {
  return <View style={props.style}>{props.children}</View>;
}

/** A row's hover and press: the ghost control's fills. */
export const menuRowHover = (): ViewStyle => ({ backgroundColor: alpha(colors.text, fill.ghostHover) });
const menuRowPress = (): ViewStyle => ({ backgroundColor: alpha(colors.text, fill.ghostPress) });

/** A menu row: an optional icon and a label (`danger` for a destructive one), or `children` for a custom row. */
export function MenuRow(props: {
  label?: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  testID?: string;
  children?: JSX.Element;
}) {
  const fg = () => (props.danger ? colors.danger : colors.text);
  return (
    <MenuItem
      testID={props.testID}
      disabled={props.disabled}
      onSelect={props.onSelect}
      hoverStyle={menuRowHover()}
      activeStyle={menuRowPress()}
      disabledStyle={{ opacity: 0.45 }}
      style={{
        minHeight: touch ? 44 : 30,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingHorizontal: space.md,
        borderRadius: menuRowCorner,
        borderCurve: "continuous",
        transitionProperty: "background-color",
        transitionDuration: duration.quick,
      }}
    >
      {props.icon ? <Icon name={props.icon} size={15} tint={props.danger ? colors.danger : colors.muted} /> : null}
      {props.label ? <Text style={{ flex: 1, minWidth: 0, numberOfLines: 1, fontSize: font.sm + 1, lineHeight: leading.sm, color: fg() }}>{props.label}</Text> : null}
      {props.children}
    </MenuItem>
  );
}

/** The line between groups of a menu. */
export function MenuSep() {
  return <MenuSeparator style={{ height: 1, marginVertical: space.xs, marginHorizontal: space.md, backgroundColor: alpha(colors.text, 0.14) }} />;
}
