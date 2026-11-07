import { type JSX, mount, signal, Text, View } from "nsh";
import { createClient } from "../../src/client";
import type { HttpError } from "../../src/errors";
import type { HttpRequest } from "../../src/middleware";
import type { Transport } from "../../src/mock";
import { byteStream, download, streamRequest } from "../../src/streaming";

const BASE = "http://127.0.0.1:8123";

function Row(props: { id: string; label: string; onPress?: () => void }) {
  return (
    <Text testID={props.id} role={props.onPress ? "button" : undefined} onPress={props.onPress}>
      {props.label}
    </Text>
  );
}

/** A Response whose body trickles in on timers, so the manual clock paces the chunks.
 * The stub network answers whole bodies (its response shape has no chunked form), and
 * this runs on the platform's own Response/stream types. Honors `request.signal` the
 * way the platform fetch does, so a caller cancel really breaks the stream. */
function pacedTransport(options: {
  pieces: (Uint8Array | string)[];
  gapMs: number;
  /** `error` breaks the stream after the pieces. */
  end?: "close" | "error";
  totalBytes?: number | null;
  /** Extra body chunks sent forever, so a cancel test has something mid-flight. */
  hold?: boolean;
}): Transport {
  return (request: HttpRequest): Promise<Response> => {
    const encoder = new TextEncoder();
    const signal = request.signal;
    const controllerHolder: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerHolder.current = controller;
        let index = 0;
        const step = (): void => {
          const loop = options.hold === true && index >= options.pieces.length;
          if (loop) {
            index = 0;
          }
          if (index >= options.pieces.length) {
            if (options.end === "error") controller.error(new TypeError("connection reset mid-body"));
            else controller.close();
            return;
          }
          const piece = options.pieces[index];
          controller.enqueue(typeof piece === "string" ? encoder.encode(piece) : piece);
          index += 1;
          setTimeout(step, options.gapMs);
        };
        step();
      },
    });
    signal?.addEventListener("abort", () => {
      controllerHolder.current?.error(signal.reason);
    }, { once: true });
    const headers: Record<string, string> = { "content-type": "application/octet-stream" };
    if (options.totalBytes !== undefined && options.totalBytes !== null) {
      headers["content-length"] = String(options.totalBytes);
    }
    return Promise.resolve(new Response(stream, { status: 200, headers }));
  };
}

function DownloadScreen() {
  const stubbed = createClient({ baseUrl: BASE });
  const status = signal("pending");
  const received = signal("0");
  const total = signal("-");
  const chunks = signal("0");
  const done = signal("no");
  const text = signal("");
  const noteProgress = (progress: { receivedBytes: number; totalBytes: number | null; chunks: number; done: boolean }): void => {
    received.set(String(progress.receivedBytes));
    total.set(progress.totalBytes === null ? "null" : String(progress.totalBytes));
    chunks.set(String(progress.chunks));
    if (progress.done) done.set("yes");
  };
  const show = (result: { status: number; ok: boolean; text: string }): void => {
    status.set(`${result.status} ${result.ok ? "ok" : "bad"}`);
    text.set(result.text);
  };
  const stubLoad = (): void => {
    download(stubbed, "/bytes/64", { onProgress: noteProgress }).then(show, (e: HttpError) => status.set(e.kind));
  };
  const paced = createClient({ transport: pacedTransport({ pieces: ["0123456789", "0123456789", "0123456789"], gapMs: 1000 }) });
  const pacedLoad = (): void => {
    download(paced, "/drip", { onProgress: noteProgress }).then(show, (e: HttpError) => status.set(e.kind));
  };
  const pacedTotal = createClient({
    transport: pacedTransport({ pieces: ["0123456789", "0123456789", "0123456789"], gapMs: 1000, totalBytes: 30 }),
  });
  const pacedTotalLoad = (): void => {
    download(pacedTotal, "/drip", { onProgress: noteProgress }).then(show, (e: HttpError) => status.set(e.kind));
  };
  const cancellable = new AbortController();
  const slow = createClient({
    transport: pacedTransport({ pieces: ["chunk-"], gapMs: 1000, hold: true }),
  });
  const slowLoad = (): void => {
    download(slow, "/endless", { signal: cancellable.signal, onProgress: noteProgress }).then(
      show,
      (e: HttpError) => status.set(e.kind),
    );
  };
  const empty = createClient({ baseUrl: BASE });
  const emptyLoad = (): void => {
    download(empty, "/empty", { onProgress: noteProgress }).then(show, (e: HttpError) => status.set(e.kind));
  };
  return (
    <View class="gap-2">
      <Row id="dl-stub" label="dl stub" onPress={stubLoad} />
      <Row id="dl-paced" label="dl paced" onPress={pacedLoad} />
      <Row id="dl-total" label="dl total" onPress={pacedTotalLoad} />
      <Row id="dl-cancel" label="dl cancel" onPress={slowLoad} />
      <Row id="do-cancel" label="do cancel" onPress={() => cancellable.abort()} />
      <Row id="dl-empty" label="dl empty" onPress={emptyLoad} />
      <Row id="dl-status" label={`dl-status ${status()}`} />
      <Row id="dl-received" label={`dl-received ${received()}`} />
      <Row id="dl-total" label={`dl-total ${total()}`} />
      <Row id="dl-chunks" label={`dl-chunks ${chunks()}`} />
      <Row id="dl-done" label={`dl-done ${done()}`} />
      <Row id="dl-text" label={`dl-text ${text()}`} />
    </View>
  );
}

function StreamScreen() {
  const echoed = signal("pending");
  const stubbed = signal("pending");
  // Reads the streamed body back, so the test sees exactly the chunks the request carried.
  const echo: Transport = async (request: HttpRequest): Promise<Response> => {
    const reader = request.body instanceof ReadableStream ? request.body.getReader() : null;
    const decoder = new TextDecoder();
    let text = "";
    if (reader !== null) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    }
    return new Response(JSON.stringify({ echoed: text }), { headers: { "content-type": "application/json" } });
  };
  const echoClient = createClient({ transport: echo });
  const stubClient = createClient({ baseUrl: BASE });
  const echoSend = (): void => {
    streamRequest<{ echoed: string }>(echoClient, "PUT", "/echo", ["part1", "part2"]).then(
      (v) => echoed.set(v.echoed),
      (e: HttpError) => echoed.set(`error ${e.kind}`),
    );
  };
  const stubSend = (): void => {
    streamRequest<{ bodySeen: string | null }>(stubClient, "PUT", "/streamed", byteStream(["a", "b"])).then(
      (v) => stubbed.set(`seen ${v.bodySeen ?? "null"}`),
      (e: HttpError) => stubbed.set(`error ${e.kind}`),
    );
  };
  return (
    <View class="gap-2">
      <Row id="stream-echo" label="stream echo" onPress={echoSend} />
      <Row id="stream-echoed" label={`stream-echoed ${echoed()}`} />
      <Row id="stream-stub" label="stream stub" onPress={stubSend} />
      <Row id="stream-through" label={`stream-through ${stubbed()}`} />
    </View>
  );
}

const screens: Record<string, () => JSX.Element> = {
  Download: DownloadScreen,
  Stream: StreamScreen,
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
