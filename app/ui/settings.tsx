/** Settings: a titled group of items, each item a row that answers the pointer. */
import type { JSX, ViewStyle } from "nsh";
import { Text, View } from "nsh";
import { Radio, RadioGroup } from "nsh/base";
import { Icon } from "./icons";
import { alpha, colors } from "./theme";
import { corner, duration, fill } from "./tokens";

/** The settings card's edge and dividers: lighter than `colors.line`, which read too heavy on a large card. */
export const cardEdge = () => alpha(colors.text, 0.07);

/** A titled group of settings items on one card. */
export function SettingsGroup(props: { title: string; hint?: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 3, paddingHorizontal: 2 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{props.title}</Text>
        {props.hint ? <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted }}>{props.hint}</Text> : null}
      </View>
      <View style={{ borderRadius: corner.field + 2, borderCurve: "continuous", borderWidth: 1, borderColor: cardEdge(), overflow: "hidden" }}>{props.children}</View>
    </View>
  );
}

/** One item of a `SettingsGroup`: a hairline above all but the `first`, and a ghost hover fill under the pointer. */
export function SettingsItem(props: { first?: boolean; testID?: string; style?: ViewStyle; onPress?: () => void; children: JSX.Element }) {
  return (
    <View
      testID={props.testID}
      onPress={props.onPress}
      role={props.onPress ? "button" : undefined}
      hoverStyle={{ backgroundColor: alpha(colors.text, fill.ghostHover / 2) }}
      style={{
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: props.first ? 0 : 1,
        borderTopColor: cardEdge(),
        transitionProperty: "background-color",
        transitionDuration: duration.quick,
        ...props.style,
      }}
    >
      {props.children}
    </View>
  );
}

/** One choice of a `SettingsChoices` group. */
export type SettingsChoice = { id: string; label: string; detail?: string; testID?: string };

/**
 * A group of exclusive choices (a language, a mode) as rows of a `SettingsGroup`: the picked one checked, each row
 * taking the ghost hover fill.
 */
export function SettingsChoices(props: { label: string; choices: SettingsChoice[]; selected: string | null; onPick: (id: string) => void }) {
  return (
    <RadioGroup>
      <Each of={props.choices} key={(c) => c.id}>
        {(c, i) => (
          <Radio
            testID={c().testID}
            checked={c().id === props.selected}
            onChange={() => props.onPick(c().id)}
            accessibilityLabel={c().label}
            hoverStyle={{ backgroundColor: alpha(colors.text, fill.ghostHover / 2) }}
            activeStyle={{ backgroundColor: alpha(colors.text, fill.ghostPress / 2) }}
            style={{
              minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10,
              borderTopWidth: i() === 0 ? 0 : 1, borderTopColor: cardEdge(),
              transitionProperty: "background-color", transitionDuration: duration.quick,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 15, color: colors.text }}>{c().label}</Text>
              <If when={c().detail}>
                <Text style={{ fontSize: 13, color: colors.muted }}>{c().detail}</Text>
              </If>
            </View>
            <View style={{ width: 20, alignItems: "center" }}>
              <If when={c().id === props.selected}>
                <View testID={`choice-check-${c().testID}`}><Icon name="check" size={16} tint={colors.info} /></View>
              </If>
            </View>
          </Radio>
        )}
      </Each>
    </RadioGroup>
  );
}
