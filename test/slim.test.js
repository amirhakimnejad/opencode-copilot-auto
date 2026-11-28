import assert from "node:assert/strict"
import { test } from "node:test"
import { createPlugin, slimBody } from "../index.js"

const KB = 1024
const photo = (kb, tag = "x") => "data:image/jpeg;base64," + tag.repeat(kb * KB)
const user = (text, ...images) => ({
  type: "message", role: "user",
  content: [{ type: "input_text", text }, ...images.map((image_url) => ({ type: "input_image", image_url }))],
})
const assistant = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] })
const developer = { type: "message", role: "developer", content: "system prompt" }
const images = (item) => (Array.isArray(item.content) ? item.content : []).filter((p) => p.type === "input_image").length
const size = (body) => Buffer.byteLength(JSON.stringify(body))

test("swaps earlier photos for a note, oldest first, until under the limit", () => {
  const body = {
    input: [developer, user("receipts", photo(200, "a"), photo(200, "b")), assistant("ok"), user("more", photo(200, "c")), assistant("ok"), user("check Ali")],
  }
  const stats = slimBody(body, { limitBytes: 250 * KB })
  assert.equal(stats.attachments, 2)
  assert.equal(images(body.input[1]), 0) // oldest two went
  assert.equal(images(body.input[3]), 1) // removing those was enough to keep the third
  assert.match(body.input[1].content[1].text, /removed from this request/)
  assert.equal(body.input[1].content[1].type, "input_text")
  assert.ok(size(body) <= 250 * KB)
})

test("never touches photos in the latest message", () => {
  const body = { input: [developer, user("old", photo(100)), assistant("ok"), user("new", photo(600))] }
  const stats = slimBody(body, { limitBytes: 100 * KB })
  assert.equal(stats.attachments, 1)
  assert.equal(images(body.input[3]), 1)
})

test("leaves a request under the limit as it is", () => {
  const body = { input: [developer, user("old", photo(50)), assistant("ok"), user("new")] }
  const before = JSON.stringify(body)
  assert.equal(slimBody(body, { limitBytes: 400 * KB }).attachments, 0)
  assert.equal(JSON.stringify(body), before)
})

test("the current turn's tool calls keep their attachments too", () => {
  const output = { type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: photo(300) }] }
  const body = { input: [developer, user("read the screenshot"), { type: "function_call", call_id: "c1", name: "read", arguments: "{}" }, output] }
  assert.equal(slimBody(body, { limitBytes: 10 * KB }).attachments, 0)
  assert.equal(output.output[0].type, "input_image")
})

test("earlier tool outputs and files are trimmed as well", () => {
  const output = { type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: photo(300) }] }
  const file = { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64," + "p".repeat(300 * KB) }
  const body = { input: [developer, { type: "message", role: "user", content: [file] }, output, assistant("ok"), user("next")] }
  assert.equal(slimBody(body, { limitBytes: 10 * KB }).attachments, 2)
  assert.equal(output.output[0].type, "input_text")
})

test("dropAllAttachments removes every earlier one, even under the limit", () => {
  const body = { input: [developer, user("a", photo(10)), assistant("ok"), user("b", photo(10)), assistant("ok"), user("c")] }
  assert.equal(slimBody(body, { limitBytes: 400 * KB, dropAllAttachments: true }).attachments, 2)
})

test("works on Chat Completions bodies", () => {
  const body = {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: photo(300) } }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "next" },
    ],
  }
  assert.equal(slimBody(body, { limitBytes: 10 * KB }).attachments, 1)
  assert.deepEqual(body.messages[1].content[1].type, "text")
})

test("web links to photos are left alone", () => {
  const body = { input: [developer, user("a", "https://example.com/a.jpg"), assistant("ok"), user("b")] }
  assert.equal(slimBody(body, { limitBytes: 0 }).attachments, 0)
})

test("a body with no messages, or only one turn, is left alone", () => {
  assert.equal(slimBody({}, { limitBytes: 0 }).attachments, 0)
  assert.equal(slimBody({ input: [user("only", photo(10))] }, { limitBytes: 0 }).attachments, 0)
})

// ---------- the hooks ----------

async function setupHooks(options = {}) {
  const hooks = {}
  const lines = []
  const plugin = createPlugin({ mode: "off", log: (l) => lines.push(l), ...options })
  await plugin.setup({ session: { hook: async (name, fn) => { hooks[name] = fn } } })
  return { hooks, lines }
}

