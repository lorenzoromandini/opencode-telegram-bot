import { OpenCode, type OpenCodeClient, type V2Event } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("opencode");

export interface OpenCodeConnection {
  client: OpenCodeClient;
  url: string;
}

/** Resolve the OpenCode server and build a typed client for it. */
export async function connectOpenCode(): Promise<OpenCodeConnection> {
  if (config.serverUrl) {
    log.info("uso server OpenCode esplicito:", config.serverUrl);
    const client = OpenCode.make({ baseUrl: config.serverUrl });
    return { client, url: config.serverUrl };
  }
  // Prefer an already-running service so we never start a duplicate one.
  const found = await Service.discover();
  if (found) {
    log.info("servizio OpenCode in background:", found.url);
    const client = OpenCode.make({
      baseUrl: found.url,
      headers: Service.headers(found),
    });
    return { client, url: found.url };
  }
  const endpoint = await Service.ensure();
  log.info("servizio OpenCode avviato:", endpoint.url);
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  return { client, url: endpoint.url };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Subscribe to the OpenCode event stream, reconnecting automatically.
 * The subscription is live-only, so a dropped connection is retried.
 */
export function startEventStream(
  client: OpenCodeClient,
  onEvent: (event: V2Event) => void,
  signal: AbortSignal,
  onStatus?: (connected: boolean) => void,
): void {
  void (async () => {
    while (!signal.aborted) {
      try {
        for await (const event of client.event.subscribe({ signal })) {
          onStatus?.(true);
          onEvent(event);
        }
      } catch (err: unknown) {
        if (signal.aborted) break;
        log.warn("stream eventi interrotto:", (err as Error).message);
        onStatus?.(false);
      }
      await sleep(1500, signal);
    }
  })();
}
