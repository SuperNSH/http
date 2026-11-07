import { type JSX, mount, signal, Text, View } from "nsh";
import { connectEventSource, type SseConnection, type SseEvent } from "../../src/sse";
import { createClient } from "../../src/client";
import type { HttpError } from "../../src/errors";
import type { HttpRequest } from "../../src/middleware";
import type { Transport } from "../../src/mock";
import type { RetryPolicy } from "../../src/retry";

function Row(props: { id: string; label: string; onPress?: () => void }) {
  return (
    <Text testID={props.id} role={props.onPress ? "button" : undefined} onPress={props.onPress}>
      {props.label}
    </Text>
  );
}

interface Script {
  /** Raw SSE text pieces, each sent one timer after the previous (0 ms: all at once). */
  pieces: string[];
  then: "close" | "error" | "hold";
}

/** A scripted event-stream source over the platform's Response/stream types. Honors
 * `request.signal` like the platform fetch does, so a cancel really breaks the stream. */
function scriptedSse(scripts: Script[]): Transport {
  let index = 0;
  return (request: HttpRequest): Promise<Response> => {
    const signal = request.signal;
    const script = scripts[Math.min(index, scripts.length - 1)];
    index += 1;
    const encoder = new TextEncoder();
    const controllerHolder: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerHolder.current = controller;
        let at = 0;
        const step = (): void => {
          if (at >= script.pieces.length) {
            if (script.then === "close") controller.close();
            else if (script.then === "error") controller.error(new TypeError("stream reset by peer"));
            return;
          }
          controller.enqueue(encoder.encode(script.pieces[at]));
          at += 1;
          setTimeout(step, 0);
        };
        step();
      },
    });
    signal?.addEventListener("abort", () => {
      controllerHolder.current?.error(signal.reason);
    }, { once: true });
    return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
  };
}

const POLICY: RetryPolicy = { maxRetries: 5, delayMs: 1000, jitter: 0, exponentialBackoff: true };

function SseScreen() {
  const opens = signal(0);
  const conns = signal(0);
  const events = signal(0);
  const errors = signal(0);
  const last = signal("none");
  const leid = signal("none");
  const firsts = signal("");
  const lasterr = signal("none");
  const retryms = signal("none");
  const handleId = signal("none");
  let connection: SseConnection | null = null;
  let firstOfConnection: string | null = null;
  let lastRequestHeaders: Record<string, string> = {};
  const cancellable = new AbortController();

  const record = (request: HttpRequest): void => {
    lastRequestHeaders = { ...request.headers };
    conns.update((n) => n + 1);
  };
  const clientOf = (scripts: Script[]) => {
    const transport = scriptedSse(scripts);
    return createClient({
      transport: (request) => {
        record(request);
        return transport(request);
      },
    });
  };

  const note = (event: SseEvent): void => {
    events.update((n) => n + 1);
    last.set(`${event.id === null ? "null" : event.id}|${event.event}|${event.data.split("\n").join("\\n")}`);
    if (firstOfConnection === null) {
      firstOfConnection = event.id === null ? "null" : event.id;
      firsts.update((all) => (all === "" ? firstOfConnection! : `${all},${firstOfConnection}`));
    }
    handleId.set(connection?.lastEventId() ?? "none");
  };
  const open = (): void => {
    opens.update((n) => n + 1);
    firstOfConnection = null;
    leid.set(lastRequestHeaders["last-event-id"] ?? "none");
  };
  const fail = (error: HttpError): void => {
    errors.update((n) => n + 1);
    lasterr.set(error.message);
  };

  const parse = (): void => {
    connection = connectEventSource(
      clientOf([{ pieces: ["id: 7\nevent: tick\ndata: a\n", "data: b\n\n", ": keepalive\nevent: note\ndata: x\ndata: y\n\n", "retry: 250\n"], then: "close" }]),
      "/events",
      note,
      { reconnect: POLICY, onRetry: (ms) => retryms.set(String(ms)) },
    );
  };

  const reconnect = (): void => {
    connection = connectEventSource(
      clientOf([
        { pieces: ["id: 1\nevent: tick\ndata: one\n\n", "id: 2\nevent: tick\ndata: two\n\n"], then: "error" },
        { pieces: ["id: 2\nevent: tick\ndata: again\n\n", "id: 3\nevent: tick\ndata: three\n\n"], then: "hold" },
      ]),
      "/events",
      note,
      { reconnect: POLICY, onOpen: open, onError: fail },
    );
  };

  const retry = (): void => {
    connection = connectEventSource(
      clientOf([
        { pieces: ["id: 1\ndata: a\n\n", "retry: 250\n"], then: "close" },
        { pieces: [], then: "hold" },
      ]),
      "/events",
      note,
      { reconnect: POLICY, onOpen: open, onRetry: (ms) => retryms.set(String(ms)) },
    );
  };

  const closeable = (): void => {
    connection = connectEventSource(
      clientOf([{ pieces: ["id: 1\ndata: a\n\n"], then: "close" }, { pieces: [], then: "hold" }]),
      "/events",
      note,
      { reconnect: POLICY, signal: cancellable.signal, onOpen: open },
    );
  };

  const giveup = (): void => {
    const refused: Transport = (request) => {
      record(request);
      return Promise.reject(new TypeError("connection refused"));
    };
    connection = connectEventSource(createClient({ transport: refused }), "/events", note, {
      reconnect: { maxRetries: 2, delayMs: 100, jitter: 0 },
      onOpen: open,
      onError: fail,
    });
  };

  const cancel = (): void => {
    connection = connectEventSource(clientOf([{ pieces: [], then: "hold" }]), "/events", note, {
      reconnect: POLICY,
      signal: cancellable.signal,
      onOpen: open,
    });
  };

  return (
    <View class="gap-2">
      <Row id="sse-parse" label="sse parse" onPress={parse} />
      <Row id="sse-reconnect" label="sse reconnect" onPress={reconnect} />
      <Row id="sse-retry" label="sse retry" onPress={retry} />
      <Row id="sse-close" label="sse close" onPress={closeable} />
      <Row id="sse-do-close" label="do close" onPress={() => connection?.close()} />
      <Row id="sse-giveup" label="sse giveup" onPress={giveup} />
      <Row id="sse-cancel" label="sse cancel" onPress={cancel} />
      <Row id="sse-do-cancel" label="do cancel" onPress={() => cancellable.abort()} />
      <Row id="sse-opens" label={`sse-opens ${opens()}`} />
      <Row id="sse-conns" label={`sse-conns ${conns()}`} />
      <Row id="sse-events" label={`sse-events ${events()}`} />
      <Row id="sse-errors" label={`sse-errors ${errors()}`} />
      <Row id="sse-last" label={`sse-last ${last()}`} />
      <Row id="sse-leid" label={`sse-leid ${leid()}`} />
      <Row id="sse-firsts" label={`sse-firsts ${firsts()}`} />
      <Row id="sse-lasterr" label={`sse-lasterr ${lasterr()}`} />
      <Row id="sse-retryms" label={`sse-retryms ${retryms()}`} />
      <Row id="sse-handle" label={`sse-handle ${handleId()}`} />
    </View>
  );
}

const screens: Record<string, () => JSX.Element> = {
  Sse: SseScreen,
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
