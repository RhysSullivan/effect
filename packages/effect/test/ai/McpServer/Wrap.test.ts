import { assert, describe, it } from "@effect/vitest"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpSchema from "effect/ai/McpSchema"
import * as McpServer from "effect/ai/McpServer"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { makeMcpStdioHarness } from "./TestUtils/McpStdioHarness.ts"

// Calls the global middleware saw.
const seen: Array<string> = []

const Registered = Toolkit.make(Tool.make("Whoami", { success: Schema.String }))

// A wrapper that renames every tool its sources list.
const renaming = Layer.effect(
  McpServer.McpServer,
  Effect.map(McpServer.McpServer, (server) =>
    McpServer.wrap(server, {
      addToolSource: (options) =>
        server.addToolSource({
          ...options,
          list: Effect.map(options.list, (listed) =>
            ("tools" in listed ? listed.tools : listed).map((tool) =>
              new McpSchema.Tool({ ...tool, name: `wrapped_${tool.name}` })
            )),
          owns: (name) => name.startsWith("wrapped_")
        })
    }))
)

const Recording = McpServer.middleware()((effect, options) =>
  Effect.andThen(Effect.sync(() => seen.push(options.method)), effect)
)

const app = Layer.mergeAll(
  McpServer.toolkit(Registered).pipe(
    Layer.provide(Registered.toLayer({ Whoami: () => Effect.succeed("alice") }))
  ),
  Layer.effectDiscard(Effect.gen(function*() {
    const server = yield* McpServer.McpServer
    yield* server.addToolSource({
      list: Effect.succeed([new McpSchema.Tool({ name: "remote", inputSchema: { type: "object" } })]),
      call: (name) => Effect.succeed(new McpSchema.CallToolResult({ content: [{ type: "text", text: name }] }))
    })
  })),
  Recording.layerGlobal
).pipe(Layer.provide(renaming))

describe("McpServer.wrap", () => {
  it.effect("keeps the server's middleware and toolkits, and its replaced members apply", () =>
    Effect.gen(function*() {
      const harness = yield* makeMcpStdioHarness(McpProtocol.v2025_11_25, [McpProtocol.v2025_11_25], app)
      yield* harness.initialize()
      const listed = yield* harness.sendRequest("tools/list")
      const names = (listed.result as { tools: ReadonlyArray<{ name: string }> }).tools.map((tool) => tool.name)
      assert.deepStrictEqual(names, ["Whoami", "wrapped_remote"])
      // Global middleware added through the wrapper runs for the toolkit's call.
      const whoami = yield* harness.sendRequest("tools/call", { name: "Whoami", arguments: {} })
      assert.include(JSON.stringify(whoami.result), "alice")
      assert.include(seen, "tools/call")
      const remote = yield* harness.sendRequest("tools/call", { name: "wrapped_remote", arguments: {} })
      assert.include(JSON.stringify(remote.result), "wrapped_remote")
    }))

  it("is the server's own for members it does not replace", () => {
    const server = { tools: [], addTool: () => Effect.void } as unknown as McpServer.McpServer["Service"]
    const wrapped = McpServer.wrap(server, {})
    assert.strictEqual(wrapped.tools, server.tools)
    assert.strictEqual(wrapped.addTool, server.addTool)
  })
})
