import { mount, signal, Text, View, windowSize } from "nsh";
import { Button } from "./ui";
import { ReaderSheet } from "./ui/reader-sheet";

function App() {
  const open = signal(false);
  const expanded = signal(false);
  const width = signal(420);
  const measured = signal(0);
  return <View style={{ flex: 1 }}>
    <Button label="Open report" onPress={() => open.set(true)} />
    <ReaderSheet open={open()} availableWidth={windowSize().width - 240} insetLeft={240}
      width={width()} expanded={expanded()} onResize={width.set} onClose={() => open.set(false)}>
      <View style={{ flex: 1 }} onLayout={(e) => measured.set(Math.round(e.bounds.size.width))}>
        <Text>{`Width: ${measured()}`}</Text>
        <Text>{`Saved: ${Math.round(width())}`}</Text>
        <Button label="Toggle maximize" onPress={() => expanded.set(!expanded())} />
        <Button label="Close report" onPress={() => open.set(false)} />
      </View>
    </ReaderSheet>
  </View>;
}
mount(App);
