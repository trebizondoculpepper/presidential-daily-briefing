import { describe, expect, it } from "vite-plus/test";
import { issueWrites, WRITE, writeCommand } from "./issuewrites.js";
import { writeStep } from "../../workflow/claims.js";

// Synthetic writes only; nothing reaches gh.
describe("typed issue writes (#942 part 2)", () => {
  it("generates each write's command from the typed operation", () => {
    expect(
      writeCommand({
        kind: "label-create",
        repository: "o/r",
        name: "agent:a",
        color: "ededed",
        description: "d",
      }),
    ).toEqual([
      "label",
      "create",
      "agent:a",
      "--repo",
      "o/r",
      "--color",
      "ededed",
      "--description",
      "d",
    ]);
    expect(
      writeCommand({
        kind: "labels-edit",
        repository: "o/r",
        number: 3,
        add: ["x"],
        remove: ["y", "z"],
      }),
    ).toEqual([
      "issue",
      "edit",
      "3",
      "--repo",
      "o/r",
      "--add-label",
      "x",
      "--remove-label",
      "y",
      "--remove-label",
      "z",
    ]);
    expect(writeCommand({ kind: "comment", repository: "o/r", number: 3, body: "hi" })).toEqual([
      "issue",
      "comment",
      "3",
      "--repo",
      "o/r",
      "--body",
      "hi",
    ]);
  });

  it("keeps the typed write on a plan step without changing its serialized form", () => {
    const op = { kind: "comment" as const, repository: "o/r", number: 3, body: "hi" };
    const step = writeStep("comment", op);
    expect(step[WRITE]).toEqual(op);
    expect({ ...step, status: "pending" }[WRITE]).toEqual(op);
    expect(JSON.parse(JSON.stringify(step))).toEqual({
      step: "comment",
      command: writeCommand(op),
    });
  });

  it("applies a write through the gh write boundary with the caller's guard", async () => {
    const seen: unknown[] = [];
    const guard = async () => "g";
    await issueWrites(async (args, call) => {
      seen.push(args, call?.guard === guard);
    }).apply(
      { kind: "labels-edit", repository: "o/r", number: 1, add: [], remove: ["a"] },
      { guard },
    );
    expect(seen).toEqual([["issue", "edit", "1", "--repo", "o/r", "--remove-label", "a"], true]);
  });
});
