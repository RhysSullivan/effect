import { assert, describe, it } from "@effect/vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpServer from "effect/ai/McpServer"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { makeHttpHarness } from "./TestUtils/McpHttpHarness.ts"
import { readMcpHttpResponse } from "./TestUtils/McpHttpResponse.ts"
import type { JsonRpcMessage } from "./TestUtils/McpStdioHarness.ts"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { message: Schema.String, id: Schema.String }) {}

class Upstream extends Schema.TaggedError<Upstream>()("Upstream", { message: Schema.String, cause: Schema.Defect() }) {}

class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", { retryAfter: Schema.Number }) {}
class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()("QuotaExceeded", {
  message: Schema.String,
  limit: Schema.Number,
  plan: Schema.String,
  resetAt: Schema.DateTimeUtcFromString
}) {}

// Shapes whose fields must not reach `_meta`.
class WithRedacted extends Schema.TaggedError<WithRedacted>()("WithRedacted", {
  message: Schema.String,
  token: Schema.Redacted(Schema.String),
  attempt: Schema.Number
}) {}
class WithDefect extends Schema.TaggedError<WithDefect>()("WithDefect", {
  message: Schema.String,
  inner: Schema.Defect(),
  note: Schema.Defect()
}) {}
class NestedCause extends Schema.TaggedError<NestedCause>()("NestedCause", {
  message: Schema.String,
  info: Schema.Struct({ cause: Schema.Defect() })
}) {}
class WithUnknown extends Schema.TaggedError<WithUnknown>()("WithUnknown", {
  message: Schema.String,
  upstream: Schema.Unknown,
  label: Schema.Unknown
}) {}
class CauseUnknown extends Schema.TaggedError<CauseUnknown>()("CauseUnknown", {
  message: Schema.String,
  cause: Schema.Unknown
}) {}
class BadEncode extends Schema.TaggedError<BadEncode>()("BadEncode", {
  message: Schema.String,
  when: Schema.DateTimeUtcFromString
}) {}
class Huge extends Schema.TaggedError<Huge>()("Huge", {
  message: Schema.String,
  blob: Schema.String,
  big: Schema.String,
  size: Schema.Number
}) {}
// An error field whose schema writes it as its message: a string, so only its
// value tells it apart.
const ErrorAsMessage = Schema.String.pipe(
  Schema.decodeTo(
    Schema.instanceOf(Error),
    SchemaTransformation.transform({
      decode: (message: string) => new Error(message),
      encode: (error) => error.message
    })
  )
)
class WithErrorField extends Schema.TaggedError<WithErrorField>()("WithErrorField", {
  message: Schema.String,
  upstream: ErrorAsMessage
}) {}
class Wide extends Schema.TaggedError<Wide>()("Wide", {
  message: Schema.String,
  a: Schema.String,
  b: Schema.String,
  c: Schema.String,
  d: Schema.String,
  e: Schema.String
}) {}

// Each tool has an output schema, as every toolkit tool does, so a client that checks
// `structuredContent` against it would reject a failure placed there.
const Issue = Schema.Struct({ id: Schema.String, title: Schema.String })
const Tools = Toolkit.make(
  Tool.make("get_issue", {
    parameters: Schema.Struct({ id: Schema.String }),
    success: Issue,
    failure: Schema.Union([NotFound, RateLimited, Upstream, QuotaExceeded])
  }),
  Tool.make("get_issue_returned", {
    parameters: Schema.Struct({ id: Schema.String }),
    success: Issue,
    failure: NotFound,
    failureMode: "return"
  }),
  Tool.make("crash", { parameters: Schema.Struct({ id: Schema.String }), success: Issue })
)

const layer = McpServer.toolkit(Tools).pipe(Layer.provide(Tools.toLayer({
  get_issue: ({ id }) =>
    id === "busy"
      ? Effect.fail(new RateLimited({ retryAfter: 5 }))
      : id === "down"
      ? Effect.fail(new Upstream({ message: "Upstream failed", cause: new Error("token=inner-secret") }))
      : id === "quota"
      ? Effect.fail(
        new QuotaExceeded({
          message: "Quota exceeded",
          limit: 100,
          plan: "team",
          resetAt: DateTime.makeUnsafe("2026-12-01T00:00:00Z")
        })
      )
      : Effect.fail(new NotFound({ message: `No issue ${id}`, id })),
  get_issue_returned: ({ id }) => Effect.fail(new NotFound({ message: `No issue ${id}`, id })),
  crash: () => Effect.die("boom")
})))

const failureOf = (result: { readonly _meta?: Record<string, unknown> | undefined }) =>
  result._meta?.[McpServer.FailureMeta]

