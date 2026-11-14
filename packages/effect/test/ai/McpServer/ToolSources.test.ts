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
import { initializeHttpSession, makeHttpHarness } from "./TestUtils/McpHttpHarness.ts"
import { readMcpHttpResponse } from "./TestUtils/McpHttpResponse.ts"
import { makeServerLayer } from "./TestUtils/McpServerLayer.ts"
import { type JsonRpcMessage, makeMcpStdioHarness } from "./TestUtils/McpStdioHarness.ts"

class CurrentUser extends Context.Service<CurrentUser, string>()("test/CurrentUser") {}

const Registered = Toolkit.make(Tool.make("Search", { success: Schema.String }))

const descriptor = (name: string) => new McpSchema.Tool({ name, inputSchema: { type: "object" } })

const text = (value: string) => new McpSchema.CallToolResult({ content: [{ type: "text", text: value }] })

const toolNames = (message: JsonRpcMessage) =>
  (message.result as { readonly tools: ReadonlyArray<{ readonly name: string }> }).tools.map(({ name }) => name)

const resultText = (message: JsonRpcMessage) =>
  (message.result as { readonly content: ReadonlyArray<{ readonly text: string }> }).content[0].text

// A source whose list and calls are counted, so tests can see that each request asks it.
const makeSource = (prefix: string, names: ReadonlyArray<string>) => {
  const counts = { lists: 0, calls: [] as Array<string> }
  const register = Effect.fnUntraced(function*(options?: { readonly owns?: (name: string) => boolean }) {
    const server = yield* McpServer.McpServer
    yield* server.addToolSource({
      list: Effect.sync(() => {
        counts.lists++
        return names.map(descriptor)
      }),
      call: (name, payload) =>
        Effect.sync(() => {
          counts.calls.push(name)
          return text(`${prefix}:${name}:${JSON.stringify(payload)}`)
        }),
      owns: options?.owns
    })
  })
  return { counts, register }
}

const registeredLayer = McpServer.toolkit(Registered).pipe(
  Layer.provide(Registered.toLayer({ Search: () => Effect.succeed("registered") }))
)

