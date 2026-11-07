// Multipart upload and upload progress with its honest limit (behavior row 13): the
// FormData path goes through the stub network and the route sees what the platform
// actually encoded; the exact-bytes path proves encodeMultipart byte for byte; progress
// carries real numbers only where we build the body, null where the runtime hides it.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const BASE = "http://127.0.0.1:8123";

type Network = NonNullable<NonNullable<Parameters<typeof open>[1]>["network"]>;

async function showUpload(network: Network): Promise<App> {
  const app = await open("./upload.app.tsx", { clock: {}, network });
  await app.press("id:open-Upload");
  return app;
}

test("multipart via FormData is encoded by the platform and seen by the route", async () => {
  let contentType = "";
  let bodyText: string | null = null;
  const app = await showUpload({
    [`POST ${BASE}/multipart`]: (request) => {
      contentType = request.headers["content-type"] ?? request.headers["Content-Type"] ?? "";
      bodyText = request.body ?? null;
      return { body: { ok: true } };
    },
  });
  await app.press("id:up-form");
  await app.waitFor("text:up-status 200 ok");
  expect(contentType.startsWith("multipart/form-data; boundary=")).toBeTruthy();
  expect(bodyText).not.toBeNull();
  expect(bodyText).toContain("Content-Disposition");
  expect(bodyText).toContain("milk");
  // The runtime exposes no size for a FormData body, so progress stays honest: null.
  expect(app.shows("text:up-encoded null null")).toBeTruthy();
  expect(app.shows("text:up-sent null null")).toBeTruthy();
});

test("encodeMultipart produces the exact multipart bytes and exact total", async () => {
  const app = await showUpload({});
  const expected =
    "--XBOUNDARY\r\n" +
    'Content-Disposition: form-data; name="note"\r\n' +
    "\r\n" +
    "milk\r\n" +
    "--XBOUNDARY\r\n" +
    'Content-Disposition: form-data; name="file"; filename="cat.png"\r\n' +
    "Content-Type: image/png\r\n" +
    "\r\n" +
    "png-bytes\r\n" +
    "--XBOUNDARY--\r\n";
  await app.press("id:up-encode");
  await app.waitFor("text:up-status encoded");
  expect(app.shows("text:enc-ctype multipart/form-data; boundary=XBOUNDARY")).toBeTruthy();
  expect(app.shows(`text:enc-body ${expected.split("\r").join("\\r").split("\n").join("\\n")}`)).toBeTruthy();
  expect(app.shows(`text:enc-length ${expected.length}`)).toBeTruthy();
});

test("an exact body reports encoded and sent progress with real byte counts", async () => {
  const app = await showUpload({ [`POST ${BASE}/upload`]: { body: { saved: true } } });
  await app.press("id:up-bytes");
  await app.waitFor("text:up-status 200 ok");
  const expected =
    "--XBOUNDARY\r\n" +
    'Content-Disposition: form-data; name="note"\r\n' +
    "\r\n" +
    "milk\r\n" +
    "--XBOUNDARY\r\n" +
    'Content-Disposition: form-data; name="file"; filename="cat.png"\r\n' +
    "Content-Type: image/png\r\n" +
    "\r\n" +
    "png-bytes\r\n" +
    "--XBOUNDARY--\r\n";
  expect(app.shows(`text:up-encoded ${expected.length} ${expected.length}`)).toBeTruthy();
  expect(app.shows(`text:up-sent ${expected.length} ${expected.length}`)).toBeTruthy();
});

test("an error status from an upload comes back as http-status with the status", async () => {
  const app = await showUpload({ [`POST ${BASE}/upload-fail`]: { status: 500, body: { error: "nope" } } });
  await app.press("id:up-error");
  await app.waitFor("text:up-status http-status 500");
});

test("a caller boundary that collides with a part's content fails loudly", async () => {
  const app = await showUpload({});
  await app.press("id:up-collide");
  await app.waitFor("text:/up-collide-out collision multipart boundary collides/");
});

test("a boundary outside the RFC 2046 set is rejected, not encoded silently", async () => {
  const app = await showUpload({});
  await app.press("id:up-badboundary");
  await app.waitFor("text:/up-badboundary-out invalid multipart boundary/");
  expect(app.shows("text:/outside the RFC 2046 set/")).toBeTruthy();
});

test("a generated boundary gives up after exactly 8 candidates, like the Rust loop", async () => {
  const app = await showUpload({});
  await app.press("id:up-reroll");
  await app.waitFor("text:/up-reroll-out the boundary occurs inside a part's content after 8 candidates/");
});