describe("McpServer toolkit failures", () => {
  // The MCP TypeScript SDK client checks `structuredContent` against the tool's output schema
  // whenever it is present, also on `isError` results.
  for (const protocol of [McpProtocol.v2025_06_18, McpProtocol.v2025_11_25]) {
    it.live(`reaches the MCP TypeScript SDK client as a tool error with its tag on ${protocol.protocolVersion}`, () =>
      Effect.gen(function*() {
        const { dispose, handler } = HttpRouter.toWebHandler(
          layer.pipe(Layer.provideMerge(McpServer.layerHttp({
            name: "failures",
            version: "1.0.0",
            path: "/mcp",
            protocols: [protocol]
          }))),
          { disableLogger: true }
        )
        yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
        const client = new Client({ name: "sdk", version: "1.0.0" })
        yield* Effect.promise(() =>
          client.connect(
            new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
              fetch: (input, init) => handler(new Request(input, init))
            })
          )
        )
        yield* Effect.addFinalizer(() => Effect.promise(() => client.close()))
        const { tools } = yield* Effect.promise(() => client.listTools())
        assert.isDefined(tools.find((tool) => tool.name === "get_issue")?.outputSchema)

        const call = (name: string, id: string) => Effect.promise(() => client.callTool({ name, arguments: { id } }))

        const missing = yield* call("get_issue", "ISS-9")
        assert.isTrue(missing.isError)
        assert.isUndefined(missing.structuredContent)
        assert.deepStrictEqual(missing.content, [{ type: "text", text: "No issue ISS-9" }])
        // A failure sent by its message carries its declared fields as its schema encodes them.
        assert.deepStrictEqual(failureOf(missing), { _tag: "NotFound", message: "No issue ISS-9", id: "ISS-9" })
        const quota = yield* call("get_issue", "quota")
        assert.deepStrictEqual(quota.content, [{ type: "text", text: "Quota exceeded" }])
        assert.deepStrictEqual(failureOf(quota), {
          _tag: "QuotaExceeded",
          message: "Quota exceeded",
          limit: 100,
          plan: "team",
          resetAt: "2026-12-01T00:00:00.000Z"
        })

        const busy = yield* call("get_issue", "busy")
        assert.deepStrictEqual(failureOf(busy), { _tag: "RateLimited", retryAfter: 5 })

        // Except `cause`: an inner failure's message is not the failure's own.
        const down = yield* call("get_issue", "down")
        assert.deepStrictEqual(failureOf(down), { _tag: "Upstream", message: "Upstream failed" })
        assert.notInclude(JSON.stringify(down), "inner-secret")

        const returned = yield* call("get_issue_returned", "ISS-9")
        assert.isTrue(returned.isError)
        assert.deepStrictEqual(failureOf(returned), { _tag: "NotFound", message: "No issue ISS-9", id: "ISS-9" })

        const crashed = yield* call("crash", "ISS-9")
        assert.isTrue(crashed.isError)
        assert.isUndefined(failureOf(crashed))
      }))
  }

  it.live("carries the failure in _meta beside the server's own on 2026-07-28", () =>
    Effect.gen(function*() {
      const protocol = McpProtocol.v2026_07_28
      const harness = yield* makeHttpHarness(
        layer.pipe(Layer.provideMerge(McpServer.layerHttpRequestScoped({
          name: "failures",
          version: "1.0.0",
          path: "/mcp",
          protocols: [protocol]
        })))
      )
      const response = yield* harness.post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_issue",
          arguments: { id: "ISS-9" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": protocol.protocolVersion,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" }
          }
        }
      }, { "MCP-Protocol-Version": protocol.protocolVersion, "Mcp-Method": "tools/call", "Mcp-Name": "get_issue" })
      const result = ((yield* readMcpHttpResponse(response)) as JsonRpcMessage).result as Record<string, any>
      assert.isTrue(result.isError)
      assert.isUndefined(result.structuredContent)
      assert.deepStrictEqual(failureOf(result), { _tag: "NotFound", message: "No issue ISS-9", id: "ISS-9" })
      assert.isDefined(result._meta["io.modelcontextprotocol/serverInfo"])
    }))
})

const secretError = () =>
  Object.assign(new Error("token=inner-secret"), { headers: { authorization: "Bearer secret" } })
