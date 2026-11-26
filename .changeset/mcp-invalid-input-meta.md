---
"effect": patch
---

Mark a refused tool input in the tool error's `_meta`. From `2025-11-25` an MCP server answers invalid arguments with a tool error, as it answers a tool that failed while running, so a client could not tell the two apart. The result's `_meta` now holds `McpSchema.InvalidInputMeta` (`"website.effect/invalidInput"`) set to `true` when the arguments do not decode or a tool handler fails with `InvalidParams`, and never for a failure.
