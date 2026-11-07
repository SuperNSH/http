// Scaffold-owned test: pins the frozen NetworkEvent wire shape (`nsh-firebase` consumes
// it) and that the package's module graph resolves at run time. The core implementation's
// tests live in the other files of this directory.
import { expect, test } from "nsh/test";
import { Monitor, type NetworkEvent } from "../../src";

const EVENT_KEYS = [
  "id",
  "method",
  "url",
  "host",
  "path",
  "status",
  "startedAtMs",
  "durationMs",
  "ttfbMs",
  "requestBytes",
  "responseBytes",
  "error",
  "initiator",
];

test("the frozen NetworkEvent keeps its exact camelCase key set", async () => {
  const event: NetworkEvent = {
    id: "1",
    method: "GET",
    url: "http://127.0.0.1:8123/ping",
    host: "127.0.0.1",
    path: "/ping",
    status: 200,
    startedAtMs: 0,
    durationMs: 5,
    ttfbMs: null,
    requestBytes: null,
    responseBytes: 2,
    error: null,
    initiator: null,
  };
  expect(Object.keys(event)).toEqual(EVENT_KEYS);
  expect(Object.keys(JSON.parse(JSON.stringify(event)))).toEqual(EVENT_KEYS);
});

test("the package's exports resolve at run time", async () => {
  expect(new Monitor()).toBeDefined();
});
