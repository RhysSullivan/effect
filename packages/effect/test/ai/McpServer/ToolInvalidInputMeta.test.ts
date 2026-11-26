import { assert, describe, it } from "@effect/vitest"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpSchema from "effect/ai/McpSchema"
import * as McpServer from "effect/ai/McpServer"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { makeHttpHarness } from "./TestUtils/McpHttpHarness.ts"
import { readMcpHttpResponse } from "./TestUtils/McpHttpResponse.ts"
import { makeServerLayer } from "./TestUtils/McpServerLayer.ts"
import { type JsonRpcMessage, makeMcpStdioHarness } from "./TestUtils/McpStdioHarness.ts"

const Id = Schema.Struct({ id: Schema.String })
const Tools = Toolkit.make(
  Tool.make("Refuses", { parameters: Id, success: Schema.String }),
  Tool.make("Crashes", { parameters: Id, success: Schema.String })
)

const toolkit = McpServer.toolkit(Tools).pipe(Layer.provide(Tools.toLayer({
  Refuses: () => Effect.fail(new McpSchema.InvalidParams({ message: "id must be numeric" })) as Effect.Effect<never>,
  Crashes: () => Effect.die("boom")
})))

// Tools added with `addTool`: one refuses its input, one fails while running.
const direct = Layer.effectDiscard(Effect.gen(function*() {
  const server = yield* McpServer.McpServer
  yield* server.addTool({
    tool: new McpSchema.Tool({ name: "DirectRefuses", inputSchema: { type: "object" } }),
    annotations: Context.empty(),
    handle: () => Effect.fail(new McpSchema.InvalidParams({ message: "Missing id" }))
  })
  yield* server.addTool({
    tool: new McpSchema.Tool({ name: "DirectFails", inputSchema: { type: "object" } }),
    annotations: Context.empty(),
    handle: () => Effect.fail(new McpSchema.InternalError({ message: "Upstream failed" }))
  })
}))

const layer = Layer.mergeAll(toolkit, direct)

// Each call: the text it answers with, and whether it is a refused input.
const calls: ReadonlyArray<readonly [name: string, args: object, text: string, refused: boolean]> = [
  ["DirectRefuses", {}, "Missing id", true],
  ["DirectFails", {}, "Upstream failed", false]
]

const check = (result: unknown, text: string, refused: boolean) => {
  const value = result as {
    content: ReadonlyArray<{ text: string }>
    isError: boolean
    _meta?: Record<string, unknown>
  }
  assert.strictEqual(value.isError, true)
  assert.strictEqual(value.content[0]?.text, text)
  assert.strictEqual(value._meta?.[McpSchema.InvalidInputMeta], refused ? true : undefined)
}

describe("McpServer marks a refused input", () => {
  it.effect("on 2025-11-25, for a handler and parameters that do not decode, never for a failure", () =>
    Effect.gen(function*() {
      const harness = yield* makeMcpStdioHarness(McpProtocol.v2025_11_25, [McpProtocol.v2025_11_25], layer)
      yield* harness.initialize()
      for (const [name, args, text, refused] of calls) {
        check((yield* harness.sendRequest("tools/call", { name, arguments: args })).result, text, refused)
      }
      const undecoded = (yield* harness.sendRequest("tools/call", { name: "Refuses", arguments: { id: 1 } })).result
      check(undecoded, (undecoded as { content: ReadonlyArray<{ text: string }> }).content[0]!.text, true)
      const crashed = (yield* harness.sendRequest("tools/call", { name: "Crashes", arguments: { id: "x" } })).result
      assert.strictEqual(
        (crashed as { _meta?: Record<string, unknown> })._meta?.[McpSchema.InvalidInputMeta],
        undefined
      )
    }))

  it.live("on 2026-07-28 over HTTP, beside the server's own metadata", () =>
    Effect.gen(function*() {
      const protocol = McpProtocol.v2026_07_28
      const harness = yield* makeHttpHarness(
        layer.pipe(Layer.provideMerge(makeServerLayer({ name: "Refusals", protocols: [protocol], mode: "request" })))
      )
      const post = Effect.fnUntraced(function*(name: string, args: object) {
        const response = yield* harness.post({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": protocol.protocolVersion,
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" }
            }
          }
        }, { "MCP-Protocol-Version": protocol.protocolVersion, "Mcp-Method": "tools/call", "Mcp-Name": name })
        return ((yield* readMcpHttpResponse(response)) as JsonRpcMessage).result
      })
      for (const [name, args, text, refused] of calls) {
        const result = yield* post(name, args)
        check(result, text, refused)
        assert.isDefined((result as { _meta: Record<string, unknown> })._meta["io.modelcontextprotocol/serverInfo"])
      }
      const undecoded = yield* post("Refuses", { id: 1 })
      assert.strictEqual(
        (undecoded as { _meta: Record<string, unknown> })._meta[McpSchema.InvalidInputMeta],
        true
      )
      const crashed = yield* post("Crashes", { id: "x" })
      assert.strictEqual((crashed as { _meta: Record<string, unknown> })._meta[McpSchema.InvalidInputMeta], undefined)
    }))
})
