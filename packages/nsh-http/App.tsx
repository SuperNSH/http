import { type JSX, mount, signal, Text, View } from "nsh";
import {
  cacheControl,
  createClient,
  createEtagFetcher,
  type HttpError,
  mockTransport,
  type Middleware,
  type NetworkEvent,
  type RetryPolicy,
  type TokenProvider,
} from "./src";

const BASE = "http://127.0.0.1:8123";

function Row(props: { id: string; label: string; onPress?: () => void }) {
  return (
    <Text testID={props.id} role={props.onPress ? "button" : undefined} onPress={props.onPress}>
      {props.label}
    </Text>
  );
}

function ClientScreen() {
  const client = createClient({ baseUrl: BASE, headers: { "x-client": "nsh-http" } });
  const user = signal("none");
  const echo = signal("none");
  const saved = signal("none");
  const patched = signal("none");
  const gone = signal("none");
  const shownUrl = client.url("/users/{id}", { path: { id: 7 }, query: { full: "true", drop: null, tag: ["a", "b"] } });
  const load = () => {
    client.get<{ name: string }>("/users/{id}", { path: { id: 7 }, query: { full: "true" } })
      .then((u) => user.set(u.name))
      .catch((e: HttpError) => user.set(`error ${e.kind}`));
  };
  const send = () => {
    client.post<{ got: number }>("/echo", { json: { n: 9 } })
      .then((v) => echo.set(String(v.got)))
      .catch((e: HttpError) => echo.set(`error ${e.kind}`));
  };
  const save = () => {
    client.put<{ updated: boolean }>("/users/7", { json: { n: 1 } })
      .then((v) => saved.set(v.updated ? "yes" : "no"))
      .catch((e: HttpError) => saved.set(`error ${e.kind}`));
  };
  const patch = () => {
    client.patch<{ patched: boolean }>("/users/7", { json: { n: 2 } })
      .then((v) => patched.set(v.patched ? "yes" : "no"))
      .catch((e: HttpError) => patched.set(`error ${e.kind}`));
  };
  const remove = () => {
    client.delete("/users/7")
      .then(() => gone.set("yes"))
      .catch((e: HttpError) => gone.set(`error ${e.kind}`));
  };
  return (
    <View class="gap-2">
      <Row id="url" label={`url ${shownUrl}`} />
      <Row id="load-user" label="load user" onPress={load} />
      <Row id="user" label={`user ${user()}`} />
      <Row id="echo" label="echo" onPress={send} />
      <Row id="echoed" label={`echoed ${echo()}`} />
      <Row id="save" label="save" onPress={save} />
      <Row id="saved" label={`saved ${saved()}`} />
      <Row id="patch" label="patch" onPress={patch} />
      <Row id="patched" label={`patched ${patched()}`} />
      <Row id="remove" label="remove" onPress={remove} />
      <Row id="gone" label={`gone ${gone()}`} />
    </View>
  );
}

function ErrorsScreen() {
  const client = createClient({ baseUrl: BASE });
  const network = signal("none");
  const status = signal("none");
  const decode = signal("none");
  const refused = signal("none");
  const offline = () => {
    client.get("/offline").catch((e: HttpError) => network.set(e.kind));
  };
  const missing = () => {
    client.get<{ message: string }>("/missing").catch((e: HttpError) => {
      const body = e.body as { message?: string } | null;
      status.set(`${e.kind} ${e.status} ${body?.message ?? "none"}`);
    });
  };
  const badJson = () => {
    client.get<{ v: number }>("/badjson").catch((e: HttpError) => decode.set(e.kind));
  };
  const refusedLoad = () => {
    client.get("https://example.com/refused").catch((e: HttpError) => refused.set(e.kind));
  };
  return (
    <View class="gap-2">
      <Row id="offline" label="offline" onPress={offline} />
      <Row id="network" label={`network ${network()}`} />
      <Row id="missing" label="missing" onPress={missing} />
      <Row id="status" label={`status ${status()}`} />
      <Row id="badjson" label="badjson" onPress={badJson} />
      <Row id="decode" label={`decode ${decode()}`} />
      <Row id="refuse" label="refuse" onPress={refusedLoad} />
      <Row id="refused" label={`refused ${refused()}`} />
    </View>
  );
}

