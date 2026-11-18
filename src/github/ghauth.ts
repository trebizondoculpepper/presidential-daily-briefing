/**
 * The authenticated gh account (host and login only, never a token). Shared by `pdb serve` (its
 * authentication context), `pdb quotas` and the employing-human resolver (#664). Since #869 it
 * delegates to the typed GH service's `account.current` capability; the signature is unchanged.
 */
import { ghService } from "./service/service.js";

export function ghAuthContext(signal?: AbortSignal): Promise<{ host: string; login: string }> {
  return ghService.account.current(signal);
}
