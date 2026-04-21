import * as http from "http";
import type { App, PluginManifest } from "obsidian";
import { handleStatus } from "./handlers/status";
import { handleActive } from "./handlers/active";

export interface ServerOptions {
  app: App;
  manifest: PluginManifest;
  token: string;
  /** 0 = pick a random free port. */
  port: number;
}

export class CompanionServer {
  private server: http.Server | null = null;
  private readyAt = 0;

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
}
