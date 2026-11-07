import { type JSX, mount, signal, Text, View } from "nsh";
import { createClient } from "../../src/client";
import type { HttpError } from "../../src/errors";
import { byteStream, download, streamRequest } from "../../src/streaming";
import { uploadMultipart, type UploadPart } from "../../src/upload";

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
  const streamLines = signal("pending");
  const streamLast = signal("pending");
  const streamBytes = signal("pending");
  const bytesProgress = signal("pending");
  const multipart = signal("pending");
  const streamUpload = signal("pending");
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
  const stream = (): void => {
    download(clientOf(), "/stream?chunks=4&delay=5", {
      onProgress: (p) => streamBytes.set(`${p.receivedBytes} ${p.totalBytes === null ? "null" : p.totalBytes} ${p.chunks}${p.done ? " done" : ""}`),
    }).then(
      (result) => {
        const lines = result.text.split("\n").filter((line) => line !== "");
        const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { chunk?: number };
        streamLines.set(String(lines.length));
        streamLast.set(String(last.chunk ?? -1));
      },
      (e: HttpError) => {
        streamLines.set(`error ${e.kind}`);
      },
    );
  };
  const bytes = (): void => {
    // The progress callback is the only writer of this row, so the test really sees
    // what the download reported — not the result's own byte count.
    download(clientOf(), "/bytes/2048", {
      onProgress: (p) => bytesProgress.set(`${p.receivedBytes}/${p.totalBytes === null ? "null" : p.totalBytes}${p.done ? " done" : ""}`),
    }).then(
      () => undefined,
      (e: HttpError) => bytesProgress.set(`error ${e.kind}`),
    );
  };
  const multipartSend = (): void => {
    const parts: UploadPart[] = [
      { name: "note", value: "milk" },
      { name: "file", value: new Blob([new TextEncoder().encode("png-bytes")], { type: "image/png" }), filename: "cat.png" },
    ];
    uploadMultipart<{ parts: { name: string; value?: string; filename?: string; content?: string }[] }>(
      clientOf(),
      "/multipart",
      parts,
    ).then(
      (out) => {
        const note = out.parts.find((p) => p.name === "note")?.value ?? "missing";
        const file = out.parts.find((p) => p.name === "file");
        multipart.set(`${note}=${note === "milk" ? "ok" : "bad"} ${file?.filename ?? "missing"}:${file?.content ?? "missing"}`);
      },
      (e: HttpError) => multipart.set(`error ${e.kind}`),
    );
  };
  const streamSend = (): void => {
    streamRequest<{ body: unknown }>(clientOf(), "POST", "/echo", byteStream(["part1", "part2"]), {
      headers: { "content-type": "text/plain" },
    }).then(
      (out) => streamUpload.set(String(out.body)),
      (e: HttpError) => streamUpload.set(`error ${e.kind}`),
    );
  };
  return (
    <View class="gap-2">
      <Row id="lv-stream" label="live stream" onPress={stream} />
      <Row id="stream-lines" label={`stream-lines ${streamLines()}`} />
      <Row id="stream-last" label={`stream-last ${streamLast()}`} />
      <Row id="stream-progress" label={`stream-progress ${streamBytes()}`} />
      <Row id="lv-bytes" label="live bytes" onPress={bytes} />
      <Row id="bytes-progress" label={`bytes-progress ${bytesProgress()}`} />
      <Row id="lv-multi" label="live multipart" onPress={multipartSend} />
      <Row id="lv-multi-out" label={`lv-multi-out ${multipart()}`} />
      <Row id="lv-sup" label="live stream-upload" onPress={streamSend} />
      <Row id="lv-sup-out" label={`lv-sup-out ${streamUpload()}`} />
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