function TimeoutScreen() {
  const client = createClient({ baseUrl: BASE, timeoutMs: 500 });
  const perCall = signal("pending");
  const perClient = signal("pending");
  const cancelled = signal("pending");
  const controller = new AbortController();
  const call = () => {
    client.get("/slow", { timeoutMs: 200 }).then(() => perCall.set("ok"), (e: HttpError) => perCall.set(e.kind));
  };
  const byClient = () => {
    client.get("/slow").then(() => perClient.set("ok"), (e: HttpError) => perClient.set(e.kind));
  };
  const start = () => {
    client.get("/slow", { signal: controller.signal, timeoutMs: null })
      .then(() => cancelled.set("ok"), (e: HttpError) => cancelled.set(e.kind));
  };
  const abort = () => controller.abort();
  return (
    <View class="gap-2">
      <Row id="start-call" label="start call" onPress={call} />
      <Row id="per-call" label={`per-call ${perCall()}`} />
      <Row id="start-client" label="start client" onPress={byClient} />
      <Row id="per-client" label={`per-client ${perClient()}`} />
      <Row id="start-cancel" label="start cancel" onPress={start} />
      <Row id="do-cancel" label="do cancel" onPress={abort} />
      <Row id="cancelled" label={`cancelled ${cancelled()}`} />
    </View>
  );
}

function RetryScreen() {
  const client = createClient({ baseUrl: BASE, retry: { maxRetries: 2, delayMs: 1000, jitter: 0 } });
  const jitterClient = createClient({
    baseUrl: BASE,
    retry: { maxRetries: 1, delayMs: 1000, jitter: 0.5, random: () => 1 },
  });
  const flaky = signal("pending");
  const post = signal("pending");
  const after = signal("pending");
  const afterDate = signal("pending");
  const stream = signal("pending");
  const jitter = signal("pending");
  const load = () => {
    client.get<{ ok: boolean }>("/flaky").then((v) => flaky.set(`ok ${v.ok}`), (e: HttpError) => flaky.set(e.kind));
  };
  const postOnce = () => {
    client.post("/flaky", { json: { n: 1 } }).then(() => post.set("ok"), (e: HttpError) => post.set(`${e.kind} ${e.status}`));
  };
  const afterLoad = () => {
    client.get("/retry-after").then(() => after.set("ok"), (e: HttpError) => after.set(e.kind));
  };
  const afterDateLoad = () => {
    client.get("/retry-after-date").then(() => afterDate.set("ok"), (e: HttpError) => afterDate.set(e.kind));
  };
  const streamLoad = () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    client.put("/flaky", { body }).then(() => stream.set("ok"), (e: HttpError) => stream.set(`${e.kind} ${e.status}`));
  };
  const jitterLoad = () => {
    jitterClient.get("/jitter").then(() => jitter.set("ok"), (e: HttpError) => jitter.set(`${e.kind} ${e.status}`));
  };
  return (
    <View class="gap-2">
      <Row id="load-flaky" label="load flaky" onPress={load} />
      <Row id="flaky" label={`flaky ${flaky()}`} />
      <Row id="load-post" label="load post" onPress={postOnce} />
      <Row id="post" label={`post ${post()}`} />
      <Row id="load-after" label="load after" onPress={afterLoad} />
      <Row id="after" label={`after ${after()}`} />
      <Row id="load-after-date" label="load after date" onPress={afterDateLoad} />
      <Row id="after-date" label={`after-date ${afterDate()}`} />
      <Row id="load-stream" label="load stream" onPress={streamLoad} />
      <Row id="stream" label={`stream ${stream()}`} />
      <Row id="load-jitter" label="load jitter" onPress={jitterLoad} />
      <Row id="jitter" label={`jitter ${jitter()}`} />
    </View>
  );
}

function MiddlewareScreen() {
  const requestOrder = signal("none");
  const responseOrder = signal("");
  const rerouted = signal("pending");
  // Requests flow first to last (track wraps rewrite); responses flow back last to first.
  const track: Middleware = async (request, next) => {
    request.headers["x-order"] = `${request.headers["x-order"] ?? ""}1`;
    const response = await next(request);
    const seen = response.headers.get("x-seen");
    if (seen !== null) requestOrder.set(seen);
    responseOrder.update((value) => `${value}1`);
    return response;
  };
  const rewrite: Middleware = async (request, next) => {
    request.url = request.url.replace("/wrong", "/right");
    request.headers["x-order"] = `${request.headers["x-order"] ?? ""}2`;
    const response = await next(request);
    responseOrder.update((value) => `${value}2`);
    return response;
  };
  const client = createClient({ baseUrl: BASE, middleware: [track, rewrite] });
  const load = () => {
    client.get<{ ok: boolean }>("/wrong").then((v) => rerouted.set(`ok ${v.ok}`), (e: HttpError) => rerouted.set(e.kind));
  };
  return (
    <View class="gap-2">
      <Row id="middle" label="middle" onPress={load} />
      <Row id="order" label={`order ${requestOrder()}`} />
      <Row id="response-order" label={`response-order ${responseOrder()}`} />
      <Row id="rerouted" label={`rerouted ${rerouted()}`} />
    </View>
  );
}

