import { type JSX, mount, signal, Text, View } from "nsh";
import { createClient, type HttpError, type NetworkEvent, type TokenProvider } from "nsh-http";
import { createQuery, queryClient } from "nsh-query";

// The test VM on 0.4.0 cannot read files or inherit environment, so the echo
// base URL is discovered by probing /health over the documented candidates
// (tools/echo-server pins 8123; 10.0.2.2 is the Android emulator's host).
const CANDIDATES = ["http://127.0.0.1:8123", "http://10.0.2.2:8123"];

interface ScreenProps {
  url: () => string;
  home: () => void;
}

function Row(props: { id: string; label: string; onPress?: () => void }) {
  return (
    <Text
      testID={props.id}
      role={props.onPress ? "button" : undefined}
      onPress={props.onPress}
      class="text-foreground"
    >
      {props.label}
    </Text>
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
  const fast = signal("pending");
  const slow = signal("pending");
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
  const infoFor = (path: string) => {
    const mine = events().filter((event) => event.path.startsWith(path));
    const event = lastOf(mine);
    if (event === undefined) return "no calls yet";
    const ttfb = event.ttfbMs === null ? "null" : `${event.ttfbMs}ms`;
    return `status ${event.status ?? "null"} ${event.durationMs}ms ttfb ${ttfb}`;
  };
  return (
    <View class="gap-2">
      <Row id="home" label="back" onPress={props.home} />
      <Row id="load-fast" label="load fast" onPress={loadFast} />
      <Row id="fast-ok" label={`fast ${fast()}`} />
      <Row id="fast-info" label={`fast-info ${infoFor("/fast")}`} />
      <Row id="load-slow" label="load slow" onPress={loadSlow} />
      <Row id="slow-ok" label={`slow ${slow()}`} />
      <Row id="slow-info" label={`slow-info ${infoFor("/slow")}`} />
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
            if (prove(body.lines)) proof.set("yes");
            else if (left > 0) setTimeout(() => attempt(left - 1), 300);
            else proof.set("no");
          },
          (error: HttpError) => proof.set(`error ${error.kind}`),
        );
    };
    attempt(3);
  };
  return (
    <View class="gap-2">
      <Row id="home" label="back" onPress={props.home} />
      <Row id="query-topic" label={`query-topic ${topic()}`} />
      <Row id="query-status" label={`query-status ${post.status()}`} />
      <Row id="query-data" label={`query-data ${post.data()?.route ?? "none"}`} />
      <Row id="replace-query" label="replace query" onPress={replace} />
      <Row id="check-log" label="check log" onPress={checkLog} />
      <Row id="log-abort" label={`log-abort ${proof()}`} />
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
    <View class="gap-2">
      <Row id="home" label="back" onPress={props.home} />
      <Row id="run-refresh" label="run refresh demo" onPress={run} />
      <Row id="refresh-count" label={`refreshes ${refreshes()}`} />
      <Row id="refresh-done" label={`done ${done()}`} />
      <Row id="refresh-failed" label={`failed ${failed()}`} />
    </View>
  );
}

const screens: Record<string, (props: ScreenProps) => JSX.Element> = {
  Echo: EchoScreen,
  Query: QueryScreen,
  Auth: AuthScreen,
};

function App() {
  const base = signal<string | null | undefined>(undefined);
  const screen = signal<string | null>(null);
  void (async () => {
    for (const candidate of CANDIDATES) {
      try {
        const response = await fetch(`${candidate}/health`);
        const body = (await response.json()) as { ok?: unknown };
        if (response.ok && body.ok === true) {
          base.set(candidate);
          return;
        }
      } catch {
        // Nothing answered there; try the next candidate.
      }
    }
    base.set(null);
  })();
  const baseLabel = () =>
    base() === undefined
      ? "probing"
      : base() === null
        ? `none (candidates: ${CANDIDATES.join(", ")})`
        : base();
  return (
    <View class="flex-1 gap-2 bg-background p-4">
      <Row id="base" label={`base ${baseLabel()}`} />
      <If when={base()} else={<Text testID="base-wait">waiting for the echo server</Text>}>
        {(url) => (
          <If
            when={screen()}
            else={<Each of={Object.keys(screens)}>{(name) => <Row id={`open-${name()}`} label={`open ${name()}`} onPress={() => screen.set(name())} />}</Each>}
          >
            {(name) => screens[name()]({ url, home: () => screen.set(null) })}
          </If>
        )}
      </If>
    </View>
  );
}

mount(App);
