---
"effect": patch
---

Identify a declared MCP tool failure in its result's `_meta` under `McpServer.FailureMeta`, so a client can tell declared failures apart by their `_tag`. A failure sent by its message carries its `_tag`, message and declared scalar fields there, never redacted, defect, error, unknown or nested ones.
