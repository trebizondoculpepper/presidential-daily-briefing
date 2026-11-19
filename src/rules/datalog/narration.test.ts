import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { buildPolicy, policyDir, readSources } from "./build.js";
import { narrationHashOf, rulesHashOf } from "./hash.js";
import { compileEnglish } from "./english.js";
import { purposeLimit, purposeText } from "./narration.js";
import { rulesDocument, rulesText, validateRulesArtifact } from "./rules-command.js";
import { declaredRulesContext } from "../declared-context.js";
import { compileProjectPolicy } from "./project/compile.js";

const source = (name: string) => readFileSync(join(policyDir, name), "utf8");
const edited = (change: (text: string) => string) => (name: string) =>
  name === "decisions.edn" ? change(source(name)) : source(name);

describe("rule-attached literal purposes (#578)", () => {
  it("carries every built-in decision and denial purpose through the artifact and shared document", () => {
    const bundle = buildPolicy();
    const model = compileEnglish(bundle);
    const doc = rulesDocument(declaredRulesContext(), {}, model);
    expect(doc.narration).toMatchObject({ total: 67, supplied: 67, missing: [] });
    for (const definition of bundle.definitions) {
      expect(model.decisions.find((r) => r.id === definition.id)?.purpose).toBe(definition.purpose);
      expect(doc.decisions.find((r) => r.id === definition.id)?.purpose).toBe(definition.purpose);
    }
    for (const [id, purpose] of Object.entries(bundle.denialPurposes ?? {}))
      expect(doc.eligibility.denials.find((r) => r.id === id)?.purpose).toBe(purpose);
    expect(doc.decisions.some((d) => d.id === "D-HUMAN-ASK-YOU")).toBe(true);
  });

  it("keeps formal CLI conditions and shape versions unchanged when documentation is removed", () => {
    const bundle = buildPolicy();
    const annotated = compileEnglish(bundle);
    const { denialPurposes: _, ...plain } = bundle;
    plain.definitions = plain.definitions.map(({ purpose: _purpose, ...definition }) => definition);
    const older = compileEnglish(plain);
    expect(older.modelVersion).toBe(annotated.modelVersion);
    expect(older.policyVersion).toBe(annotated.policyVersion);
    expect(older.rulesHash).toBe(annotated.rulesHash);
    expect(narrationHashOf(plain)).toBeNull();
    expect(older.narrationHash).toBeUndefined();
    expect(annotated.narrationHash).toBe(narrationHashOf(bundle));
    expect(
      validateRulesArtifact(older, {
        rulesHash: older.rulesHash,
        policyVersion: older.policyVersion,
      }),
    ).toBe(older);
    expect(() =>
      validateRulesArtifact(older, {
        rulesHash: annotated.rulesHash,
        policyVersion: annotated.policyVersion,
        narrationHash: annotated.narrationHash,
      }),
    ).toThrow(/narration revision/);
    expect(() =>
      validateRulesArtifact(annotated, {
        rulesHash: annotated.rulesHash,
        policyVersion: annotated.policyVersion,
      }),
    ).toThrow(/narration revision/);
    const before = rulesDocument(declaredRulesContext(), {}, older);
    const after = rulesDocument(declaredRulesContext(), {}, annotated);
    expect(before.schemaVersion).toBe(after.schemaVersion);
    expect(rulesText(before)).toBe(rulesText(after));
    expect(before.narration).toMatchObject({ total: 67, supplied: 0 });
    expect(before.narration.missing).toHaveLength(67);
    expect(rulesText(after)).not.toContain(bundle.definitions[0].purpose);
  });

  it.each([
    null,
    1,
    "",
    "   ",
    "x".repeat(purposeLimit + 1),
    "two\nlines",
    "two\u2028lines",
    "two\u2029lines",
  ])("rejects invalid decision purpose %j", (value) => {
    expect(() =>
      readSources(
        edited((text) => text.replace(/:purpose "[^"\n]*"/, `:purpose ${JSON.stringify(value)}`)),
      ),
    ).toThrow(/purpose must be/);
  });

  it("rejects unknown and duplicate denial targets and misspelled metadata keys", () => {
    expect(() =>
      buildPolicy(
        edited((t) =>
          t.replace(
            ':denial-purposes\n {"D-DENY-CLAIM"',
            ':denial-purposes\n {"D-DENY-NOT-DECLARED"',
          ),
        ),
      ),
    ).toThrow(/unknown denial ID D-DENY-NOT-DECLARED/);
    expect(() =>
      readSources(
        edited((t) =>
          t.replace(":denial-purposes\n {", ':denial-purposes\n {"D-DENY-CLAIM" "Duplicate" '),
        ),
      ),
    ).toThrow(/duplicate key "D-DENY-CLAIM"/);
    expect(() => readSources(edited((t) => t.replace(":purpose", ":purpsoe")))).toThrow(
      /unknown key :purpsoe/,
    );
    expect(() =>
      readSources(
        edited((t) =>
          t.replace(
            ':kind "addressed-response"',
            ':purpose "Duplicate" :kind "addressed-response"',
          ),
        ),
      ),
    ).toThrow(/duplicate key :purpose/);
  });

  it("treats markup, URLs and template-like text literally", () => {
    const literal = "<img src=x onerror=alert(1)> {head} ${secret} https://example.test";
    expect(purposeText(literal, "test")).toBe(literal);
  });

  it("supports optional project-purpose metadata without changing executable queries or format versions", () => {
    const fixture = readFileSync(
      new URL("../../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
      "utf8",
    );
    const base = {
      policyVersion: 1,
      rulesHash: "811a2953071e3e54c081245f1b3b15f661cc7cb7a883e1b2c4f893d613195ba0",
    };
    const plain = compileProjectPolicy(fixture, base);
    // Independently captured from the merged v1 compiler before this implementation.
    expect(plain.projectRulesHash).toBe(
      "d220c517956f53eb2f9ecd2026dee977712c3f514f1c57501ca734f564286efb",
    );
    expect(plain.effectiveRulesHash).toBe(
      "03fd8d1d6a157a86bfe88397c8072f91e5d48b602ba8be6f06ce52575c1f84d1",
    );
    const text = fixture
      .replace(":format-version 1", ":format-version 2")
      .replace(":why", ':purpose "Prefer this project label." :why');
    const narrated = compileProjectPolicy(text, base);
    expect(narrated.preferences[0].purpose).toBe("Prefer this project label.");
    expect(narrated.rules).toBe(plain.rules);
    expect(narrated.preferences.map((p) => [p.matchQuery, p.query, p.witnesses])).toEqual(
      plain.preferences.map((p) => [p.matchQuery, p.query, p.witnesses]),
    );
    expect(plain.formatVersion).toBe(1);
    expect(narrated.formatVersion).toBe(2);
    expect(() =>
      compileProjectPolicy(fixture.replace(":why", ':purpose "Invalid in v1" :why'), base),
    ).toThrow(/native-key/);
    expect(
      compileProjectPolicy(fixture.replace(":format-version 1", ":format-version 2"), base)
        .preferences[0].purpose,
    ).toBeUndefined();
    expect(narrated.projectionVersion).toBe(plain.projectionVersion);
    expect(narrated.projectRulesHash).not.toBe(plain.projectRulesHash);
    expect(narrated.effectiveRulesHash).not.toBe(plain.effectiveRulesHash);
    expect(() =>
      compileProjectPolicy(
        fixture
          .replace(":format-version 1", ":format-version 2")
          .replace(":why", ":purpose 1 :why"),
        base,
      ),
    ).toThrow(/preference-purpose/);
    expect(() =>
      compileProjectPolicy(fixture.replace(":why", ':purpsoe "Typo" :why'), base),
    ).toThrow(/native-key/);
  });
});

it("preserves existing project base pins across bundled purpose revisions", () => {
  const bundle = buildPolicy();
  const base = { policyVersion: bundle.policyVersion, rulesHash: rulesHashOf(bundle) };
  const fixture = readFileSync(
    new URL("../../../doc/reports/fixtures/project-rules-v1.edn", import.meta.url),
    "utf8",
  ).replace(/:base-rules-hash "[a-f0-9]{64}"/, `:base-rules-hash "${base.rulesHash}"`);
  const revised = structuredClone(bundle);
  revised.definitions[0].purpose = "Revised literal narration for the same executable rule.";
  expect(rulesHashOf(revised)).toBe(base.rulesHash);
  expect(narrationHashOf(revised)).not.toBe(narrationHashOf(bundle));
  expect(
    compileProjectPolicy(fixture, { ...base, rulesHash: rulesHashOf(revised) }).formatVersion,
  ).toBe(1);
});
