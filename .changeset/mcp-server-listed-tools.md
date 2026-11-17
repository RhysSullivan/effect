---
"effect": patch
---

Add a `listed` option to `McpServer.wrap`: a function applied to every tool the server lists from then on, whatever registered it (`addTool`, a toolkit or a tool source). It receives the object that was registered or listed, so it can tell tools apart by identity.
