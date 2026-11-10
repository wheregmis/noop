import { cleanup, Overlay, platform, reduceMotion, safeArea, signal, Text } from "nsh";
import { Toast, ToastManager, ToastStack, type ToastEntry } from "nsh/base";
import { colors, Icon, menuPopup } from "./ui";

/** A phone shows it as a banner under the status bar; a desktop or the web at the bottom right, as their notices do. */
const mobile = platform.os === "ios" || platform.os === "android";

/** One retained save confirmation, shared by all settings pages. */
export function createSettingsToast() {
  const manager = new ToastManager();
  const entries = signal<ToastEntry[]>([]);
  const expanded = signal(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const sync = () => entries.set(manager.visible(1));
  function run() {
    sync();
    timer ??= setInterval(() => {
      const result = manager.advance(expanded());
      if (result.changed) sync();
      if (manager.isEmpty()) { clearInterval(timer); timer = undefined; }
    }, 50);
  }
  function dismiss() {
    if (disposed || manager.isEmpty()) return;
    manager.dismissAll();
    run();
  }
  cleanup(() => { disposed = true; clearInterval(timer); manager.dispose(); });
  return {
    entries, expanded, dismiss,
    show(message: string) {
      if (disposed) return;
      manager.push("settings-saved", message, { timeout: 2000 });
      run();
    },
  };
}

export function SettingsToast(props: { state: ReturnType<typeof createSettingsToast> }) {
  return (
    <Overlay
      style={mobile
        ? { pointerEvents: "box-none", left: 0, right: 0, top: 0, paddingTop: safeArea().top + 8, paddingHorizontal: 12, alignItems: "center" }
        : { pointerEvents: "box-none", right: 0, bottom: 0, padding: 16, alignItems: "flex-end" }}
    >
      <ToastStack closeOnEscape={!mobile} placement={mobile ? "topCenter" : "bottomRight"} style={{ width: mobile ? "100%" : 300, maxWidth: mobile ? 420 : "100%" }}
        motion={reduceMotion() ? { duration: 0 } : undefined}
        onExpandedChange={({ expanded }) => props.state.expanded.set(expanded)}
        onCancel={props.state.dismiss}>
        <Each of={props.state.entries()} key={(entry) => entry.id}>
          {(entry) => (
            <Toast testID="settings-toast" transitionStatus={entry().status}
              accessibilityLabel={String(entry().value)} onDismissRequest={props.state.dismiss}
              class="transition-all duration-200 motion-reduce:transition-none"
              startingClass={reduceMotion() ? "" : mobile ? "opacity-0 -translate-y-3" : "opacity-0 translate-y-2"}
              endingClass={mobile ? "opacity-0 -translate-y-3" : "opacity-0"} swipingClass="transition-none"
              style={{
                ...menuPopup(),
                minWidth: 0,
                flexDirection: "row", alignItems: "center", gap: 10,
                paddingHorizontal: 14, paddingVertical: mobile ? 12 : 10,
                // a phone's banner is a rounder capsule, as the system's
                ...(mobile ? { borderRadius: 18 } : {}),
              }}>
              <Icon name="check" size={16} tint={colors.up} />
              <Text style={{ flex: 1, minWidth: 0, fontSize: mobile ? 15 : 13.5, color: colors.text }}>{String(entry().value)}</Text>
            </Toast>
          )}
        </Each>
      </ToastStack>
    </Overlay>
  );
}
