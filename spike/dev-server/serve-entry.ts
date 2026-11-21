/** Experimental (#791): the real `pdb serve` entry, run from source under the spike supervisor. */
import { main } from "../../src/cli.js";

await main([
  "serve",
  "--repo",
  "trebizondoculpepper/presidential-daily-briefing",
  "--port",
  "5197",
]);
