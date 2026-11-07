import { type JSX, mount, signal, Text, View } from "nsh";
import { createClient } from "../../src/client";
import { connectEventSource, type SseConnection, type SseEvent } from "../../src/sse";

const PORTS = [8123];

function Row(props: { id: string; label: string; onPress?: () => void }) {
  return (
    <Text testID={props.id} role={props.onPress ? "button" : undefined} onPress={props.onPress}>
      {props.label}
    </Text>
  );
}

function LiveScreen() {
  // The headless runtime has no native filesystem and inherits no environment, so the
  // port cannot be read from tools/echo-server/.runtime.json; the screen probes the
  // documented pinned default live and a failed probe must be loud, never a silent
  // drop of live coverage.
  const port = signal<number | null | undefined>(undefined);
  const count = signal(0);
  const opens = signal(0);
  const last = signal("none");
  const firsts = signal("");
  const replayOpens = signal(0);
  const replayFirsts = signal("");
  let connection: SseConnection | null = null;
  let replayConnection: SseConnection | null = null;
  let firstOfConnection: string | null = null;
  let replayFirstOfConnection: string | null = null;
  void (async () => {
    for (const candidate of PORTS) {
      try {
        const response = await fetch(`http://127.0.0.1:${candidate}/health`);
        const body = (await response.json()) as { ok?: unknown };
        if (response.ok && body.ok === true) {
          port.set(candidate);
          return;
        }
      } catch {
        // Nothing answered there; try the next candidate.
      }
    }
    console.log(`SKIP (live): no echo server on 127.0.0.1:${PORTS[0]} (candidates: ${PORTS.join(", ")})`);
    port.set(null);
  })();
  const clientOf = () => createClient({ baseUrl: `http://127.0.0.1:${port() ?? 0}` });
  const note = (event: SseEvent): void => {
    count.update((n) => n + 1);
    last.set(`${event.id ?? "null"}|${event.event}|${event.data.split("\n").join("\\n")}`);
    if (firstOfConnection === null) {
      firstOfConnection = event.id;
      firsts.update((all) => (all === "" ? firstOfConnection! : `${all},${firstOfConnection}`));
    }
  };
  const sse = (): void => {
    connection = connectEventSource(clientOf(), "/sse?count=5&delay=5", note, {
      onOpen: () => {
        opens.update((n) => n + 1);
        firstOfConnection = null;
      },
    });
  };
  const sseClose = (): void => connection?.close();
  const replayNote = (event: SseEvent): void => {
    if (replayFirstOfConnection === null) {
      replayFirstOfConnection = event.id;
      replayFirsts.update((all) => (all === "" ? replayFirstOfConnection! : `${all},${replayFirstOfConnection}`));
    }
  };
  const replay = (): void => {
    // The server closes the stream after `count` events; every reconnect replays from
    // the id the client last saw. The first id after a reconnect therefore proves the
    // Last-Event-ID header: without it the server would restart from 1, not 3.
    replayConnection = connectEventSource(clientOf(), "/sse?count=3&delay=5", replayNote, {
      onOpen: () => {
        replayOpens.update((n) => n + 1);
        replayFirstOfConnection = null;
      },
    });
  };
  const replayClose = (): void => replayConnection?.close();
  return (
    <View class="gap-2">
      <Row id="lv-sse" label="live sse" onPress={sse} />
      <Row id="lv-sse-close" label="live sse close" onPress={sseClose} />
      <Row id="lv-sse-count" label={`lv-sse-count ${count()}`} />
      <Row id="lv-sse-opens" label={`lv-sse-opens ${opens()}`} />
      <Row id="lv-sse-last" label={`lv-sse-last ${last()}`} />
      <Row id="lv-sse-firsts" label={`lv-sse-firsts ${firsts()}`} />
      <Row id="lv-replay" label="live replay" onPress={replay} />
      <Row id="lv-replay-close" label="live replay close" onPress={replayClose} />
      <Row id="lv-replay-opens" label={`lv-replay-opens ${replayOpens()}`} />
      <Row id="lv-replay-firsts" label={`lv-replay-firsts ${replayFirsts()}`} />
      <Row id="live-port" label={`live-port ${port() === undefined ? "probing" : port() === null ? `none (candidates: ${PORTS.join(", ")})` : String(port())}`} />
    </View>
  );
}

const screens: Record<string, () => JSX.Element> = {
  Live: LiveScreen,
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