const post = (body, contentType = "application/json") =>
  new Request("https://api.individual.githubcopilot.com/responses", {
    method: "POST",
    headers: { "content-type": contentType, authorization: "Bearer x", "content-length": "1" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

test("the request hook sends a smaller body and keeps the headers", async () => {
  const { hooks, lines } = await setupHooks({ slimKb: 100 })
  const call = { sessionID: "s1", request: post({ model: "m", input: [developer, user("a", photo(300)), assistant("ok"), user("b")] }) }
  await hooks["http.request"](call)
  const sent = JSON.parse(await call.request.text())
  assert.equal(images(sent.input[1]), 0)
  assert.equal(sent.model, "m")
  assert.equal(call.request.headers.get("authorization"), "Bearer x")
  assert.equal(call.request.headers.get("content-length"), null)
  assert.match(lines.at(-1), /KB -> \d+ KB \(removed 1 earlier attachments\)/)
})

test("small, non-JSON and GET requests go out untouched", async () => {
  const { hooks } = await setupHooks()
  for (const request of [post({ input: [developer, user("a"), assistant("ok"), user("b")] }), post("not json", "text/plain"),
    new Request("https://api.individual.githubcopilot.com/models")]) {
    const call = { sessionID: "s1", request }
    await hooks["http.request"](call)
    assert.equal(call.request, request)
  }
})

test("OPENCODE_COPILOT_SLIM=off registers no request hooks", async () => {
  const { hooks } = await setupHooks({ slim: "off" })
  assert.deepEqual(Object.keys(hooks), [])
})

const bodyTimeout = () => ({ message: "Timed out reading request body. Try again, or use a smaller request size." })

test("a body timeout retries once with every earlier attachment removed, then stops", async () => {
  const { hooks } = await setupHooks()
  const body = { input: [developer, user("a", photo(20)), assistant("ok"), user("b")] }
  await hooks["http.request"]({ sessionID: "s1", request: post(body) }) // small: sent as is

  const first = { sessionID: "s1", error: bodyTimeout(), decision: { retry: true, delay: 1000 } }
  await hooks["retry"](first)
  assert.deepEqual(first.decision, { retry: true, delay: 1000 })

  const retried = { sessionID: "s1", request: post(body) }
  await hooks["http.request"](retried)
  assert.equal(images(JSON.parse(await retried.request.text()).input[1]), 0)

  const second = { sessionID: "s1", error: bodyTimeout(), decision: { retry: true, delay: 2000 } }
  await hooks["retry"](second)
  assert.deepEqual(second.decision, { retry: false })
})

test("a body timeout with nothing earlier to remove stops at once", async () => {
  const { hooks, lines } = await setupHooks({ slimKb: 100 })
  const body = { input: [developer, user("five photos", photo(300), photo(300))] }
  await hooks["http.request"]({ sessionID: "s1", request: post(body) })
  const call = { sessionID: "s1", error: bodyTimeout(), decision: { retry: true, delay: 1000 } }
  await hooks["retry"](call)
  assert.deepEqual(call.decision, { retry: false })
  assert.match(lines.at(-1), /not retrying/)
})

test("after a body timeout the chat keeps leaving out earlier attachments, even small ones", async () => {
  const { hooks } = await setupHooks()
  const body = { input: [developer, user("a", photo(5)), assistant("ok"), user("b")] }
  await hooks["http.request"]({ sessionID: "s1", request: post(body) })
  await hooks["retry"]({ sessionID: "s1", error: bodyTimeout(), decision: { retry: true } })
  await hooks["http.response"]({ sessionID: "s1", response: new Response("{}", { status: 200 }) })
  const later = { sessionID: "s1", request: post(body) }
  await hooks["http.request"](later)
  assert.equal(images(JSON.parse(await later.request.text()).input[1]), 0)
  const other = { sessionID: "s2", request: post(body) } // other chats are unaffected
  await hooks["http.request"](other)
  assert.equal(images(JSON.parse(await other.request.text()).input[1]), 1)
})

test("a request that gets through resets the timeout count", async () => {
  const { hooks } = await setupHooks()
  await hooks["retry"]({ sessionID: "s1", error: bodyTimeout(), decision: { retry: true } })
  await hooks["http.response"]({ sessionID: "s1", response: new Response("{}", { status: 200 }) })
  const next = { sessionID: "s1", error: bodyTimeout(), decision: { retry: true } }
  await hooks["retry"](next)
  assert.deepEqual(next.decision, { retry: true })
})

test("other errors are left to OpenCode", async () => {
  const { hooks } = await setupHooks()
  for (let i = 0; i < 3; i++) {
    const call = { sessionID: "s1", error: { message: "rate limited", status: 429 }, decision: { retry: true, delay: 5 } }
    await hooks["retry"](call)
    assert.deepEqual(call.decision, { retry: true, delay: 5 })
  }
})

test("the timeout text is also found in the response body", async () => {
  const { hooks } = await setupHooks()
  const error = () => ({ message: "Bad request", response: { body: '{"error":"Timed out reading request body"}' } })
  await hooks["retry"]({ sessionID: "s1", error: error(), decision: { retry: true } })
  const second = { sessionID: "s1", error: error(), decision: { retry: true } }
  await hooks["retry"](second)
  assert.deepEqual(second.decision, { retry: false })
})
