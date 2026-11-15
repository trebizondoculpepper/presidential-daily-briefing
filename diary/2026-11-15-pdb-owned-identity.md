# PDB-owned local identity design

Finalized #319's private root `pdb.toml` and one-time matching Agent Inbox import,
keeping existing PDB names canonical. Defined read-only legacy fallback without
claiming import, explicit initializer reuse, no legacy writes/network registration,
private-file safety and concurrent source/target change handling. Kept shared policy,
global serve settings and human routing separate. No actual local identity changed.
