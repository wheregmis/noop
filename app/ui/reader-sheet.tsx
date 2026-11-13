import { keymap, View, type JSX } from "nsh";
import { ResizablePanel, ResizablePanelGroup, Sheet } from "nsh/base";
import { colors } from "./theme";

/** A report overlays the conversation without resizing or remounting its chat. */
export function ReaderSheet(props: {
  open: boolean;
  availableWidth: number;
  insetLeft: number;
  width: number;
  expanded: boolean;
  onResize: (width: number) => void;
  onClose: () => void;
  children: JSX.Element;
}) {
  const resize = (delta: number) => {
    if (props.open && !props.expanded) props.onResize(Math.max(Math.min(360, props.availableWidth), Math.min(props.availableWidth, props.width + delta)));
  };
  keymap.bind("mod+alt+left", () => resize(40), { when: "always" });
  keymap.bind("mod+alt+right", () => resize(-40), { when: "always" });
  return (
    <Sheet side="right" open={props.open} onOpenChange={({ open }) => { if (!open) props.onClose(); }}
      backdropClass="bg-scrim" backdropStyle={{ left: props.insetLeft }}
      popupStyle={{ width: props.availableWidth }}>
      <ResizablePanelGroup
        handleClass="bg-border group-hover:bg-primary group-active:bg-primary"
        handleAccessibilityLabel="Resize report reader"
        onResize={({ sizes }) => { if (!props.expanded && sizes.length === 2) props.onResize(sizes[1]); }}>
        <ResizablePanel size={props.availableWidth - props.width} minSize={0} visible={!props.expanded}>
          <View accessibilityLabel="Close reader" role="button" onPress={props.onClose} style={{ flex: 1 }} />
        </ResizablePanel>
        <ResizablePanel size={props.expanded ? props.availableWidth : props.width} minSize={Math.min(360, props.availableWidth)}
          maxSize={props.availableWidth}>
          <View testID="doc-side" style={{ flex: 1, minWidth: 0, backgroundColor: colors.background }}>
            {props.children}
          </View>
        </ResizablePanel>
      </ResizablePanelGroup>
    </Sheet>
  );
}