const Shapes = Toolkit.make(
  Tool.make("shape", {
    parameters: Schema.Struct({ id: Schema.String }),
    success: Schema.String,
    failure: Schema.Union([
      WithRedacted,
      WithDefect,
      NestedCause,
      WithUnknown,
      CauseUnknown,
      BadEncode,
      Huge,
      Wide,
      WithErrorField
    ])
  }),
  // A tool whose failure schema declares nothing about its fields.
  Tool.make("loose", {
    parameters: Schema.Struct({ id: Schema.String }),
    success: Schema.String,
    failure: Schema.Unknown
  })
)
const shapesLayer = McpServer.toolkit(Shapes).pipe(Layer.provide(Shapes.toLayer({
  shape: ({ id }) => {
    switch (id) {
      case "redacted":
        return Effect.fail(new WithRedacted({ message: "m", token: Redacted.make("redacted-secret"), attempt: 2 }))
      case "defect":
        return Effect.fail(new WithDefect({ message: "m", inner: secretError(), note: "defect-secret" }))
      case "nested":
        return Effect.fail(new NestedCause({ message: "m", info: { cause: secretError() } }))
      case "unknown":
        return Effect.fail(
          new WithUnknown({
            message: "m",
            upstream: { authorization: "Bearer obj-secret", nested: { cause: "c-secret" } },
            label: "unknown-secret"
          })
        )
      case "cause-unknown":
        return Effect.fail(new CauseUnknown({ message: "visible message", cause: secretError() }))
      case "bad-encode": {
        // A DateTime that passes `Schema.is` but cannot be written as a string.
        const valid = DateTime.makeUnsafe(0)
        const when = Object.assign(Object.create(Object.getPrototypeOf(valid)), valid, { epochMilliseconds: NaN })
        return Effect.fail(new BadEncode({ message: "visible message", when }))
      }
      case "error-field":
        return Effect.fail(new WithErrorField({ message: "m", upstream: new Error("token=inner-secret") }))
      case "huge":
        return Effect.fail(
          new Huge({ message: "x".repeat(5000), blob: "y".repeat(2_000_000), big: "z".repeat(1500), size: 7 })
        )
      default:
        return Effect.fail(
          new Wide({
            message: "m",
            a: "a".repeat(1000),
            b: "b".repeat(1000),
            c: "c".repeat(1000),
            d: "d".repeat(1000),
            e: "e".repeat(1000)
          })
        )
    }
  },
  loose: () => Effect.fail(new Error("loose message"))
})))

describe("McpServer toolkit failure _meta", () => {
  it.live("carries only a failure's tag, message and declared scalar fields", () =>
    Effect.gen(function*() {
      const { dispose, handler } = HttpRouter.toWebHandler(
        shapesLayer.pipe(Layer.provideMerge(McpServer.layerHttp({
          name: "failures",
          version: "1.0.0",
          path: "/mcp",
          protocols: [McpProtocol.v2025_11_25]
        }))),
        { disableLogger: true }
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
      const client = new Client({ name: "sdk", version: "1.0.0" })
      yield* Effect.promise(() =>
        client.connect(
          new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
            fetch: (input, init) => handler(new Request(input, init))
          })
        )
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => client.close()))
      const call = (name: string, id: string) => Effect.promise(() => client.callTool({ name, arguments: { id } }))
      const noSecrets = (result: unknown) => {
        for (
          const secret of [
            "redacted-secret",
            "inner-secret",
            "obj-secret",
            "c-secret",
            "defect-secret",
            "unknown-secret"
          ]
        ) {
          assert.notInclude(JSON.stringify(result), secret)
        }
      }

      // A redacted field is left out; a scalar beside it is kept.
      const redacted = yield* call("shape", "redacted")
      assert.deepStrictEqual(failureOf(redacted), { _tag: "WithRedacted", message: "m", attempt: 2 })
      noSecrets(redacted)
      // A defect under any name, even one holding a string, is left out.
      const defect = yield* call("shape", "defect")
      assert.deepStrictEqual(failureOf(defect), { _tag: "WithDefect", message: "m" })
      noSecrets(defect)
      // Nothing nested: a struct holding a cause is left out.
      const nested = yield* call("shape", "nested")
      assert.deepStrictEqual(failureOf(nested), { _tag: "NestedCause", message: "m" })
      noSecrets(nested)
      // An error field is left out, even one its schema writes as a string.
      const errorField = yield* call("shape", "error-field")
      assert.deepStrictEqual(failureOf(errorField), { _tag: "WithErrorField", message: "m" })
      noSecrets(errorField)
      // `Schema.Unknown` fields are left out, an object or a string.
      const unknown = yield* call("shape", "unknown")
      assert.deepStrictEqual(failureOf(unknown), { _tag: "WithUnknown", message: "m" })
      noSecrets(unknown)

      // A failure that does not encode keeps its message, as text and in `_meta`.
      for (const id of ["cause-unknown", "bad-encode"]) {
        const failed = yield* call("shape", id)
        assert.isTrue(failed.isError)
        assert.deepStrictEqual(failed.content, [{ type: "text", text: "visible message" }], id)
        assert.deepStrictEqual(failureOf(failed), {
          _tag: id === "bad-encode" ? "BadEncode" : "CauseUnknown",
          message: "visible message"
        })
        noSecrets(failed)
      }
      const loose = yield* call("loose", "x")
      assert.deepStrictEqual(loose.content, [{ type: "text", text: "loose message" }])
      assert.isUndefined(failureOf(loose))

      // Bounded: each string at most 1,024 characters, the whole value at most 4,096 bytes.
      const huge = yield* call("shape", "huge")
      assert.deepStrictEqual(failureOf(huge), { _tag: "Huge", message: "x".repeat(1024), size: 7 })
      const wide = yield* call("shape", "wide")
      const meta = failureOf(wide) as Record<string, unknown>
      assert.isAtMost(JSON.stringify(meta).length, 4096)
      assert.deepStrictEqual(Object.keys(meta), ["_tag", "message", "a", "b", "c", "d"])
    }))
})
