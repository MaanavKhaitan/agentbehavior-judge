import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Shared plumbing for the two web servers (webInterview.ts, webReport.ts):
 * a 127.0.0.1-only `node:http` server where every route requires the one-time
 * token embedded in the printed URL, serving one static page, one SSE snapshot
 * stream, and JSON POST routes. CLI-only concern, not exported from index.ts.
 */

const MAX_BODY_BYTES = 65536;
const SSE_PING_INTERVAL_MS = 15000;

/**
 * Broadcasts `{revision, behavior, state}` snapshots to attached SSE clients;
 * a newly attached client immediately receives the current snapshot.
 */
export class SnapshotSession<TState> {
  private revision = 0;
  private readonly clients = new Set<ServerResponse>();

  constructor(
    private readonly behavior: string,
    protected state: TState,
  ) {}

  protected setState(state: TState): void {
    this.state = state;
    this.revision += 1;
    const frame = this.snapshotFrame();
    for (const client of this.clients) client.write(frame);
  }

  attach(res: ServerResponse): void {
    this.clients.add(res);
    res.write(this.snapshotFrame());
  }

  detach(res: ServerResponse): void {
    this.clients.delete(res);
  }

  closeClients(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  private snapshotFrame(): string {
    const snapshot = { revision: this.revision, behavior: this.behavior, state: this.state };
    return `data: ${JSON.stringify(snapshot)}\n\n`;
  }
}

function tokenMatches(provided: string | null, token: string): boolean {
  if (provided === null) return false;
  const providedBuffer = Buffer.from(provided);
  const tokenBuffer = Buffer.from(token);
  return (
    providedBuffer.length === tokenBuffer.length && timingSafeEqual(providedBuffer, tokenBuffer)
  );
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (body.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

/** The slice of a SnapshotSession the request handler needs. */
interface SseSession {
  attach(res: ServerResponse): void;
  detach(res: ServerResponse): void;
  closeClients(): void;
}

export interface WebServerOptions {
  pageHtml: string;
  session: SseSession;
  /** POST route handlers by pathname; each returns the HTTP status to send. */
  post: Record<string, (body: unknown) => number>;
  /** Defaults to 0 (a random free port). */
  port?: number | undefined;
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  options: WebServerOptions,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  if (!tokenMatches(url.searchParams.get("token"), token)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(options.pageHtml);
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    options.session.attach(res);
    const ping = setInterval(() => {
      res.write(": ping\n\n");
    }, SSE_PING_INTERVAL_MS);
    ping.unref();
    req.on("close", () => {
      clearInterval(ping);
      options.session.detach(res);
    });
    return;
  }

  const handler = req.method === "POST" ? options.post[url.pathname] : undefined;
  if (handler !== undefined) {
    readJsonBody(req).then(
      (body) => {
        const status = handler(body);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: status === 200 }));
      },
      () => {
        res
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: false }));
      },
    );
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
}

export interface RunningWebServer {
  /** Tokenized URL to print and open in the browser. */
  url: string;
  /** Ends attached SSE clients and shuts the server down. */
  close(): Promise<void>;
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const token = randomBytes(16).toString("hex");
  const server = createServer((req, res) => {
    handleRequest(req, res, token, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    close: () => {
      options.session.closeClients();
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        // Keep-alive sockets from POST requests would otherwise stall close().
        server.closeAllConnections();
      });
    },
  };
}
