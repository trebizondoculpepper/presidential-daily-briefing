# Public website domain and deployment runbook

For #622, extending the [website contract](../design/public-website.md) and its
#602 deployment handoff. This is operational documentation and prospective
integration guidance; it installs no workflow and changes no hosting or DNS.
The immediate TLS/propagation verification is recorded on
[#621](https://github.com/trebizondoculpepper/presidential-daily-briefing/issues/621#issuecomment-6902650624).

## Observed configuration — 2026-11-15 (public verification at 22:46 UTC)

| Boundary                     | Observed value                                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical public origin      | `https://pdb.stodge.org`                                                                                                                                                                       |
| DNS                          | Cloudflare DNS-only CNAME `pdb` → `trebizondoculpepper.github.io`, Auto TTL (owner setup); authoritative and public resolver answers match                                                     |
| Authoritative nameservers    | `donald.ns.cloudflare.com`, `eleanor.ns.cloudflare.com`                                                                                                                                        |
| GitHub Pages                 | `build_type=legacy`, branch `gh-pages`, path `/`, status `built`                                                                                                                               |
| Domain binding               | Pages API `cname=pdb.stodge.org`, `html_url=https://pdb.stodge.org/`                                                                                                                           |
| Branch artifact              | Root `CNAME` decodes to exactly `pdb.stodge.org`; blob `7fb39f8e904ccff60fbde433b8692a8c74214b94`                                                                                              |
| Latest observed branch build | Commit `c235c2007b0ba894d5efdde1c11fa7edd89d6cb1`, built 2026-11-15 20:01:58 UTC                                                                                                               |
| TLS                          | GitHub certificate approved for `pdb.stodge.org`, expires 2027-02-13; `https_enforced=true`                                                                                                    |
| Routing                      | All four custom-domain routes and both CSS/JS assets return certificate-validated HTTPS 200; HTTP gives matching HTTPS 301; default GitHub project URLs redirect to matching custom-root paths |

These are dated observations, not promises that settings stay unchanged. The
current site is the owner-authorized **manual preview**, not proof that the
release-driven #602 pipeline is installed. The source checkout currently has CI
and Publish workflows, no website deployment workflow. #601 supplies a capture
builder; its first real released build needs an explicitly authorized official
release containing that generator. Never publish npm merely to repair hosting.

## Domain preservation: two distinct modes

**Current branch mode.** Keep `CNAME` at the root of `gh-pages` when publishing a
replacement branch artifact. Its contents must remain the custom hostname, with
no scheme or repository path. A branch replacement must not drop this file or
silently reset the Pages source/domain. Do not change or overwrite the current
branch to test a release artifact.

**Target mode for #602: custom Actions Pages deployment.** Preserve the repository's
Pages custom-domain binding as control-plane configuration. GitHub documents that
custom workflows do not require an artifact `CNAME` and ignore one if present.
Therefore choose an Actions-based Pages binding for the reviewed #602 workflow;
keep the validated static artifact unchanged rather than inserting `CNAME` after
hashing. The mode transition is a deliberate rollout step, not a side effect of
every build. Do not delete/recreate the Pages site or clear/re-add its domain on
normal deployment/retry. Read back the binding and HTTPS enforcement after any
explicit source-mode transition.

[GitHub's custom-domain/publishing-source guidance](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
describes the different CNAME behavior. If a future implementation instead chooses
branch publishing, review that architectural change first and include `CNAME` in
its validated artifact schema and hashes. #601's current verifier permits HTML,
CSS and JS plus its manifest, and rejects unexpected entries. Bypassing that
verifier or appending unhashed files is not domain preservation.

## #602 integration boundaries

Keep the release handoff, exact npm version/gitHead/integrity, released templates,
bounded read-only capture, strict manifest, stable/next separation, serialization
and monotonic deployment intent from [the contract](../design/public-website.md).
Domain checks supplement them; they do not replace version/source verification.

1. **Read-only preflight.** Inspect Pages source/mode, custom hostname, certificate
   state and HTTPS enforcement. A missing/wrong binding is an actionable setup
   failure. Stop before deployment; do not repair DNS or re-register a domain in
   the build. Host checks have no npm publishing, DNS-provider or Pages-write token.
2. **Protected deploy job.** Receive only the validated artifact/manifest. Keep
   Pages/OIDC/deployment permissions out of capture. Recheck the pinned stable
   candidate against trusted release history and the previous deployment intent.
   Use the normal Pages deployment action only after those checks and the intended
   source mode are established. Preserve `cname` and `https_enforced`.
3. **Post-host confirmation.** Inspect the domain binding again, then check canonical
   routes/assets and deployed manifest/version through normal HTTPS. Record host
   deployment ID, verified source/version/artifact identity, time and routing/TLS
   results. A host-success response plus failed DNS/TLS is a **partial outcome**,
   not a fully verified custom-domain deployment.
4. **Retry without republishing.** Inspect an unknown deployment before retrying.
   Reuse the same approved candidate or a known newer one; never roll back a newer
   site or allocate another npm version. A routing failure does not justify an
   automatic DNS/proxy flip, domain recreation or deletion of the last site.

The current manual preview has no released-site manifest to validate. Check that
manifest only after the actual #602 pipeline delivers one; do not manufacture a
release banner or use a preview as evidence for an official released build.

## Canonical route and asset checks

The base path on the custom domain is **`/`**, not
`/presidential-daily-briefing/`. Verify:

| Page            | Expected canonical URL                    |
| --------------- | ----------------------------------------- |
| Home            | `https://pdb.stodge.org/`                 |
| How it works    | `https://pdb.stodge.org/how-it-works/`    |
| Getting started | `https://pdb.stodge.org/getting-started/` |
| Use cases       | `https://pdb.stodge.org/use-cases/`       |

For each page require HTTPS 200, a valid hostname certificate and expected page
identity, not a 200 error/placeholder page. Parse its stylesheet/script/image
references and check the actual referenced assets with normal certificate
validation. The observed preview assets are `/assets/site.css` and
`/assets/copy.js`; do not assume those names for every future generator.
Reject active assets loaded over HTTP. Follow links from nested routes as well as
Home so a broken relative base cannot hide behind a successful root response.

Verify corresponding HTTP URLs redirect to the same HTTPS path. Also verify
`https://trebizondoculpepper.github.io/presidential-daily-briefing/` and each nested
project URL redirect to the matching `pdb.stodge.org` path, without duplicated
repository prefixes, loops or a different final host. Bound redirects and timeouts.
The 2026-11-15 check observed one redirect from each default project URL.

Read-only examples:

```sh
gh api repos/trebizondoculpepper/presidential-daily-briefing/pages
gh api repos/trebizondoculpepper/presidential-daily-briefing/pages/health
dig @donald.ns.cloudflare.com pdb.stodge.org CNAME +short
dig @eleanor.ns.cloudflare.com pdb.stodge.org CNAME +short
dig @1.1.1.1 pdb.stodge.org CNAME +short
dig @8.8.8.8 pdb.stodge.org CNAME +short
curl --fail --head --max-time 20 https://pdb.stodge.org/
curl --head --max-time 20 http://pdb.stodge.org/
curl --fail --location --max-redirs 5 --max-time 20 --output /dev/null \
  --write-out '%{http_code} %{url_effective} %{ssl_verify_result}\n' \
  https://trebizondoculpepper.github.io/presidential-daily-briefing/how-it-works/
```

The first health request can return an empty asynchronous result: poll that same
resource boundedly and treat absent fields as unknown. `curl --fail` alone does
not prove the final host/path, page identity or release manifest; inspect all
those fields. A result obtained using TLS bypass or an origin override is
insufficient for public HTTPS acceptance. `dig` is diagnostic tooling, not a new
CLI runtime dependency; deployment verification may use an equivalent DNS client.

## Minimal recovery, based on the failing boundary

| Evidence                                                    | Recovery                                                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Authoritative DNS correct, public/normal resolver differs   | Record both answers and timestamps; allow propagation, retry the same bounded check; do not repeatedly replace correct records                |
| DNS wrong                                                   | Show the exact owner-approved subdomain CNAME correction for separate authorization; leave unrelated records, wildcards and zone policy alone |
| Pages binding/source missing or changed                     | Identify the drift from the intended mode/domain; use an explicitly reviewed targeted settings correction; preserve existing content          |
| Certificate absent or hostname mismatch                     | Compare DNS and Pages health/certificate evidence; do not hide it with Cloudflare proxying or weaker TLS                                      |
| Certificate issuance appears stuck despite valid DNS        | Follow GitHub's certificate troubleshooting; re-registration is an exceptional operator repair, not a deployment step                         |
| Certificate valid but HTTP remains 200                      | Check `https_enforced`; enable enforcement as a targeted operator correction after the certificate is available                               |
| Nested route or asset fails                                 | Inspect artifact paths/base URLs and the deployed identity; fix the generator/deployment mapping through its normal review path               |
| Version/manifest differs, or CDN still serves older content | Mark unknown/stale, inspect the host deployment and boundedly recheck; never call it verified or overwrite a known newer deployment           |

[GitHub's HTTPS documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)
explains automatic custom-domain certificate provisioning and HTTPS enforcement.
On 2026-11-15, re-registering the already-correct domain restarted missing certificate
issuance; enforcement was enabled only after a valid certificate appeared. That
one repair is not a reason to recreate the binding during later builds. No CAA
change, proxy flip, new token or unrelated zone edit was required.

## Handoff and verification cases

#621 completed immediate public DNS/TLS/redirect acceptance. #622 records the binding
and this integration contract. #602 still implements the release/deployment pipeline;
merging this runbook alone neither installs it nor authorizes an npm publication.

Its fixture checks should cover: a valid binding; missing/wrong custom domain;
wrong source mode; absent/pending certificate; enforcement false; wrong final
host/path; nested-route and asset failures; stale manifest/version; and a host
success followed by failed public verification. Read-only checks must not call DNS,
Pages settings, npm publication or release mutation APIs. Test both CNAME handling
modes at their declared schema boundary, and keep the exact-artifact/monotonic
ordering failure cases from #599/#601 intact.
