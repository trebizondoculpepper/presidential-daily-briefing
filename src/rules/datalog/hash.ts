import { createHash } from "node:crypto";
import type { PolicyBundle } from "./bundle.js";

/**
 * The rules hash: sha256 over the bundle's JSON. Clauses are canonical EDN, so comments and
 * layout in policy/*.edn do not change it; any change to rules, ordering, explanations,
 * witnesses, constants or schema does.
 */
export const rulesHashOf = (bundle: PolicyBundle): string =>
  createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
