/** The optional-viewer fallback admits only genuine absence (#865 review). Injected results only. */
import { describe, expect, it } from "vite-plus/test";
import { CommandIdentity, IdentityPreparationRequired } from "./commandidentity.js";
import type { EffectiveIdentity } from "./effectiveidentity.js";

const unresolved = (code: string): EffectiveIdentity =>
  ({
    state: "unresolved",
    agent: null,
    entry: null,
    source: "unresolved",
    role: null,
    roleSource: "unknown",
    setup: { state: "none", changed: false, persisted: false, notices: [] },
    diagnostic: { code, message: "no identity", recovery: "none" },
  }) as unknown as EffectiveIdentity;

const select = (result: EffectiveIdentity, agent?: string) =>
  new CommandIdentity(
    async () => result,
    async () => {},
    () => {},
  ).select(
    { intent: "readonly", ...(agent ? { agent } : {}) },
    { json: true, allowUnresolved: true },
  );

describe("optional-viewer fallback (#865)", () => {
  it("continues unattributed only for genuine absence or a project mismatch", async () => {
    for (const code of ["identity-absent", "not-a-repository", "repository-mismatch"])
      await expect(select(unresolved(code))).resolves.toMatchObject({ agent: null });
  });

  it("still refuses a broken binding, invalid value, filesystem failure or explicit selector", async () => {
    for (const code of ["identity-unresolved", "invalid-value", "filesystem", "incompatible"])
      await expect(select(unresolved(code))).rejects.toBeInstanceOf(IdentityPreparationRequired);
    await expect(select(unresolved("identity-absent"), "someone")).rejects.toBeInstanceOf(
      IdentityPreparationRequired,
    );
  });
});
