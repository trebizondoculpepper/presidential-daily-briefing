# Dev-server spike (#791) — experimental

Not wired into `npm run dev`, the production build, `pdb serve` or the published package. It exists
to reproduce the evidence in [doc/reports/dev-server-spike.md](../../doc/reports/dev-server-spike.md);
the proposed design is [doc/design/dev-server.md](../../doc/design/dev-server.md). Delete or replace
it when the reviewed contract is implemented.

```sh
# 1. Assets with genuine HMR on a disposable port (5199)
npx vp dev spike/dev-server --config spike/dev-server/vite.config.ts

# 2. Supervised backend from a local module, on 5198
PDB_SPIKE_PORT=5198 node spike/dev-server/supervise.mjs \
  spike/dev-server/server.ts spike/dev-server/server.ts

# 3. The same supervisor running the real `pdb serve` from source, on 5197
node spike/dev-server/supervise.mjs spike/dev-server/serve-entry.ts src
```
