# Git/GH services and controllers

Recorded the owner's acceptance of binary Git behind a typed service, matching the
GH capability boundary. Main PDB commands/subcommands must use those facades;
release and standalone tooling retain the direct-Git exception. One application
composition root constructs shared instances, thin transport controllers call
feature services, and native workflow rules keep decisions. Migration is now
tracked by module, combining Git/GH needs in one ticket where practical.
