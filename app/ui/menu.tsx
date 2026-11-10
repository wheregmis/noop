/**
 * Menus: the popup surface, a row and a separator, shared by every `Menu`, `ContextMenu` and `Submenu` in the app.
 * App code passes `menuPopup()` as `popupStyle` and fills it with `MenuRow` / `MenuSep`; it does not restyle them.
 */
import type { JSX, ViewStyle } from "nsh";
import { platform, Text } from "nsh";
import { MenuItem, MenuSeparator } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { PopIn, type PopupSide } from "./popup";
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
 * The popup box a `Menu` / `ContextMenu` gets (`popupStyle`): bare, so the look rides on `MenuPanel` inside it, which
 * the menu makes on every opening and which so comes in with `popIn` each time.
 */
export const menuBox = (): ViewStyle => ({ padding: 0, borderWidth: 0, backgroundColor: "transparent", boxShadow: "none" });

/** A menu's contents on the popup surface, popping in as the menu opens. */
export function MenuPanel(props: { side?: PopupSide; style?: ViewStyle; children: JSX.Element }) {
  return <PopIn side={props.side} style={{ ...menuPopup(), ...props.style }}>{props.children}</PopIn>;
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