describe("McpServer.addToolSource", () => {
  it.effect("lists sourced tools on every request, after registered tools", () =>
    Effect.gen(function*() {
      const first = makeSource("first", ["Search", "Deploy", "Status"])
      const second = makeSource("second", ["Status", "Logs"])
      const harness = yield* makeMcpStdioHarness(
        McpProtocol.v2025_11_25,
        [McpProtocol.v2025_11_25],
        Layer.mergeAll(
          registeredLayer,
          Layer.effectDiscard(first.register({ owns: (name) => name !== "Logs" })),
          Layer.effectDiscard(second.register())
        )
      )
      yield* harness.initialize()

      // Registered tools shadow sourced tools, and the first source shadows the second.
      assert.deepStrictEqual(toolNames(yield* harness.sendRequest("tools/list")), [
        "Search",
        "Deploy",
        "Status",
        "Logs"
      ])
      yield* harness.sendRequest("tools/list")
      assert.deepStrictEqual([first.counts.lists, second.counts.lists], [2, 2])
    }))

  it.effect("lists a sourced tool only from the source its calls go to", () =>
    Effect.gen(function*() {
      // A owns every name, so a call of `b_tool` goes to A: B's `b_tool` is not listed.
      const a = makeSource("a", ["a_tool"])
      const b = makeSource("b", ["b_tool"])
      const harness = yield* makeMcpStdioHarness(
        McpProtocol.v2025_11_25,
        [McpProtocol.v2025_11_25],
        Layer.mergeAll(Layer.effectDiscard(a.register()), Layer.effectDiscard(b.register()))
      )
      yield* harness.initialize()
      assert.deepStrictEqual(toolNames(yield* harness.sendRequest("tools/list")), ["a_tool"])
      assert.strictEqual(
        resultText(yield* harness.sendRequest("tools/call", { name: "b_tool", arguments: {} })),
        "a:b_tool:{}"
      )
    }))

  it.effect("advertises tools when only a source is added", () =>
    Effect.gen(function*() {
      const source = makeSource("only", ["Deploy"])
      const harness = yield* makeMcpStdioHarness(
        McpProtocol.v2025_11_25,
        [McpProtocol.v2025_11_25],
        Layer.effectDiscard(source.register())
      )
      const initialized = yield* harness.initialize()
      const capabilities = (initialized.result as { readonly capabilities: Record<string, unknown> }).capabilities
      assert.deepStrictEqual(capabilities.tools, { listChanged: true })
      // Listing is not needed to call a sourced tool.
      assert.strictEqual(source.counts.lists, 0)
    }))

  it.effect("routes a call to the registered tool, else to the first source that owns the name", () =>
    Effect.gen(function*() {
      const first = makeSource("first", ["Search", "Status"])
      const second = makeSource("second", ["Status", "Logs"])
      const harness = yield* makeMcpStdioHarness(
        McpProtocol.v2025_11_25,
        [McpProtocol.v2025_11_25],
        Layer.mergeAll(
          registeredLayer,
          Layer.effectDiscard(first.register({ owns: (name) => name !== "Logs" && name !== "Missing" })),
          Layer.effectDiscard(second.register({ owns: (name) => name !== "Missing" }))
        )
      )
      yield* harness.initialize()
      const call = (name: string, args: Record<string, unknown> = { id: 1 }) =>
        harness.sendRequest("tools/call", { name, arguments: args })

      assert.strictEqual(resultText(yield* call("Search", {})), "registered")
      assert.strictEqual(resultText(yield* call("Status")), "first:Status:{\"id\":1}")
      assert.strictEqual(resultText(yield* call("Logs")), "second:Logs:{\"id\":1}")
      const missing = yield* call("Missing")
      assert.deepInclude(missing.error, { code: -32602, message: "Tool 'Missing' not found" })
      assert.deepStrictEqual(first.counts.calls, ["Status"])
      assert.deepStrictEqual(second.counts.calls, ["Logs"])
      // Routing a call never lists a source.
      assert.deepStrictEqual([first.counts.lists, second.counts.lists], [0, 0])
    }))

  it.effect("runs the source's list and calls inside middleware and visibility", () =>
    Effect.gen(function*() {
      const state = { user: "guest", seen: [] as Array<string> }
      const Auth = McpServer.middleware<{ provides: CurrentUser }>()((effect, { method, target }) => {
        state.seen.push(`${method} ${target}`)
        return Effect.provideService(effect, CurrentUser, state.user)
      })
      const HideAdmin = McpServer.visibility(({ target }) =>
        Effect.map(CurrentUser, (user) => user === "admin" || !target.startsWith("Admin"))
      )
      const HideFromBlocked = McpServer.visibility(() => Effect.map(CurrentUser, (user) => user !== "blocked"))
      const registration = Effect.gen(function*() {
        const server = yield* McpServer.McpServer
        yield* server.addToolSource({
          list: Effect.map(
            McpSchema.McpRequestContext,
            () => ["Deploy", "AdminReset"].map(descriptor)
          ),
          call: (name) => Effect.succeed(text(name)),
          services: yield* Effect.context<never>()
        })
      }).pipe(
        Effect.provide(HideAdmin.combine(HideFromBlocked).combine(Auth).layer)
      )
      const harness = yield* makeMcpStdioHarness(
        McpProtocol.v2025_11_25,
        [McpProtocol.v2025_11_25],
        Layer.effectDiscard(registration)
      )
      yield* harness.initialize()

      assert.deepStrictEqual(toolNames(yield* harness.sendRequest("tools/list")), ["Deploy"])
      // The list runs the middleware once with an empty target, then each tool's visibility.
      assert.deepStrictEqual(state.seen, ["tools/list ", "tools/list Deploy", "tools/list AdminReset"])
      const hidden = yield* harness.sendRequest("tools/call", { name: "AdminReset", arguments: {} })
      assert.deepInclude(hidden.error, { code: -32602, message: "Tool 'AdminReset' not found" })

      state.user = "admin"
      assert.deepStrictEqual(toolNames(yield* harness.sendRequest("tools/list")), ["Deploy", "AdminReset"])
      const allowed = yield* harness.sendRequest("tools/call", { name: "AdminReset", arguments: {} })
      assert.strictEqual(resultText(allowed), "AdminReset")

      state.user = "blocked"
      assert.deepStrictEqual(toolNames(yield* harness.sendRequest("tools/list")), [])
    }))

  it.effect("reports a failed list as a JSON-RPC error and failed calls as tool errors", () =>
    Effect.gen(function*() {
      const harness = yield* makeMcpStdioHarness(
        McpProtocol.v2025_11_25,
        [McpProtocol.v2025_11_25],
        Layer.effectDiscard(Effect.gen(function*() {
          const server = yield* McpServer.McpServer
          yield* server.addToolSource({
            list: Effect.fail(new McpSchema.InternalError({ message: "Upstream unavailable" })),
            call: (name) =>
              name === "Invalid"
                ? Effect.fail(new McpSchema.InvalidParams({ message: "Missing id" }))
                : Effect.fail(new McpSchema.InternalError({ message: "Upstream failed" }))
          })
        }))
      )
      yield* harness.initialize()

      const listed = yield* harness.sendRequest("tools/list")
      assert.deepInclude(listed.error, { code: -32603, message: "Upstream unavailable" })
      const failed = yield* harness.sendRequest("tools/call", { name: "Deploy", arguments: {} })
      assert.deepStrictEqual(failed.result, {
        content: [{ type: "text", text: "Upstream failed" }],
        isError: true
      })
      const invalid = yield* harness.sendRequest("tools/call", { name: "Invalid", arguments: {} })
      // 2025-11-25 reports invalid input as a tool error, as for registered tools.
      assert.deepStrictEqual(invalid.result, {
        content: [{ type: "text", text: "Missing id" }],
        isError: true
      })
    }))

  it.live("asks the source per request on layerHttpRequestScoped and passes input_required through", () =>
    Effect.gen(function*() {
      const protocol = McpProtocol.v2026_07_28
      const source = makeSource("remote", ["Deploy"])
      const harness = yield* makeHttpHarness(
        Layer.mergeAll(
          Layer.effectDiscard(source.register({ owns: (name) => name !== "Confirm" })),
          Layer.effectDiscard(Effect.gen(function*() {
            const server = yield* McpServer.McpServer
            yield* server.addToolSource({
              list: Effect.succeed([descriptor("Confirm")]),
              call: () =>
                Effect.map(McpSchema.McpRequestContext, (context) =>
                  context.inputResponses?.confirm === undefined
                    ? new McpSchema.InputRequired({
                      inputRequests: {
                        confirm: {
                          method: "elicitation/create",
                          params: {
                            mode: "form",
                            message: "Deploy?",
                            requestedSchema: { type: "object", properties: {} }
                          }
                        }
                      },
                      requestState: "pending"
                    })
                    : text("confirmed"))
            })
          }))
        ).pipe(Layer.provideMerge(makeServerLayer({ name: "Sources", protocols: [protocol], mode: "request" })))
      )
      let id = 0
      const post = Effect.fnUntraced(function*(method: string, params: Record<string, unknown> = {}) {
        const response = yield* harness.post({
          jsonrpc: "2.0",
          id: ++id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": protocol.protocolVersion,
              "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
              "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" }
            }
          }
        }, {
          "MCP-Protocol-Version": protocol.protocolVersion,
          "Mcp-Method": method,
          ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {})
        })
        assert.strictEqual(response.status, 200)
        return (yield* readMcpHttpResponse(response)) as JsonRpcMessage
      })

      assert.deepStrictEqual(toolNames(yield* post("tools/list")), ["Deploy", "Confirm"])
      assert.deepStrictEqual(toolNames(yield* post("tools/list")), ["Deploy", "Confirm"])
      assert.strictEqual(source.counts.lists, 2)
      assert.strictEqual(resultText(yield* post("tools/call", { name: "Deploy", arguments: {} })), "remote:Deploy:{}")

      const paused = yield* post("tools/call", { name: "Confirm", arguments: {} })
      assert.deepInclude(paused.result, { resultType: "input_required", requestState: "pending" })
      const resumed = yield* post("tools/call", {
        name: "Confirm",
        arguments: {},
        inputResponses: { confirm: { action: "accept", content: {} } },
        requestState: "pending"
      })
      assert.strictEqual(resultText(resumed), "confirmed")
    }))
  describe("per caller", () => {
    // The caller comes from a header, as authentication middleware would provide it.
    const Caller = McpServer.middleware<{ provides: CurrentUser }>()((effect, { headers }) =>
      Effect.provideService(effect, CurrentUser, String(headers["x-caller"] ?? "anonymous"))
    )
    const perCaller = Layer.effectDiscard(
      Effect.gen(function*() {
        const server = yield* McpServer.McpServer
        yield* server.addToolSource({
          list: Effect.gen(function*() {
            const caller = yield* CurrentUser
            // The first caller's list finishes last, so the two lists overlap.
            yield* Effect.sleep(caller === "alice" ? "40 millis" : "5 millis")
            return [descriptor(`${caller}_tool`)]
          }) as never,
          call: (name) => Effect.map(CurrentUser, (caller) => text(`${caller} called ${name}`)) as never,
          services: yield* Effect.context<never>()
        })
      }).pipe(Effect.provide(Caller.layer))
    )

    it.live("lists and calls for each of two concurrent callers on layerHttpRequestScoped", () =>
      Effect.gen(function*() {
        const protocol = McpProtocol.v2026_07_28
        const harness = yield* makeHttpHarness(
          perCaller.pipe(
            Layer.provideMerge(makeServerLayer({ name: "PerCaller", protocols: [protocol], mode: "request" }))
          )
        )
        const post = (caller: string, method: string, params: Record<string, unknown> = {}) =>
          harness.post({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": protocol.protocolVersion,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" }
              }
            }
          }, {
            "MCP-Protocol-Version": protocol.protocolVersion,
            "Mcp-Method": method,
            ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
            "x-caller": caller
          }).pipe(Effect.flatMap(readMcpHttpResponse), Effect.map((message) => message as JsonRpcMessage))
        const [alice, bob] = yield* Effect.all([post("alice", "tools/list"), post("bob", "tools/list")], {
          concurrency: "unbounded"
        })
        assert.deepStrictEqual([toolNames(alice), toolNames(bob)], [["alice_tool"], ["bob_tool"]])
        const [aliceCall, bobCall] = yield* Effect.all([
          post("alice", "tools/call", { name: "alice_tool", arguments: {} }),
          post("bob", "tools/call", { name: "bob_tool", arguments: {} })
        ], { concurrency: "unbounded" })
        assert.deepStrictEqual([resultText(aliceCall), resultText(bobCall)], [
          "alice called alice_tool",
          "bob called bob_tool"
        ])
      }))

    it.live("lists and calls for each caller's session on layerHttp", () =>
      Effect.gen(function*() {
        const protocol = McpProtocol.v2025_11_25
        const harness = yield* makeHttpHarness(
          perCaller.pipe(Layer.provideMerge(makeServerLayer({ name: "PerCallerSessions", protocols: [protocol] })))
        )
        const session = Effect.fnUntraced(function*(caller: string) {
          const headers = { ...(yield* initializeHttpSession(harness, protocol)), "x-caller": caller }
          return (method: string, params: Record<string, unknown> = {}) =>
            harness.post({ jsonrpc: "2.0", id: 2, method, params }, headers).pipe(
              Effect.flatMap(readMcpHttpResponse),
              Effect.map((message) => message as JsonRpcMessage)
            )
        })
        const alice = yield* session("alice")
        const bob = yield* session("bob")
        const [aliceList, bobList] = yield* Effect.all([alice("tools/list"), bob("tools/list")], {
          concurrency: "unbounded"
        })
        assert.deepStrictEqual([toolNames(aliceList), toolNames(bobList)], [["alice_tool"], ["bob_tool"]])
        assert.strictEqual(
          resultText(yield* bob("tools/call", { name: "bob_tool", arguments: {} })),
          "bob called bob_tool"
        )
      }))
  })
})
