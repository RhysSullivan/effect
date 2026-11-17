---
"effect": patch
---

Let an `McpServer.addToolSource` `list` return `{ tools, ttlMs?, cacheScope?, _meta? }` beside the tools alone. On `2026-07-28` the `tools/list` result then carries the smallest `ttlMs` of the sources and the server's own `cacheHints.tools`, `"public"` only when no registered tool is listed, the server sets no `cacheHints.tools` and every source says `"public"`, and each source's `_meta` keys, the first source's value winning. A source that returns its tools alone, and every earlier protocol revision, list as before.
