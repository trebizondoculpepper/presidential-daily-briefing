# Configuration design session

Consolidated owner decisions into serve-configuration-layers.md: separate configuration service, CLI, served application state and Configuration page; registered-project table; shared reload with repeated serve; graceful shutdown; applied-versus-saved restart calculation and simple parser failure handling. New security infrastructure is explicitly deferred without disabling existing controls.

Tickets #804/#805/#807/#808/#812–#816 carry bounded scopes and estimates. #806 remains deferred. Preserve the original #452 partial implementation and downstream dependency history. The existing Svelte Work spike contract already supports a secondary read-only /work-preview with multiple persistent inline expansions; clarified owner decisions on #753 rather than duplicate its implementation work. Licensing remains research #787 before #634.

No runtime, user configuration, server process or release changed. Documentation-first review remains required before implementation of amended architecture.
