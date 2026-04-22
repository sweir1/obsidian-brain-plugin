import * as http from "http";
import type { App, PluginManifest } from "obsidian";
import { handleStatus } from "./handlers/status";
import { handleActive } from "./handlers/active";
import {
  handleDataview,
  type DataviewRequestBody,
} from "./handlers/dataview";
import { handleBase, type BaseRequestBody } from "./handlers/base";

export interface ServerOptions {
  app: App;
  manifest: PluginManifest;
  token: string;
  /** 0 = pick a random free port. */
  port: number;
}

const MAX_BODY_BYTES = 256 * 1024; // 256KB — DQL queries are human-authored, 256KB is already absurd.

export class CompanionServer {
  private server: http.Server | null = null;
  private readyAt = 0;
  /**
   * Serialises expensive handlers (/dataview) so a second call can't stack
   * behind a stuck first one — Dataview has no cancellation API, so a
   * pathological query runs to completion. One at a time keeps CPU bounded.
   */
  private dataviewChain: Promise<void> = Promise.resolve();
  /**
   * Serialises /base evaluation for the same reason — the Path B evaluator
   * walks every markdown file in the vault to build entries, which can be
   * CPU-heavy on large vaults. One at a time keeps CPU bounded.
   */
  private baseChain: Promise<void> = Promise.resolve();

  constructor(private opts: ServerOptions) {}

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port, "127.0.0.1", () => {
        this.readyAt = Date.now();
        const addr = this.server!.address();
        if (typeof addr === "object" && addr && typeof addr.port === "number") {
          resolve(addr.port);
        } else {
          reject(new Error("could not determine listening port"));
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
      this.server = null;
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${this.opts.token}`) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const key = `${req.method} ${url.pathname}`;

    try {
      switch (key) {
        case "GET /status":
          return handleStatus(res, this.opts.manifest, this.opts.app, this.readyAt);
        case "GET /active":
          return handleActive(res, this.opts.app);
        case "POST /dataview":
          this.runDataview(req, res);
          return;
        case "POST /base":
          this.runBase(req, res);
          return;
        default:
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({ error: "not found", path: url.pathname }),
          );
      }
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: "internal",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private runDataview(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const task = async () => {
      let body: DataviewRequestBody;
      try {
        body = await readJsonBody<DataviewRequestBody>(req);
      } catch (err) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: "bad_request",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }
      await handleDataview(res, this.opts.app, body);
    };

    // Chain onto the previous dataview job so only one runs at a time.
    this.dataviewChain = this.dataviewChain.then(task, task);
  }

  private runBase(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const task = async () => {
      let body: BaseRequestBody;
      try {
        body = await readJsonBody<BaseRequestBody>(req);
      } catch (err) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: "bad_request",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }
      await handleBase(res, this.opts.app, body);
    };

    // Chain onto the previous base job so only one runs at a time.
    this.baseChain = this.baseChain.then(task, task);
  }
}

function readJsonBody<T = Record<string, unknown>>(
  req: http.IncomingMessage,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({} as T);
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(raw) as T;
        if (typeof parsed !== "object" || parsed === null) {
          reject(new Error("request body must be a JSON object"));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(
          new Error(
            `invalid JSON body: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    });
    req.on("error", reject);
  });
}
