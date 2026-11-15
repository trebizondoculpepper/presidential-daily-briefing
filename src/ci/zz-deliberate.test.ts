// DISPOSABLE (#393): proves CI annotations, summary and report upload on a real failure.
// Removed before review; never merged.
import { expect, it } from "vite-plus/test";

it("deliberate failure for the CI reporting check (#393)", () => {
  expect({ answer: 41 }).toEqual({ answer: 42 });
});
