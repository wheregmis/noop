/**
 * The head of a page (a task, a memory file): its title block, set apart from the body by a hairline that runs the
 * page's full width, like the bar above it, even though the head itself sits in the reading column.
 */
import type { JSX, ViewStyle } from "nsh";
import { View } from "nsh";
import { colors } from "./theme";

/**
 * The `contentStyle` of a page's `Scroll` that holds a `PageHeader`: its content clips the hairline at the page's
 * edges. Without it the hairline, thousands of points wide, widens the scroll view's content, and on iOS a vertical
 * scroll view pans sideways over content wider than itself: a swipe then shifts the whole page left, cutting off the
 * start of every line and taking avatars and names off the screen.
 */
export const pageContent: ViewStyle = { overflow: "hidden" };

export function PageHeader(props: { testID?: string; style?: ViewStyle; children?: JSX.Element }) {
  return (
    <View testID={props.testID} style={[{ position: "relative", gap: 8, paddingBottom: 20, marginBottom: 20 }, props.style ?? null]}>
      {props.children}
      {/* the page's content clips it at its edges (`pageContent`) */}
      <View style={{ position: "absolute", bottom: 0, left: -4000, right: -4000, height: 0.5, backgroundColor: colors.line }} />
    </View>
  );
}
