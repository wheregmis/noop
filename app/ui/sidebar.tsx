/** The sidebar's row: one look for every entry, with its own context menu. */
import type { JSX } from "nsh";
import { signal, View } from "nsh";
import { ContextMenu } from "nsh/base";
import { MenuPanel, menuBox } from "./menu";
import { alpha, colors } from "./theme";
import { corner, duration, fill, press, size } from "./tokens";
import { Tooltip } from "./tooltip";

/**
 * A sidebar row, `size.row` high. `menu` is its context menu: while that is open the row keeps a light fill (`fill.menuOpen`, fainter than selected),
 * so it is clear which row the menu is about.
 */
export function SidebarRow(props: { onPress?: () => void; selected?: boolean; title?: string; menu?: JSX.Element; children: JSX.Element }) {
  const menuOpen = signal(false);
  const row = (
    <View
      onPress={props.onPress}
      role={props.onPress ? "button" : undefined}
      accessibilityLabel={props.title}
      tooltip={props.title && !props.onPress ? <Tooltip label={props.title} placement="right" /> : undefined}
      hoverStyle={props.onPress && !props.selected ? { backgroundColor: alpha(colors.text, fill.ghostHover) } : undefined}
      activeStyle={props.onPress ? { transform: [{ scale: press.row }] } : undefined}
      style={{
        minHeight: size.row,
        minWidth: 0,
        overflow: "hidden",
        marginHorizontal: 10,
        marginVertical: 1,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 10,
        borderRadius: corner.item,
        borderCurve: "continuous",
        backgroundColor: props.selected ? alpha(colors.text, fill.selected) : menuOpen() ? alpha(colors.text, fill.menuOpen) : "transparent",
        transitionProperty: "background-color, transform",
        transitionDuration: duration.settle,
        transitionTimingFunction: "ease-out",
      }}
    >
      {props.children}
    </View>
  );
  if (!props.menu) return row;
  return (
    <ContextMenu margin={8} popupStyle={menuBox()} onOpenChange={({ open }) => menuOpen.set(open)} trigger={row}>
      <MenuPanel>{props.menu}</MenuPanel>
    </ContextMenu>
  );
}
