# Issue-creation command design

Specified #199's CLI-only create service, target resolution, structured input and
honest partial/unknown outcomes. Ordinary reporters can create where GitHub permits;
that does not grant workflow authority. Explicitly avoided blind retry, false
exactly-once claims, local identity/config writes and implicit MCP mutations.
All acceptance uses injected/fake GitHub boundaries; no live issue was created to
test the feature.
