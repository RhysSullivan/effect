import { assert, describe, it } from "@effect/vitest"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpSchema from "effect/ai/McpSchema"
import * as McpServer from "effect/ai/McpServer"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { makeHttpHarness } from "./TestUtils/McpHttpHarness.ts"
import { readMcpHttpResponse } from "./TestUtils/McpHttpResponse.ts"
import { makeServerLayer } from "./TestUtils/McpServerLayer.ts"
import { makeMcpStdioHarness } from "./TestUtils/McpStdioHarness.ts"

const descriptor = (name: string) => new McpSchema.Tool({ name, inputSchema: { type: "object" } })

const text = (value: string) => new McpSchema.CallToolResult({ content: [{ type: "text", text: value }] })

const Registered = Toolkit.make(Tool.make("Search", { success: Schema.String }))
const registeredLayer = McpServer.toolkit(Registered).pipe(
  Layer.provide(Registered.toLayer({ Search: () => Effect.succeed("registered") }))
)

const source = (list: McpServer.ToolSourceList | ReadonlyArray<McpSchema.Tool>) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const server = yield* McpServer.McpServer
    const names = new Set(("tools" in list ? list.tools : list).map((tool) => tool.name))
    yield* server.addToolSource({
      list: Effect.succeed(list),
      call: (name) => Effect.succeed(text(name)),
      owns: (name) => names.has(name)
    })
  }))

interface ListedResult {
  readonly ttlMs?: number
  readonly cacheScope?: string
  readonly _meta?: Readonly<Record<string, unknown>>
  readonly tools: ReadonlyArray<{ readonly name: string }>
}

interface CalledResult {
  readonly result: { readonly content: ReadonlyArray<{ readonly text: string }> }
}

const meta = (protocol: McpProtocol.ProtocolAdapter<any>) => ({
  "io.modelcontextprotocol/protocolVersion": protocol.protocolVersion,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" }
})

const modern = McpProtocol.v2026_07_28

// One `tools/list` on 2026-07-28 against a server made of `layers`.
const listModern = Effect.fnUntraced(function*(
  layers: Layer.Layer<never, never, McpServer.McpServer>,
  cacheHints?: McpServer.CacheHints
) {
  const harness = yield* makeHttpHarness(
    layers.pipe(Layer.provideMerge(makeServerLayer({ name: "Sources", protocols: [modern], cacheHints })))
  )
  const response = yield* harness.post(
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta(modern) } },
    { "MCP-Protocol-Version": modern.protocolVersion, "Mcp-Method": "tools/list" }
  )
  const message = (yield* readMcpHttpResponse(response)) as { readonly result: ListedResult }
  return message.result
})

describe("McpServer.addToolSource list results", () => {
  it.effect("keeps a source that returns its tools alone private and stale", () =>
    Effect.gen(function*() {
      const result = yield* listModern(source([descriptor("Deploy")]))
      assert.deepStrictEqual(result.tools.map((tool) => tool.name), ["Deploy"])
      assert.strictEqual(result.ttlMs, 0)
      assert.strictEqual(result.cacheScope, "private")
      assert.deepStrictEqual(Object.keys(result._meta ?? {}), ["io.modelcontextprotocol/serverInfo"])
    }))

  it.effect("takes the smallest freshness, public only from every source, and each source's metadata", () =>
    Effect.gen(function*() {
      const first = source({
        tools: [descriptor("Deploy")],
        ttlMs: 60_000,
        cacheScope: "public",
        _meta: { "example/first": 1, "example/shared": "first" }
      })
      const second = source({
        tools: [descriptor("Status")],
        ttlMs: 5_000,
        cacheScope: "public",
        _meta: { "example/second": 2, "example/shared": "second" }
      })
      const result = yield* listModern(Layer.mergeAll(first, second))
      assert.deepStrictEqual(result.tools.map((tool) => tool.name), ["Deploy", "Status"])
      assert.strictEqual(result.ttlMs, 5_000)
      assert.strictEqual(result.cacheScope, "public")
      assert.strictEqual(result._meta?.["example/first"], 1)
      assert.strictEqual(result._meta?.["example/second"], 2)
      assert.strictEqual(result._meta?.["example/shared"], "first")
      assert.isDefined(result._meta?.["io.modelcontextprotocol/serverInfo"])
    }))

  it.effect("stays private when one source gives no scope", () =>
    Effect.gen(function*() {
      const result = yield* listModern(Layer.mergeAll(
        source({ tools: [descriptor("Deploy")], ttlMs: 60_000, cacheScope: "public" }),
        source({ tools: [descriptor("Status")] })
      ))
      assert.strictEqual(result.ttlMs, 60_000)
      assert.strictEqual(result.cacheScope, "private")
    }))

  it.effect("stays private when a registered tool is listed", () =>
    Effect.gen(function*() {
      const result = yield* listModern(Layer.mergeAll(
        registeredLayer,
        source({ tools: [descriptor("Deploy")], ttlMs: 60_000, cacheScope: "public" })
      ))
      assert.deepStrictEqual(result.tools.map((tool) => tool.name), ["Search", "Deploy"])
      assert.strictEqual(result.cacheScope, "private")
    }))

  it.effect("counts the server's own tools hint, which is private", () =>
    Effect.gen(function*() {
      const result = yield* listModern(
        source({ tools: [descriptor("Deploy")], ttlMs: 5_000, cacheScope: "public" }),
        { tools: { ttl: "1 second", cacheScope: "private" } }
      )
      assert.strictEqual(result.ttlMs, 1_000)
      assert.strictEqual(result.cacheScope, "private")
    }))

  it.effect("lists and calls a listing source on a revision without cache fields", () =>
    Effect.gen(function*() {
      const legacy = McpProtocol.v2025_11_25
      const harness = yield* makeMcpStdioHarness(
        legacy,
        [legacy],
        source({ tools: [descriptor("Deploy")], ttlMs: 60_000, cacheScope: "public", _meta: { "example/x": 1 } })
      )
      yield* harness.initialize()
      const listed = (yield* harness.sendRequest("tools/list")).result as ListedResult
      assert.deepStrictEqual(listed.tools.map((tool) => tool.name), ["Deploy"])
      assert.notProperty(listed, "ttlMs")
      const called = (yield* harness.sendRequest("tools/call", { name: "Deploy", arguments: {} })) as CalledResult
      assert.strictEqual(called.result.content[0].text, "Deploy")
    }))

  it.effect("hands a call's request metadata to the source", () =>
    Effect.gen(function*() {
      const echo = Layer.effectDiscard(Effect.gen(function*() {
        const server = yield* McpServer.McpServer
        yield* server.addToolSource({
          list: Effect.succeed([descriptor("Echo")]),
          call: () =>
            Effect.map(
              McpSchema.McpRequestContext,
              (context) => text(JSON.stringify(context.requestMetadata?.["example/kept"] ?? null))
            )
        })
      }))
      const harness = yield* makeHttpHarness(
        echo.pipe(Layer.provideMerge(makeServerLayer({ name: "Echo", protocols: [modern] })))
      )
      const response = yield* harness.post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "Echo", arguments: {}, _meta: { ...meta(modern), "example/kept": { path: "/v1/x" } } }
        },
        { "MCP-Protocol-Version": modern.protocolVersion, "Mcp-Method": "tools/call", "Mcp-Name": "Echo" }
      )
      const called = (yield* readMcpHttpResponse(response)) as CalledResult
      assert.deepStrictEqual(JSON.parse(called.result.content[0].text), { path: "/v1/x" })
    }))
})
