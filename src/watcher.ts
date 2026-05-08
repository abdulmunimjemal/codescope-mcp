import { watch as chokidarWatch } from "chokidar";
import { languageForPath } from "./languages.js";
import type { Indexer } from "./indexer.js";

export interface WatchEvents {
  /** A file was (re-)indexed or removed from the graph. */
  onChange?: (relPath: string, action: "indexed" | "removed") => void;
  onError?: (error: unknown) => void;
  /** Fired once the initial scan has settled and the watcher is live. */
  onReady?: () => void;
}

export interface WatchOptions {
  /** Force polling — slower but deterministic, useful in tests/CI. */
  usePolling?: boolean;
  /** Polling interval in ms when `usePolling` is set. */
  interval?: number;
}

export interface WatchHandle {
  close: () => Promise<void>;
}

const IGNORED = /(?:^|[\\/])(?:node_modules|\.git|dist|build|coverage|\.codescope|target|__pycache__)(?:[\\/]|$)/;

/**
 * Watch the indexer's root and keep the graph fresh as files change. This is
 * codescope's differentiator: the agent never reads a stale graph because the
 * graph re-indexes the touched file (and only that file) on save.
 */
export function watch(indexer: Indexer, events: WatchEvents = {}, opts: WatchOptions = {}): WatchHandle {
  const watcher = chokidarWatch(indexer.root, {
    ignoreInitial: true,
    ignored: (path: string) => IGNORED.test(path),
    usePolling: opts.usePolling,
    interval: opts.interval,
  });

  const onUpsert = (abs: string): void => {
    if (!languageForPath(abs)) return;
    indexer
      .indexFile(abs)
      .then((outcome) => {
        if (outcome === "indexed") events.onChange?.(indexer.rel(abs), "indexed");
      })
      .catch((err) => events.onError?.(err));
  };

  watcher
    .on("add", onUpsert)
    .on("change", onUpsert)
    .on("unlink", (abs: string) => {
      if (indexer.removeFile(abs)) events.onChange?.(indexer.rel(abs), "removed");
    })
    .on("error", (err: unknown) => events.onError?.(err))
    .on("ready", () => events.onReady?.());

  return {
    close: () => watcher.close(),
  };
}