function AuthScreen() {
  let current = "old";
  const refreshes = signal(0);
  const done = signal(0);
  const errors = signal(0);
  const provider: TokenProvider = {
    token: () => current,
    // A refresh takes real time (here, manual-clock time), so the concurrent 401s
    // genuinely overlap it and can share its flight.
    refresh: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          refreshes.update((n) => n + 1);
          current = "new";
          resolve("new");
        }, 100);
      }),
  };
  const client = createClient({ baseUrl: BASE, tokenProvider: provider });
  const parallel = () => {
    for (let i = 0; i < 10; i += 1) {
      client.get("/private").then(() => done.update((n) => n + 1), () => errors.update((n) => n + 1));
    }
  };
  const fresh = () => {
    client.get("/open").then(() => done.update((n) => n + 1), () => errors.update((n) => n + 1));
  };
  return (
    <View class="gap-2">
      <Row id="parallel" label="parallel" onPress={parallel} />
      <Row id="open-load" label="open load" onPress={fresh} />
      <Row id="refreshes" label={`refreshes ${refreshes()}`} />
      <Row id="done" label={`done ${done()}`} />
      <Row id="errors" label={`errors ${errors()}`} />
    </View>
  );
}

function MockScreen() {
  const client = createClient({
    transport: mockTransport({
      "GET /mock": { body: { mock: true } },
      "GET /late": { body: { late: true }, delay: 1000 },
      "GET /boom": { status: 500, body: { boom: true } },
      "GET /broken": { error: "socket dropped" },
      "GET /wild*": { body: { wild: true } },
    }),
  });
  const stubbed = createClient({ baseUrl: BASE });
  const mock = signal("pending");
  const boom = signal("pending");
  const broken = signal("pending");
  const wild = signal("pending");
  const late = signal("pending");
  const stub = signal("pending");
  const ghost = signal("pending");
  const load = () => {
    client.get<{ mock: boolean }>("/mock").then((v) => mock.set(String(v.mock)), (e: HttpError) => mock.set(e.kind));
  };
  const boomLoad = () => {
    client.get("/boom").catch((e: HttpError) => boom.set(`${e.kind} ${e.status}`));
  };
  const brokenLoad = () => {
    client.get("/broken").catch((e: HttpError) => broken.set(e.kind));
  };
  const wildLoad = () => {
    client.get<{ wild: boolean }>("/wildcard-deep").then((v) => wild.set(String(v.wild)), (e: HttpError) => wild.set(e.kind));
  };
  const lateLoad = () => {
    client.get<{ late: boolean }>("/late").then((v) => late.set(String(v.late)), (e: HttpError) => late.set(e.kind));
  };
  const stubLoad = () => {
    stubbed.get<{ name: string }>("/users/1").then((v) => stub.set(v.name), (e: HttpError) => stub.set(e.kind));
  };
  const ghostLoad = () => {
    client.get("/ghost").catch((e: HttpError) => ghost.set(e.kind));
  };
  return (
    <View class="gap-2">
      <Row id="load-mock" label="load mock" onPress={load} />
      <Row id="mock" label={`mock ${mock()}`} />
      <Row id="load-boom" label="load boom" onPress={boomLoad} />
      <Row id="boom" label={`boom ${boom()}`} />
      <Row id="load-broken" label="load broken" onPress={brokenLoad} />
      <Row id="broken" label={`broken ${broken()}`} />
      <Row id="load-wild" label="load wild" onPress={wildLoad} />
      <Row id="wild" label={`wild ${wild()}`} />
      <Row id="load-late" label="load late" onPress={lateLoad} />
      <Row id="late" label={`late ${late()}`} />
      <Row id="load-stub" label="load stub" onPress={stubLoad} />
      <Row id="stub" label={`stub ${stub()}`} />
      <Row id="load-ghost" label="load ghost" onPress={ghostLoad} />
      <Row id="ghost" label={`ghost ${ghost()}`} />
    </View>
  );
}

