import { type JSX, mount, signal, Text, View } from "nsh";
import { createClient } from "../../src/client";
import type { HttpError } from "../../src/errors";
import { encodeMultipart, uploadBytes, uploadMultipart, type MultipartEncoding, type UploadPart } from "../../src/upload";

const BASE = "http://127.0.0.1:8123";

function Row(props: { id: string; label: string; onPress?: () => void }) {
  return (
    <Text testID={props.id} role={props.onPress ? "button" : undefined} onPress={props.onPress}>
      {props.label}
    </Text>
  );
}

const PARTS: UploadPart[] = [
  { name: "note", value: "milk" },
  { name: "file", value: new Blob([new TextEncoder().encode("png-bytes")], { type: "image/png" }), filename: "cat.png" },
];

/** The encoded body with control characters shown, so a text row can carry it. */
function escapeBytes(bytes: Uint8Array): string {
  return new TextDecoder()
    .decode(bytes)
    .split("\r")
    .join("\\r")
    .split("\n")
    .join("\\n");
}

function UploadScreen() {
  const stubbed = createClient({ baseUrl: BASE });
  const status = signal("pending");
  const encoded = signal("-");
  const sent = signal("-");
  const ctype = signal("pending");
  const length = signal("pending");
  const body = signal("pending");
  const collideOut = signal("pending");
  const boundaryOut = signal("pending");
  const rerollOut = signal("pending");
  const noteProgress = (progress: { phase: "encoded" | "sent"; sentBytes: number | null; totalBytes: number | null }): void => {
    const shown = `${progress.sentBytes === null ? "null" : progress.sentBytes} ${progress.totalBytes === null ? "null" : progress.totalBytes}`;
    if (progress.phase === "encoded") encoded.set(shown);
    else sent.set(shown);
  };
  const fail = (e: HttpError): void => status.set(`${e.kind} ${e.status ?? ""}`);
  const formSend = (): void => {
    uploadMultipart(stubbed, "/multipart", PARTS, { onProgress: noteProgress }).then(
      () => status.set("200 ok"),
      fail,
    );
  };
  const encode = (): void => {
    void encodeMultipart(PARTS, "XBOUNDARY").then((encoding: MultipartEncoding) => {
      ctype.set(encoding.contentType);
      length.set(String(encoding.bytes.byteLength));
      body.set(escapeBytes(encoding.bytes));
      status.set("encoded");
    });
  };
  const bytesSend = (): void => {
    void encodeMultipart(PARTS, "XBOUNDARY").then((encoding) =>
      uploadBytes(stubbed, "/upload", encoding, { onProgress: noteProgress }).then(() => status.set("200 ok"), fail),
    );
  };
  const errorSend = (): void => {
    void encodeMultipart(PARTS, "XBOUNDARY").then((encoding) =>
      uploadBytes(stubbed, "/upload-fail", encoding).then(() => status.set("200 ok"), fail),
    );
  };
  const collide = (): void => {
    const parts: UploadPart[] = [{ name: "note", value: "hello --XBOUNDARY world" }];
    void encodeMultipart(parts, "XBOUNDARY").then(
      (encoding) => collideOut.set(`ok ${encoding.bytes.byteLength}`),
      (cause: unknown) => collideOut.set(`collision ${(cause as Error).message.slice(0, 80)}`),
    );
  };
  const badBoundary = (): void => {
    void encodeMultipart(PARTS, "bad boundary!").then(
      (encoding) => boundaryOut.set(`ok ${encoding.bytes.byteLength}`),
      (cause: unknown) => boundaryOut.set((cause as Error).message.slice(0, 80)),
    );
  };
  const reroll = (): void => {
    // Pin the generated boundary so every candidate collides with the part, and the
    // candidate cap is reached deterministically.
    const real = crypto.randomUUID;
    crypto.randomUUID = () => "00000000-0000-4000-8000-000000000000";
    const parts: UploadPart[] = [{ name: "note", value: `x ----nsh-http-00000000000040008000000000000000 y` }];
    void encodeMultipart(parts).then(
      (encoding) => {
        crypto.randomUUID = real;
        rerollOut.set(`ok ${encoding.bytes.byteLength}`);
      },
      (cause: unknown) => {
        crypto.randomUUID = real;
        rerollOut.set((cause as Error).message.slice(0, 90));
      },
    );
  };
  return (
    <View class="gap-2">
      <Row id="up-form" label="up form" onPress={formSend} />
      <Row id="up-bytes" label="up bytes" onPress={bytesSend} />
      <Row id="up-error" label="up error" onPress={errorSend} />
      <Row id="up-encode" label="up encode" onPress={encode} />
      <Row id="up-collide" label="up collide" onPress={collide} />
      <Row id="up-collide-out" label={`up-collide-out ${collideOut()}`} />
      <Row id="up-badboundary" label="up badboundary" onPress={badBoundary} />
      <Row id="up-badboundary-out" label={`up-badboundary-out ${boundaryOut()}`} />
      <Row id="up-reroll" label="up reroll" onPress={reroll} />
      <Row id="up-reroll-out" label={`up-reroll-out ${rerollOut()}`} />
      <Row id="up-status" label={`up-status ${status()}`} />
      <Row id="up-encoded" label={`up-encoded ${encoded()}`} />
      <Row id="up-sent" label={`up-sent ${sent()}`} />
      <Row id="enc-ctype" label={`enc-ctype ${ctype()}`} />
      <Row id="enc-length" label={`enc-length ${length()}`} />
      <Row id="enc-body" label={`enc-body ${body()}`} />
    </View>
  );
}

const screens: Record<string, () => JSX.Element> = {
  Upload: UploadScreen,
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
