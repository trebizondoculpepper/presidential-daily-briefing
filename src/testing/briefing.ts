/** Briefing call helper shared by split test suites (#335 stage 3). Test-only. */
import { briefing } from "../briefing/briefing.js";
import type { Snapshot } from "../github/types.js";
import { time } from "./snapshots.js";

export const brief = (data: Snapshot) => briefing(data, { limit: 100 }, new Date(time));
