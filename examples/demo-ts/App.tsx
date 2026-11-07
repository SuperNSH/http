import { type JSX, mount, signal, Text, View } from "nsh";
import { createClient, type HttpError, type NetworkEvent, type TokenProvider } from "nsh-http";
import { createQuery, queryClient } from "nsh-query";

// The test VM on 0.4.0 cannot read files or inherit environment, so the echo
// base URL is discovered by probing /health over the documented window — the
// pinned default 8123 plus the fallback ports the server takes when 8123 is
// already bound (the window is defined once in the repository README).
// 10.0.2.2 is the Android emulator's host loopback.
const WINDOW_START = 8123;
const WINDOW_END = 8132;
const PORTS = Array.from({ length: WINDOW_END - WINDOW_START + 1 }, (_, i) => WINDOW_START + i);
const CANDIDATES = [
  ...PORTS.map((port) => `http://127.0.0.1:${port}`),
  ...PORTS.map((port) => `http://10.0.2.2:${port}`),
];
// Per-candidate probe budget: candidates with nothing behind them reject at
// once (refused) or at this timeout, so the sweep stays bounded.
const PROBE_TIMEOUT = 500;

interface ScreenProps {
  url: () => string;
  home: () => void;
}

// One tappable action, styled once from tokens: the demo's button shape.
function Action(props: { id: string; label: string; onPress: () => void; secondary?: boolean }) {
  return (
    <View
      testID={props.id}
      role="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      class={
        props.secondary
          ? "rounded-(--radius) border border-border bg-background px-4 py-2.5 active:opacity-80"
          : "rounded-(--radius) bg-primary px-4 py-2.5 active:opacity-90"
      }
    >
      <Text class={props.secondary ? "text-sm font-medium text-foreground" : "text-sm font-medium text-primary-foreground"}>
        {props.label}
      </Text>
    </View>
  );
}

// One state readout: muted label over a foreground value, in a muted card.
function Card(props: { label: string; value: string; destructive?: boolean }) {
  return (
    <View class="gap-0.5 rounded-(--radius) bg-muted px-3 py-2">
      <Text class="text-xs text-muted-foreground">{props.label}</Text>
      <Text class={props.destructive ? "text-sm font-medium text-destructive" : "text-sm font-medium text-foreground"}>
        {props.value}
      </Text>
    </View>
  );
}

// One home entry: title and hint behind a tappable bordered card.
function ScreenLink(props: { id: string; title: string; hint: string; open: () => void }) {
  return (
    <View
      testID={props.id}
      role="button"
      accessibilityLabel={props.title}
      onPress={props.open}
      class="flex-row items-center justify-between rounded-(--radius) border border-border px-3 py-3 active:opacity-80"
    >
      <View class="gap-0.5">
        <Text class="text-sm font-medium text-foreground">{props.title}</Text>
        <Text class="text-xs text-muted-foreground">{props.hint}</Text>
      </View>
      <Text class="text-sm text-muted-foreground">›</Text>
    </View>
  );
}

function Back(props: { home: () => void }) {
  return (
    <View
      testID="home"
      role="button"
      accessibilityLabel="Back"
      onPress={props.home}
      class="rounded-(--radius) bg-muted px-3 py-1.5 active:opacity-80"
    >
      <Text class="text-xs font-medium text-foreground">Back</Text>
    </View>
  );
}

function lastOf<T>(all: T[]): T | undefined {
  return all[all.length - 1];
}

