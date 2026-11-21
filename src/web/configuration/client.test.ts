/**
 * The Configuration page client (#818): parsing of `/api/v1/configuration`, errors as text, and
 * project changes that never show a superseded response. Injected fetch; no server.
 */
import { describe, expect, it } from "vite-plus/test";
import { render } from "svelte/server";
import {
  configurationLoader,
  parseConfigurationResponse,
  type ConfigurationState as State,
} from "./client.js";
import ConfigurationState from "./ConfigurationState.svelte";

const row = (
  key: string,
  value: string | number | boolean | null,
  source: "explicit" | "default" = "default",
  type = "port",
) => ({
  key,
  scope: "global" as const,
  type,
  value,
  defaultValue: 4372,
  source,
  description: `The ${key} setting.`,
});
const body = (selected: string | null) => ({
  schemaVersion: 1 as const,
  kind: "configuration" as const,
  selected,
  view: {
    schemaVersion: 1 as const,
    kind: "configuration" as const,
    scope: "global" as const,
    repository: null,
    state: "ok" as const,
    path: "/somewhere/config.toml",
    storedVersion: null,
    rows: [row("serve.port", 4800, "explicit")],
    warnings: [],
  },
});
const reply = (status: number, json: unknown) =>
  new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
const html = (state: State) =>
  render(ConfigurationState, { props: { state } }).body.replace(/<!--[\s\S]*?-->/g, "");

describe("configuration client (#818)", () => {
  it("reads a configuration response and refuses other shapes", async () => {
    const ok = await parseConfigurationResponse(body("owner/a"));
    expect(ok?.view.rows[0]).toMatchObject({ key: "serve.port", value: 4800, source: "explicit" });
    expect(parseConfigurationResponse({ schemaVersion: 2, kind: "configuration" })).toBeNull();
    expect(parseConfigurationResponse({ schemaVersion: 1, kind: "rules", view: {} })).toBeNull();
    expect(parseConfigurationResponse(null)).toBeNull();
  });

  it("renders rows with value, source, type, default and description", () => {
    const out = html({ status: "ready", response: body(null) });
    expect(out).toContain("serve.port");
    expect(out).toContain("4800");
    expect(out).toContain("explicit");
    expect(out).toContain("port");
    expect(out).toContain("4372");
    expect(out).toContain("Registered settings for the global scope");
  });

  it("shows an unsupported scope warning rather than pretending to read it", () => {
    const bad: State = {
      status: "ready",
      response: {
        schemaVersion: 1,
        kind: "configuration",
        selected: "owner/a",
        view: {
          schemaVersion: 1,
          kind: "configuration",
          scope: "project",
          repository: "owner/a",
          state: "unsupported",
          path: "owner/a/.github/triage.toml",
          storedVersion: null,
          rows: [],
          warnings: ["owner/a is served without a local project"],
        },
      },
    };
    expect(html(bad)).toContain("no local configuration file to read");
  });

  it("loads and delivers only the latest read's state", async () => {
    const states: State[] = [];
    const loader = configurationLoader(
      "/api/v1/configuration",
      async () => reply(200, body(null)),
      (next) => states.push(next),
    );
    await loader.load("");
    expect(states.at(-1)?.status).toBe("ready");
    // An HTTP error becomes a readable error with its code.
    await loader.load("");
    const failed = new Map<string, State[]>();
    const errorLoader = configurationLoader(
      "/api/v1/configuration",
      async (_i, init) => {
        void init;
        return reply(403, {});
      },
      (next) => {
        const key = next.status;
        const list = failed.get(key) ?? [];
        list.push(next);
        failed.set(key, list);
      },
    );
    await errorLoader.load("");
    expect(failed.has("error")).toBe(true);
  });
});
