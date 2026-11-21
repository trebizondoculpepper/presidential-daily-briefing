/**
 * Experimental (#791): the backend half of the dev-server spike. It is a plain Node server that
 * imports a real PDB module, so the proof covers "PDB code is the source of API behavior" without
 * a development-only collector or policy engine.
 */
import { createServer } from "node:http";
import { escapeHtml } from "../../src/serve/rules-page.js";

/** The value the restart probe edits: a backend edit must change a live API response. */
export const answer = "v2";

const server = createServer((request, response) => {
  if (request.url === "/api/answer") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ answer, escaped: escapeHtml("<b>&") }));
    return;
  }
  response.writeHead(404).end();
});
const port = Number(process.env.PDB_SPIKE_PORT ?? 5198);
server.listen(port, "127.0.0.1", () =>
  console.log(`spike backend on ${port} (pid ${process.pid})`),
);
