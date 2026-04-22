import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import {
  resolveDataview,
  UNAVAILABLE_MESSAGES,
  handleDataview,
} from "./dataview";

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader: (k: string, v: string) => void;
  end: (chunk?: string) => void;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(chunk?: string) {
      if (chunk !== undefined) this.body = chunk;
    },
  };
  return r;
}

/**
 * Build a minimal fake `app` object shaped the way `resolveDataview` reads it.
 * Each parameter controls one discrimination axis.
 */
function fakeApp(opts: {
  pluginPresent?: boolean;
  pluginEnabled?: boolean;
  apiReady?: boolean;
}): App {
  const pluginPresent = opts.pluginPresent ?? false;
  const pluginEnabled = opts.pluginEnabled ?? false;
  const apiReady = opts.apiReady ?? false;

  const dataviewEntry = pluginPresent
    ? apiReady
      ? { api: { query: async () => ({ successful: true, value: null }) } }
      : { api: undefined } // installed but api not yet registered
    : undefined;

  const plugins: Record<string, { api?: unknown } | undefined> = {};
  if (pluginPresent) plugins["dataview"] = dataviewEntry;

  const enabled = new Set<string>();
  if (pluginEnabled) enabled.add("dataview");

  return {
    plugins: { plugins, enabledPlugins: enabled },
    // the handler only reads `app.plugins`; other App fields are unused
  } as unknown as App;
}

describe("resolveDataview", () => {
  it("returns not_installed when no entry exists under app.plugins.plugins.dataview", () => {
    const r = resolveDataview(fakeApp({ pluginPresent: false }));
    expect(r).toEqual({ ok: false, kind: "not_installed" });
  });

  it("returns not_enabled when plugin entry exists but isn't in enabledPlugins", () => {
    const r = resolveDataview(
      fakeApp({ pluginPresent: true, pluginEnabled: false }),
    );
    expect(r).toEqual({ ok: false, kind: "not_enabled" });
  });

  it("returns api_not_ready when plugin is enabled but .api isn't the expected shape", () => {
    const r = resolveDataview(
      fakeApp({ pluginPresent: true, pluginEnabled: true, apiReady: false }),
    );
    expect(r).toEqual({ ok: false, kind: "api_not_ready" });
  });

  it("returns ok:true with the api when the plugin is fully ready", () => {
    const r = resolveDataview(
      fakeApp({ pluginPresent: true, pluginEnabled: true, apiReady: true }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof r.api.query).toBe("function");
  });
});

describe("handleDataview — 424 discriminated responses", () => {
  it("returns 424 dataview_not_installed with install remediation", async () => {
    const res = mockRes();
    await handleDataview(res as unknown as import("http").ServerResponse, fakeApp({}), {
      query: "TABLE file.name",
    });
    expect(res.statusCode).toBe(424);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe("dataview_not_installed");
    expect(parsed.message).toBe(UNAVAILABLE_MESSAGES.not_installed.message);
    expect(parsed.message).toMatch(/Settings → Community plugins → Browse/);
  });

  it("returns 424 dataview_not_enabled with toggle-on remediation", async () => {
    const res = mockRes();
    await handleDataview(
      res as unknown as import("http").ServerResponse,
      fakeApp({ pluginPresent: true, pluginEnabled: false }),
      { query: "TABLE file.name" },
    );
    expect(res.statusCode).toBe(424);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe("dataview_not_enabled");
    expect(parsed.message).toMatch(/toggle 'Dataview' on/);
  });

  it("returns 424 dataview_api_not_ready with reload-Obsidian remediation", async () => {
    const res = mockRes();
    await handleDataview(
      res as unknown as import("http").ServerResponse,
      fakeApp({ pluginPresent: true, pluginEnabled: true, apiReady: false }),
      { query: "TABLE file.name" },
    );
    expect(res.statusCode).toBe(424);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe("dataview_api_not_ready");
    expect(parsed.message).toMatch(/Reload Obsidian/);
  });

  it("rejects empty query with 400 bad_request before checking Dataview", async () => {
    const res = mockRes();
    await handleDataview(res as unknown as import("http").ServerResponse, fakeApp({}), {
      query: "",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("bad_request");
  });
});