function EchoScreen(props: ScreenProps) {
  const events = signal<NetworkEvent[]>([]);
  const client = createClient({
    baseUrl: props.url(),
    observe: (event) => events.update((all) => [...all, event]),
  });
  const fast = signal("…");
  const slow = signal("…");
  const loadFast = () => {
    client.get<{ route: string }>("/fast").then(
      (value) => fast.set(value.route),
      (error: HttpError) => fast.set(`error ${error.kind}`),
    );
  };
  const loadSlow = () => {
    client.get<{ route: string; delay: number }>("/slow", { query: { delay: 1200 }, timeoutMs: null }).then(
      (value) => slow.set(`${value.route} ${value.delay}`),
      (error: HttpError) => slow.set(`error ${error.kind}`),
    );
  };
  const infoFor = (path: string, name: string) => {
    const mine = events().filter((event) => event.path.startsWith(path));
    const event = lastOf(mine);
    if (event === undefined) return "no call observed yet";
    const ttfb = event.ttfbMs === null ? "—" : `${event.ttfbMs} ms`;
    return `${name} · status ${event.status ?? "—"} · ${event.durationMs} ms · ttfb ${ttfb}`;
  };
  return (
    <View class="gap-3">
      <Back home={props.home} />
      <Text class="text-xl font-semibold text-foreground">Echo</Text>
      <Text class="text-sm text-muted-foreground">
        Two routes through the client; the observer stamps every attempt.
      </Text>
      <View class="flex-row gap-2">
        <Action id="load-fast" label="Load /fast" onPress={loadFast} />
        <Action id="load-slow" label="Load /slow" onPress={loadSlow} />
      </View>
      <View class="gap-2">
        <Card label="Fast route" value={fast()} />
        <Card label="Fast call, observed" value={infoFor("/fast", "fast")} />
        <Card label="Slow route (1200 ms)" value={slow()} />
        <Card label="Slow call, observed" value={infoFor("/slow", "slow")} />
      </View>
    </View>
  );
}

function QueryScreen(props: ScreenProps) {
  const client = createClient({ baseUrl: props.url() });
  const topic = signal(1);
  // The fetcher hands the query's AbortSignal to the client, so cancelling the
  // query kills the request on the wire. nsh-query keeps a released key's load
  // running by design (moving back to a key serves its cache), so replacing
  // the query cancels the old prefix on the way to the new key.
  const post = createQuery<{ route: string; delay: number }>({
    key: () => ["post", String(topic())],
    fetch: ({ signal }) =>
      client.get("/slow", { query: { delay: 3000, topic: topic() }, signal, timeoutMs: null }),
  });
  const proof = signal("not checked");
  const replace = () => {
    queryClient.cancel(["post"]);
    topic.update((n) => n + 1);
  };
  const prove = (lines: { event: string; id?: string; path?: string }[]): boolean => {
    const ended = new Set(lines.filter((line) => line.event === "end").map((line) => line.id));
    return lines.some(
      (line) => line.event === "aborted" && line.path === "/slow" && line.id !== undefined && !ended.has(line.id),
    );
  };
  // The server notices the disconnect a beat after the client aborts, so the
  // check retries a few times before it concedes.
  const checkLog = () => {
    const attempt = (left: number) => {
      client
        .get<{ lines: { event: string; id?: string; path?: string }[] }>("/log", { query: { tail: 50 } })
        .then(
          (body) => {
            if (prove(body.lines)) proof.set("yes · the aborted request is in the log");
            else if (left > 0) setTimeout(() => attempt(left - 1), 300);
            else proof.set("no · the log has no aborted request");
          },
          (error: HttpError) => proof.set(`error ${error.kind}`),
        );
    };
    attempt(3);
  };
  return (
    <View class="gap-3">
      <Back home={props.home} />
      <Text class="text-xl font-semibold text-foreground">Query</Text>
      <Text class="text-sm text-muted-foreground">
        An nsh-query load against /slow; replacing it cancels the request on the wire.
      </Text>
      <View class="flex-row gap-2">
        <Action id="replace-query" label="Replace query" onPress={replace} />
        <Action id="check-log" label="Check the log" onPress={checkLog} secondary />
      </View>
      <View class="gap-2">
        <Card label="Topic (the query key)" value={String(topic())} />
        <Card label="Load" value={post.status()} />
        <Card label="Route" value={post.data()?.route ?? "none"} />
        <Card label="Server log check" value={proof()} destructive={proof().startsWith("no")} />
      </View>
    </View>
  );
}

