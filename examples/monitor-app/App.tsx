import { mount, platform, signal, Storage, Text, View, Scroll } from "nsh";
import { createClient, type Aggregate, type HttpClient, type NetworkEvent, type Observer, instrumentedFetch, Monitor } from "nsh-http";
import { SearchInput } from "./ui/input";

// The echo server is pinned to 127.0.0.1:8123 on the host; the Android emulator
// reaches it as 10.0.2.2. Exactly one of the candidates answers.
const CANDIDATES = ["http://127.0.0.1:8123", "http://10.0.2.2:8123"];

function CallRow(props: { event: () => NetworkEvent }) {
  return (
    <View class="gap-0.5 border-b border-border py-2">
      <View class="flex-row items-center gap-2">
        <Text class="w-10 text-xs font-medium text-muted-foreground">{props.event().method}</Text>
        <Text class="min-h-5 flex-1 text-sm text-foreground">{props.event().path}</Text>
        <Text class="text-sm font-medium text-foreground">{props.event().durationMs} ms</Text>
      </View>
      <Text
        testID="call-detail"
        classList={{
          "pl-12 text-xs": true,
          "text-muted-foreground": props.event().error === null,
          "text-destructive": props.event().error !== null,
        }}
      >
        {props.event().error === null
          ? `HTTP ${props.event().status} · ttfb ${props.event().ttfbMs === null ? "—" : props.event().ttfbMs} ms`
          : props.event().error}
      </Text>
    </View>
  );
}

function App() {
  const monitor = new Monitor();
  const calls = signal<NetworkEvent[]>([]);
  const base = signal<string | null | undefined>(undefined);
  const filter = signal("");

  const ingest: Observer = (event) => {
    monitor.record(event);
    calls.set(monitor.events());
  };

  const fire = (client: HttpClient) => {
    client.get("/slow?delay=1200").catch(() => undefined);
    client.get("/fast").catch(() => undefined);
  };

  void (async () => {
    const probe = instrumentedFetch({ onEvent: ingest, initiator: "probe" });
    for (const candidate of CANDIDATES) {
      try {
        const response = await probe(`${candidate}/health`);
        const body = (await response.json()) as { ok?: unknown };
        if (response.ok && body.ok === true) {
          base.set(candidate);
          fire(createClient({ baseUrl: candidate, observe: ingest }));
          return;
        }
      } catch {
        // Nothing answered on this host; the next candidate, or the none state, follows.
      }
    }
    base.set(null);
  })();

  // Capture tests read this back to name their screenshots per target.
  Storage.setItem("platform", platform.os).catch(() => undefined);

  const visible = () => {
    const needle = filter().trim().toLowerCase();
    const sorted = [...calls()].sort((a, b) => b.durationMs - a.durationMs);
    if (needle === "") return sorted;
    return sorted.filter((event) => event.host.toLowerCase().includes(needle) || event.path.toLowerCase().includes(needle));
  };

  // Reads calls() so the binding recomputes whenever the monitor records.
  const aggregates = (): [string, Aggregate][] => (calls().length === 0 ? [] : Object.entries(monitor.byHost()));

  const baseLine = () => {
    if (base() === undefined) return "Looking for the echo server…";
    if (base() === null) return `No echo server answered on ${CANDIDATES.join(" or ")}`;
    return `Recording calls on ${base()}`;
  };

  return (
    <View class="flex-1 bg-background">
      <View class="gap-2 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+16px)]">
        <Text accessibilityLabel="Network monitor" class="text-xl font-semibold text-foreground" role="header">
          Network monitor
        </Text>
        <Text class="text-sm text-muted-foreground" testID="base">
          {baseLine()}
        </Text>
        <Each of={aggregates()}>
          {(entry) => (
            <View class="gap-0.5 rounded-(--radius) bg-muted px-3 py-2" testID="host-agg">
              <Text class="text-sm font-medium text-foreground">{entry()[0]}</Text>
              <Text class="text-xs text-muted-foreground">
                {`${entry()[1].count} ${entry()[1].count === 1 ? "call" : "calls"} · ${Math.round(entry()[1].errorRate * 100)}% errors · p50 ${entry()[1].p50Ms} ms · p95 ${entry()[1].p95Ms} ms`}
              </Text>
            </View>
          )}
        </Each>
        <SearchInput placeholder="Filter by host or path" testID="filter" value={filter()} onChange={(value) => filter.set(value)} />
      </View>
      {/* Each, not List: the ring buffer bounds this collection, and on 0.4.0 a List
          keeps rows in insertion order whenever an update reorders the array — a fresh
          sorted copy assigned in one shot, with or without keyExtractor, still renders
          the slow call (which lands last) at the bottom; Each reorders correctly. */}
      <Scroll class="flex-1" testID="call-list">
        <View class="px-4 pb-4">
          <If when={visible().length === 0}>
            <View class="items-center py-8">
              <Text class="text-sm text-muted-foreground">
                {calls().length === 0 ? "Waiting for the first calls…" : `No calls match "${filter().trim()}"`}
              </Text>
            </View>
          </If>
          <Each of={visible()}>
            {(event) => <CallRow event={event} />}
          </Each>
        </View>
      </Scroll>
    </View>
  );
}

mount(App);
