---
"effect": patch
---

Add `McpServer.wrap(server, members)`, which wraps an MCP server service with some of its members replaced, such as `addToolSource`. The wrapper keeps the server's own global middleware, skills, events, transport and lazily described toolkits; a service built with a spread of the server keeps none of them.