function EtagScreen() {
  const client = createClient({ baseUrl: BASE });
  const fetcher = createEtagFetcher<{ v: number }>({ client, path: (key) => `/items/${key}` });
  const value = signal("none");
  const cached = cacheControl({ "cache-control": "max-age=60, no-store" });
  const load = () => {
    fetcher({ key: "todo" }).then((v) => value.set(String(v.v)), (e: HttpError) => value.set(`error ${e.kind}`));
  };
  return (
    <View class="gap-2">
      <Row id="load-etag" label="load etag" onPress={load} />
      <Row id="reload-etag" label="reload etag" onPress={load} />
      <Row id="etag" label={`etag ${value()}`} />
      <Row id="cc" label={`cc ${cached.maxAgeMs} ${cached.noStore}`} />
    </View>
  );
}

function ObserveScreen() {
  const events = signal(0);
  const last = signal<NetworkEvent | null>(null);
  const record = (event: NetworkEvent) => {
    events.update((n) => n + 1);
    last.set(event);
  };
  const client = createClient({ baseUrl: BASE, observe: record });
  const retrying = createClient({ baseUrl: BASE, observe: record, retry: { maxRetries: 1, delayMs: 100, jitter: 0 } });
  const ping = () => client.get("/ping").catch(() => undefined);
  const gone = () => client.get("/gone").catch(() => undefined);
  const offline = () => client.get("/offline").catch(() => undefined);
  const flaky = () => retrying.get("/oflaky").catch(() => undefined);
  return (
    <View class="gap-2">
      <Row id="observe-ping" label="observe ping" onPress={ping} />
      <Row id="observe-gone" label="observe gone" onPress={gone} />
      <Row id="observe-offline" label="observe offline" onPress={offline} />
      <Row id="observe-flaky" label="observe flaky" onPress={flaky} />
      <Row id="events" label={`events ${events()}`} />
      <Row id="last-status" label={`last-status ${last() === null ? "none" : last()!.status === null ? "null" : last()!.status}`} />
      <Row id="last-error" label={`last-error ${last()?.error ?? "none"}`} />
      <Row id="last-ttfb" label={`last-ttfb ${last() === null ? "none" : last()!.ttfbMs === null ? "null" : "set"}`} />
      <Row id="last-host" label={`last-host ${last()?.host ?? "none"}`} />
      <Row id="last-path" label={`last-path ${last()?.path ?? "none"}`} />
    </View>
  );
}

function LiveScreen() {
  // The headless runtime has no native filesystem, so tools/echo-server/.runtime.json
  // cannot be read; the screen discovers the port live against the documented pinned
  // default, and a failed probe must be loud, never a silent drop of live coverage.
  const PORTS = [8123];
  const port = signal<number | null | undefined>(undefined);
  const ok = signal("pending");
  const direct = signal("pending");
  const hop = signal("pending");
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
  const fast = () => {
    clientOf().get<{ route: string }>("/fast").then((v) => ok.set(v.route), (e: HttpError) => ok.set(e.kind));
  };
  const refuseDirect = () => {
    clientOf().get("http://refused.invalid/live").then(() => direct.set("allowed"), (e: HttpError) => direct.set(e.kind));
  };
  const refuseHop = () => {
    clientOf().get("/redirect/refused").then(() => hop.set("followed"), (e: HttpError) => hop.set(e.kind));
  };
  return (
    <View class="gap-2">
      <Row id="live-port" label={`live-port ${port() === undefined ? "probing" : port() === null ? `none (candidates: ${PORTS.join(", ")})` : String(port())}`} />
      <Row id="live-fast" label="live fast" onPress={fast} />
      <Row id="live-ok" label={`live-ok ${ok()}`} />
      <Row id="refuse-direct" label="refuse direct" onPress={refuseDirect} />
      <Row id="live-direct" label={`live-direct ${direct()}`} />
      <Row id="refuse-hop" label="refuse hop" onPress={refuseHop} />
      <Row id="live-hop" label={`live-hop ${hop()}`} />
    </View>
  );
}

const screens: Record<string, () => JSX.Element> = {
  Client: ClientScreen,
  Errors: ErrorsScreen,
  Timeout: TimeoutScreen,
  Retry: RetryScreen,
  Middleware: MiddlewareScreen,
  Auth: AuthScreen,
  Mock: MockScreen,
  Etag: EtagScreen,
  Observe: ObserveScreen,
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
