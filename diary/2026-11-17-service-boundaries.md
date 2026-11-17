# GH capabilities and serve composition

Recorded the owner's separation of application composition, serve-only state and
configuration storage. GH consumers call typed asynchronous capabilities; the
internal transport may use high-level commands or REST/GraphQL. Audit #868 defines
the concrete surface. Foundation #869 and wiring #870 are separate from small
follow-on migrations, with existing caching, recovery and native decisions intact.
No runtime migration or security framework is included in this docs change.
