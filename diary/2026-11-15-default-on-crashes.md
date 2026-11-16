# Default-on Node crash reporting

Owner requested a release with reporting enabled by default for everyone and a config
opt-out. Reviewed contract #653 merged before runtime work. The shared reporter keeps
its existing fatal-only allowlist and public source mapping. User/process-scope config
is deliberately separate from repository-only pdb config: remote callers or repository
content cannot change consent for a shared server. Immediate environment opt-out runs
before config I/O and SDK import. Invalid configuration fails closed for telemetry.

Normal CI/package/smoke processes explicitly disable telemetry. Default-on and packed
fatal tests intercept the transport, including the default host; no live telemetry is
needed to prove the default/opt-out branch. Broader role-list work remains #651/#652;
its ranking spike is isolated in #654.
