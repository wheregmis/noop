/**
 * The component preview: every control of `ui/` in each variant, size and state, for review and screenshots.
 * Run it with `nsh run app/Preview.tsx`; it follows the system appearance, and the button at the top flips it.
 */
import { Scroll, mount, signal, setColorScheme, colorScheme, Text, View } from "nsh";
import type { JSX } from "nsh";
import {
  Badge,
  Button,
  colors,
  Count,
  font,
  IconButton,
  Indicator,
  Input,
  Kbd,
  leading,
  Separator,
  space,
  Switch,
  Tooltip,
  TooltipContent,
  type BadgeVariant,
  type ButtonVariant,
  type IndicatorStatus,
} from "./ui";

const VARIANTS: ButtonVariant[] = ["primary", "secondary", "outline", "ghost", "danger"];
const BADGES: BadgeVariant[] = ["neutral", "accent", "info", "warn", "danger"];
const STATUSES: IndicatorStatus[] = ["running", "waiting", "done", "online", "queued", "idle", "error"];
const title = (s: string) => s[0].toUpperCase() + s.slice(1);

function Group(props: { title: string; children: JSX.Element }) {
  return (
    <View style={{ gap: space.lg }}>
      <Text role="header" style={{ fontSize: font.sm, lineHeight: leading.sm, fontWeight: "600", color: colors.muted }}>{props.title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md }}>{props.children}</View>
    </View>
  );
}

function Preview() {
  const on = signal(true);
  const off = signal(false);
  const text = signal("");
  return (
    <Scroll style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ padding: 32, gap: space.xxl, maxWidth: 880 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 22, lineHeight: 28, fontWeight: "700", color: colors.text }}>Noop UI</Text>
          <Button size="sm" variant="ghost" icon={colorScheme() === "dark" ? "sun" : "moon"} label={colorScheme() === "dark" ? "Light" : "Dark"} onPress={() => setColorScheme(colorScheme() === "dark" ? "light" : "dark")} />
        </View>
        <Group title="Button · md">
          {VARIANTS.map((v) => <Button variant={v} label={title(v)} onPress={() => {}} />)}
        </Group>
        <Group title="Button · sm">
          {VARIANTS.map((v) => <Button size="sm" variant={v} label={title(v)} onPress={() => {}} />)}
        </Group>
        <Group title="Button · icon, loading, disabled, checked, kbd, note">
          <Button variant="primary" icon="check" label="Approve" onPress={() => {}} />
          <Button icon="bell" label="Notify" onPress={() => {}} />
          <Button loading variant="primary" label="Sending…" onPress={() => {}} />
          <Button disabled label="Disabled" onPress={() => {}} />
          <Button checked disabled label="B: Upgrade" onPress={() => {}} />
          <Button kbd="1" label="Write tests" note="Recommended" onPress={() => {}} />
        </Group>
        <Group title="IconButton · md, sm, selected, disabled, send">
          <IconButton icon="sidebar" label="Show sidebar" shortcut="⌘B" onPress={() => {}} />
          <IconButton icon="sliders" label="Settings" selected onPress={() => {}} />
          <IconButton icon="close" label="Close" shortcut="Esc" onPress={() => {}} />
          <IconButton size="sm" icon="copy" label="Copy" onPress={() => {}} />
          <IconButton size="sm" icon="reply" label="Reply" onPress={() => {}} />
          <IconButton disabled icon="trash" label="Delete" onPress={() => {}} />
          <IconButton variant="primary" icon="arrow-up" label="Send" shortcut="Enter" onPress={() => {}} />
        </Group>
        <Group title="Input · with a md button">
          <Input value={text()} onChange={text.set} placeholder="Channel name" style={{ width: 320 }} />
          <Button label="Save" variant="primary" onPress={() => {}} />
          <Button label="Cancel" variant="ghost" onPress={() => {}} />
        </Group>
        <Separator />
        <Group title="Badge · Count">
          {BADGES.map((v) => <Badge variant={v} label={v} />)}
          <Count value={4} />
          <Count value={128} />
          <Count value={2} variant="neutral" />
        </Group>
        <Group title="Indicator">
          {STATUSES.map((s) => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingRight: space.sm }}>
              <Indicator status={s} />
              <Text style={{ fontSize: font.sm, lineHeight: leading.sm, color: colors.muted }}>{s}</Text>
            </View>
          ))}
        </Group>
        <Group title="Kbd · Switch · Tooltip">
          <Kbd keys="⌘K" />
          <Kbd keys="Enter" />
          <Kbd keys="1" />
          <View style={{ width: space.md }} />
          <Switch checked={on()} onChange={on.set} label="Enabled" />
          <Switch checked={off()} onChange={off.set} label="Disabled" />
          <Switch checked disabled onChange={() => {}} label="Locked" />
          <View style={{ width: space.md }} />
          <View tooltip={<Tooltip label="Show sidebar" shortcut="⌘B" />}>
            <Button size="sm" variant="outline" label="Hover me" onPress={() => {}} />
          </View>
          <TooltipContent label="Show sidebar" shortcut="⌘B" />
        </Group>
      </View>
    </Scroll>
  );
}

mount(Preview);
