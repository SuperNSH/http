import { type JSX, mount, signal, Text, View } from "nsh";
import { HttpClientPlaceholder } from "./src";

function Row(props: { id: string; label: string; onPress?: () => void }) {
  return (
    <Text testID={props.id} role={props.onPress ? "button" : undefined} onPress={props.onPress}>
      {props.label}
    </Text>
  );
}

function Client() {
  const state = signal("idle");
  const connect = () => {
    const client = new HttpClientPlaceholder();
    state.set(client ? "ready" : "idle");
  };
  return (
    <View class="gap-2">
      <Row id="connect" label="connect" onPress={connect} />
      <Row id="client-state" label={`client ${state()}`} />
    </View>
  );
}

const screens: Record<string, () => JSX.Element> = {
  Client,
};

function App() {
  const screen = signal<string | null>(null);
  return (
    <View class="flex-1 gap-2 p-4">
      <If when={screen()} else={<Each of={Object.keys(screens)}>{(name) => <Row id={`open-${name()}`} label={`open ${name()}`} onPress={() => screen.set(name())} />}</Each>}>
        {(name) => screens[name()]()}
      </If>
    </View>
  );
}

mount(App);
