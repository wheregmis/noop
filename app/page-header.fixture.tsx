/**
 * The entry `page-header.test.tsx` opens: two phone pages with a `PageHeader` in a `Scroll`, one whose content clips
 * (`pageContent`, as the task page and a memory file's) and one whose content does not. Each shows the content width
 * its scroll view reported, which is what a vertical scroll view on iOS pans sideways over.
 */
import { Scroll, Text, View, mount, signal } from "nsh";
import { PageHeader, pageContent } from "./ui";

function Page(props: { name: string; clipped: boolean }) {
  const width = signal(0);
  return (
    <Scroll
      testID={`page-${props.name}`}
      style={{ flex: 1 }}
      contentStyle={props.clipped ? pageContent : undefined}
      onScroll={(ev) => width.set(Math.round(ev.contentSize.width))}
    >
      <View style={{ width: "100%", paddingHorizontal: 16, paddingTop: 24, height: 1600 }}>
        <PageHeader>
          <Text style={{ fontSize: 20, fontWeight: "600" }}>{`T-0001 ${props.name}`}</Text>
        </PageHeader>
        <Text>{`${props.name} content ${width()}`}</Text>
      </View>
    </Scroll>
  );
}

function Fixture() {
  return (
    <View style={{ flex: 1 }}>
      <Page name="clipped" clipped />
      <Page name="unclipped" clipped={false} />
    </View>
  );
}

mount(Fixture);
