import { assert, describe, it } from "@effect/vitest"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpServer from "effect/ai/McpServer"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

// Counts how often each tool's parameters are described as JSON Schema.
const described: Record<string, number> = {}
const Counted = (name: string) =>
  Schema.String.check(Schema.makeFilter<string>(() => true, {
    representation: { id: `test/ai/mcp/counted/${name}`, payload: null },
    toJsonSchema: () => {
      described[name] = (described[name] ?? 0) + 1
      return {}
    }
  }))

const Tools = Toolkit.make(
  Tool.make("First", { parameters: Schema.Struct({ text: Counted("First") }), success: Schema.String }),
  Tool.make("Second", { parameters: Schema.Struct({ text: Counted("Second") }), success: Schema.String })
)
const app = McpServer.toolkit(Tools).pipe(
  Layer.provide(Tools.toLayer({
    First: ({ text }) => Effect.succeed(text),
    Second: ({ text }) => Effect.succeed(text)
  })),
  Layer.provideMerge(McpServer.layerHttpRequestScoped({
    name: "descriptors",
    version: "1.0.0",
    path: "/mcp",
    protocols: [McpProtocol.v2026_07_28]
  }))
)

const request = (method: string, params: Record<string, unknown>, name?: string) =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(name === undefined ? {} : { "Mcp-Name": name })
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" }
        }
      }
    })
  })

describe("McpServer.toolkit", () => {
  it.live("describes a tool when it is first listed or called, once", () =>
    Effect.gen(function*() {
      const { dispose, handler } = HttpRouter.toWebHandler(app, { disableLogger: true })
      yield* Effect.addFinalizer(() => Effect.promise(dispose))
      const send = (req: Request) => Effect.promise(() => handler(req).then((response) => response.text()))

      // The server is built by the first request; a call describes only its tool,
      // whose input schema it checks against the request's parameter headers.
      const called = yield* send(request("tools/call", { name: "First", arguments: { text: "hi" } }, "First"))
      assert.include(called, `"text":"\\"hi\\""`)
      assert.deepStrictEqual(described, { First: 1 })

      const listed = yield* send(request("tools/list", {}))
      assert.include(listed, `"name":"First"`)
      assert.include(listed, `"name":"Second"`)
      assert.deepStrictEqual(described, { First: 1, Second: 1 })

      yield* send(request("tools/list", {}))
      yield* send(request("tools/call", { name: "Second", arguments: { text: "hi" } }, "Second"))
      assert.deepStrictEqual(described, { First: 1, Second: 1 })
    }))

  it.effect("describes each tool when registered on a server that wraps McpServer", () =>
    Effect.gen(function*() {
      const server = yield* McpServer.McpServer.make
      const added: Array<string> = []
      const wrapped = McpServer.McpServer.of({
        ...server,
        addTool: (options) => {
          added.push(options.tool.name)
          return server.addTool(options)
        }
      })
      const Plain = Toolkit.make(
        Tool.make("First", { parameters: Schema.Struct({ text: Schema.String }), success: Schema.String }),
        Tool.make("Second", { parameters: Schema.Struct({ text: Schema.String }), success: Schema.String })
      )
      yield* McpServer.registerToolkit(Plain).pipe(
        Effect.provideService(McpServer.McpServer, wrapped),
        Effect.provide(Plain.toLayer({
          First: ({ text }) => Effect.succeed(text),
          Second: ({ text }) => Effect.succeed(text)
        }))
      )
      assert.deepStrictEqual(added, ["First", "Second"])
      assert.deepStrictEqual(server.tools.map(({ tool }) => tool.inputSchema.type), ["object", "object"])
    }))

  // A success schema whose JSON Schema cannot be generated: a symbol key.
  const Undescribable = Toolkit.make(
    Tool.make("Bad", {
      parameters: Schema.Struct({ text: Schema.String }),
      success: Schema.Struct({ [Symbol.for("test/undescribable")]: Schema.String })
    })
  )
  const badHandlers = Undescribable.toLayer({ Bad: () => Effect.die("not called") })

  it.effect("fails registration on a wrapped server, naming a tool it cannot describe", () =>
    Effect.gen(function*() {
      const server = yield* McpServer.McpServer.make
      const exit = yield* McpServer.registerToolkit(Undescribable).pipe(
        Effect.provideService(McpServer.McpServer, McpServer.McpServer.of({ ...server })),
        Effect.provide(badHandlers),
        Effect.exit
      )
      assert.isTrue(exit._tag === "Failure")
      assert.include(String(Cause.squash((exit as any).cause)), "McpServer cannot describe tool 'Bad'")
    }))

  it.live("answers an error for a tool it cannot describe, when that tool is first listed or called", () =>
    Effect.gen(function*() {
      const app = McpServer.toolkit(Undescribable).pipe(
        Layer.provide(badHandlers),
        Layer.provideMerge(McpServer.layerHttpRequestScoped({
          name: "undescribable",
          version: "1.0.0",
          path: "/mcp",
          protocols: [McpProtocol.v2026_07_28]
        }))
      )
      const { dispose, handler } = HttpRouter.toWebHandler(app, { disableLogger: true })
      yield* Effect.addFinalizer(() => Effect.promise(dispose))
      const send = (req: Request) => Effect.promise(() => handler(req).then((response) => response.text()))
      const listed = JSON.parse(yield* send(request("tools/list", {})))
      assert.strictEqual(listed.error?.code, -32603)
      const called = JSON.parse(yield* send(request("tools/call", { name: "Bad", arguments: { text: "x" } }, "Bad")))
      assert.strictEqual(called.error?.code, -32603)
    }))
})
