import { appendFile } from "node:fs/promises";

export interface JsonLog {
  readonly path: string;
  /** Appends one JSON line; never rejects (a log failure must not fail requests). */
  write(record: Record<string, unknown>): Promise<void>;
  /** Resolves once every write queued so far reached the file. */
  flush(): Promise<void>;
}

// Writes are chained so a request's start/end/aborted lines keep their order on disk.
export function createJsonLog(path: string): JsonLog {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    path,
    write(record) {
      tail = tail
        .catch(() => {})
        .then(() => appendFile(path, JSON.stringify(record) + "\n"))
        .catch((err) => {
          console.error(`echo-server: log write to ${path} failed:`, err);
        });
      return tail;
    },
    flush() {
      return tail.then(() => {});
    },
  };
}
