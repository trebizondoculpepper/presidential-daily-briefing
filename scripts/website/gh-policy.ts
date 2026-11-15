import { CaptureFailure } from "./failure.js";
import { publicRepository } from "./provenance.js";

/** Tokenize enough GraphQL syntax to inspect operation/root targets, never rewrite a query. */
function tokens(source: string): string[] {
  if (source.length > 256_000) throw new CaptureFailure("Query exceeds capture policy bound.");
  const pattern =
    /\s+|#[^\r\n]*|"(?:\\.|[^"\\])*"|\.\.\.|[A-Za-z_][A-Za-z_0-9]*|-?\d+|[!$():=@[\]{|},]/gy;
  const result: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) throw new CaptureFailure("Unsupported query syntax.");
    offset = pattern.lastIndex;
    if (!/^\s|^#/.test(match[0]) && match[0] !== ",") result.push(match[0]);
  }
  return result;
}

export function allowGhRead(argv: readonly string[]): void {
  if (argv[0] !== "api" || argv.length > 80)
    throw new CaptureFailure("Only bounded gh api reads are allowed.");
  let endpoint: string | undefined;
  const fields = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i]!;
    if (value === "--include") continue;
    if (value === "-f" || value === "-F") {
      const field = argv[++i] ?? "";
      const split = field.indexOf("=");
      const key = field.slice(0, split);
      const content = field.slice(split + 1);
      if (
        split < 1 ||
        !/^[A-Za-z_]\w*$/.test(key) ||
        fields.has(key) ||
        (value === "-F" && !/^\d+$/.test(content))
      )
        throw new CaptureFailure("Unsupported gh field.");
      fields.set(key, content);
    } else if (!value.startsWith("-") && endpoint === undefined) endpoint = value;
    else throw new CaptureFailure("Unsupported gh option.");
  }
  if (endpoint !== "graphql") {
    if (fields.size || !endpoint || !/^\/?repos\//.test(endpoint) || endpoint.includes("..")) {
      throw new CaptureFailure("REST read is outside the public target.");
    }
    const url = new URL(endpoint.replace(/^\//, ""), "https://api.github.com/");
    const decoded = decodeURIComponent(url.pathname);
    if (
      url.origin !== "https://api.github.com" ||
      url.hash ||
      url.username ||
      url.password ||
      !(
        decoded === `/repos/${publicRepository}` ||
        decoded.startsWith(`/repos/${publicRepository}/`)
      ) ||
      decoded.includes("/../") ||
      decoded.includes("/./") ||
      !/^[A-Za-z0-9_./%+-]+$/.test(url.pathname)
    ) {
      throw new CaptureFailure("REST read is outside the public target.");
    }
    const seen = new Set<string>();
    for (const [key, value] of url.searchParams) {
      if (
        seen.has(key) ||
        !["page", "per_page"].includes(key) ||
        !/^[1-9]\d{0,3}$/.test(value) ||
        Number(value) > (key === "per_page" ? 100 : 1000)
      )
        throw new CaptureFailure("Unsupported REST pagination.");
      seen.add(key);
    }
    return;
  }
  if (
    fields.get("owner") !== publicRepository.split("/")[0] ||
    fields.get("name") !== publicRepository.split("/")[1]
  )
    throw new CaptureFailure("Query target is outside the public repository.");
  const query = tokens(fields.get("query") ?? "");
  if (
    query[0] !== "query" ||
    query.includes("mutation") ||
    query.includes("subscription") ||
    query.includes("@")
  ) {
    throw new CaptureFailure("Only a plain GraphQL query is allowed.");
  }
  let depth = 0,
    parens = 0,
    roots = 0,
    ended = false;
  for (let i = 1; i < query.length; i++) {
    let token = query[i]!;
    if (
      depth === 1 &&
      parens === 0 &&
      token === "pdbReadRate" &&
      query[i + 1] === ":" &&
      query[i + 2] === "rateLimit"
    ) {
      token = "rateLimit";
      i += 2;
    }
    if (ended) throw new CaptureFailure("Multiple GraphQL operations are forbidden.");
    if (token === "(") parens++;
    else if (token === ")") parens--;
    else if (token === "{" && parens === 0) depth++;
    else if (token === "}" && parens === 0) {
      depth--;
      if (depth === 0) ended = true;
    } else if (depth === 1 && parens === 0) {
      if (token !== "repository" && token !== "rateLimit")
        throw new CaptureFailure("Unsupported GraphQL root.");
      if (token === "repository") roots++;
    }
    // Every repository argument list must bind only the fixed owner/name variables.
    if (token === "repository" && query[i + 1] === "(") {
      if (query.slice(i + 1, i + 11).join("") !== "(owner:$ownername:$name)") {
        throw new CaptureFailure("Unsupported repository selector.");
      }
    }
    if (parens < 0 || depth < 0) throw new CaptureFailure("Malformed query.");
  }
  if (!ended || depth !== 0 || parens !== 0 || roots !== 1)
    throw new CaptureFailure("Expected one public repository query.");
}
