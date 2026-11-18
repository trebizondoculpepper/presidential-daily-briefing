import { describe, expect, it } from "vite-plus/test";
import { createAppServices } from "./composition.js";
import { defaultServeRuntime } from "./serve.js";
import { ghService } from "./github/service/service.js";
import type { GhCall } from "./github/service/transport.js";

// Synthetic transports only; construction must not spawn git or gh.
describe("shared application composition (#870)", () => {
  it("is pure: building it spawns no process and makes no request", () => {
    let gitCalls = 0;
    const calls: unknown[] = [];
    const services = createAppServices({
      git: {
        git: async () => {
          gitCalls++;
          return "";
        },
      },
      gh: {
        env: {},
        transport: async (call: GhCall) => {
          calls.push(call);
          return { ok: true, stdout: "{}" };
        },
      },
    });
    expect(typeof services.git.workingTreeRoot).toBe("function");
    expect(typeof services.gh.account.current).toBe("function");
    expect(gitCalls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("reuses the production GH service by default", () => {
    expect(createAppServices().gh).toBe(ghService);
  });

  it("gives serve one shared Git service for identity and project resolution", async () => {
    const services = createAppServices({ git: { git: async () => "/w\n" } });
    const runtime = defaultServeRuntime(services);
    expect(runtime.git).toBe(services.git);
    expect(runtime.identityRuntime?.git ?? services.git).toBe(services.git);
  });

  it("routes the checkout repository and account through the shared GH service", async () => {
    const asked: string[] = [];
    const services = createAppServices({ git: {} });
    const gh = {
      ...services.gh,
      repos: {
        ...services.gh.repos,
        fromCheckout: async (cwd?: string) => {
          asked.push(`repo:${cwd}`);
          return "o/r";
        },
      },
      account: {
        ...services.gh.account,
        current: async () => {
          asked.push("account");
          return { host: "github.com", login: "me" };
        },
      },
    };
    const runtime = defaultServeRuntime({ git: services.git, gh });
    expect(await runtime.currentRepository("/w")).toBe("o/r");
    expect(await runtime.authContext()).toEqual({ host: "github.com", login: "me" });
    expect(asked).toEqual(["repo:/w", "account"]);
  });
});