function AuthScreen(props: ScreenProps) {
  let current = "expired";
  const refreshes = signal(0);
  const done = signal(0);
  const failed = signal(0);
  // The refresh takes real time (the server round trip, or the stub's timer),
  // so the concurrent 401s genuinely overlap it and share one flight.
  const provider: TokenProvider = {
    token: () => current,
    refresh: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          refreshes.update((n) => n + 1);
          current = "refreshed";
          resolve(current);
        }, 100);
      }),
  };
  const client = createClient({ baseUrl: props.url(), tokenProvider: provider });
  const run = () => {
    for (let i = 0; i < 3; i += 1) {
      client.post<{ ok: boolean }>("/token").then(
        () => done.update((n) => n + 1),
        () => failed.update((n) => n + 1),
      );
    }
  };
  return (
    <View class="gap-3">
      <Back home={props.home} />
      <Text class="text-xl font-semibold text-foreground">Auth</Text>
      <Text class="text-sm text-muted-foreground">
        Three parallel requests on an expired token; the client refreshes once and replays.
      </Text>
      <Action id="run-refresh" label="Run the refresh demo" onPress={run} />
      <View class="flex-row gap-2">
        <View class="gap-0.5 rounded-(--radius) bg-muted px-3 py-2">
          <Text class="text-xs text-muted-foreground">Refreshes</Text>
          <Text testID="refresh-count" class="text-lg font-semibold text-foreground">
            {`${refreshes()} refresh`}
          </Text>
        </View>
        <View class="gap-0.5 rounded-(--radius) bg-muted px-3 py-2">
          <Text class="text-xs text-muted-foreground">Succeeded</Text>
          <Text testID="refresh-done" class="text-lg font-semibold text-foreground">
            {`${done()} succeeded`}
          </Text>
        </View>
        <View class="gap-0.5 rounded-(--radius) bg-muted px-3 py-2">
          <Text class="text-xs text-muted-foreground">Failed</Text>
          <Text
            testID="refresh-failed"
            class={failed() === 0 ? "text-lg font-semibold text-foreground" : "text-lg font-semibold text-destructive"}
          >
            {`${failed()} failed`}
          </Text>
        </View>
      </View>
    </View>
  );
}

const screens: Record<string, (props: ScreenProps) => JSX.Element> = {
  Echo: EchoScreen,
  Query: QueryScreen,
  Auth: AuthScreen,
};

const HINTS: Record<string, string> = {
  Echo: "fast and slow calls, with timings",
  Query: "nsh-query replacement, proven by the server log",
  Auth: "three 401s, one refresh",
};

function App() {
  const base = signal<string | null | undefined>(undefined);
  const screen = signal<string | null>(null);
  void (async () => {
    // Every candidate is probed at once, each with its own short timeout; the
    // first one that answers /health wins, so the sweep is bounded by one
    // probe budget however many candidates sit behind nothing.
    try {
      const winner = await Promise.any(
        CANDIDATES.map(async (candidate) => {
          const response = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
          const body = (await response.json()) as { ok?: unknown };
          if (!response.ok || body.ok !== true) throw new Error(`${candidate}: not the echo server`);
          return candidate;
        }),
      );
      base.set(winner);
    } catch {
      base.set(null);
    }
  })();
  const baseLabel = () =>
    base() === undefined
      ? "probing"
      : base() === null
        ? `none (ports ${WINDOW_START}..${WINDOW_END})`
        : base();
  return (
    <View class="flex-1 gap-3 bg-background px-4 pb-4 pt-[calc(env(safe-area-inset-top)+16px)]">
      <Text role="header" accessibilityLabel="nsh-http demo" class="text-xl font-semibold text-foreground">
        nsh-http demo
      </Text>
      <Text testID="base" class="text-sm text-muted-foreground">
        {`base ${baseLabel()}`}
      </Text>
      <If when={base()} else={<Text testID="base-wait" class="text-sm text-muted-foreground">waiting for the echo server</Text>}>
        {(url) => (
          <If
            when={screen()}
            else={
              <View class="gap-2">
                <Each of={Object.keys(screens)}>
                  {(name) => (
                    <ScreenLink id={`open-${name()}`} title={name()} hint={HINTS[name()]} open={() => screen.set(name())} />
                  )}
                </Each>
              </View>
            }
          >
            {(name) => screens[name()]({ url, home: () => screen.set(null) })}
          </If>
        )}
      </If>
    </View>
  );
}

mount(App);
