import assert from "node:assert/strict"
import { test } from "node:test"
import { createPlugin } from "../index.js"

const FREE_USER = { access_type_sku: "free_limited_copilot", copilot_plan: "individual", endpoints: { api: "https://api.individual.githubcopilot.com" } }
const PAID_USER = { access_type_sku: "monthly_subscriber", copilot_plan: "individual", endpoints: { api: "https://api.individual.githubcopilot.com" } }
const MODELS = {
  data: [
    { id: "mai-code-2-flash", policy: { state: "enabled" }, capabilities: { type: "chat", supports: { tool_calls: true } } },
    { id: "gpt-6-luna", policy: { state: "enabled" }, capabilities: { type: "chat", supports: { tool_calls: true } } },
    { id: "claude-opus-5.5", policy: { state: "disabled" }, capabilities: { type: "chat", supports: { tool_calls: true } } },
    { id: "gpt-4o", capabilities: { type: "chat", supports: { tool_calls: true } } },
    { id: "text-embedding-3-small", policy: { state: "enabled" }, capabilities: { type: "embeddings", supports: {} } },
  ],
}

const PAID_MODELS = { data: MODELS.data.map((m) => ({ ...m, model_picker_enabled: true, billing: { auto_discount: 0.1 } })) }

function setup({ user = FREE_USER, models, auto, credential = { token: "gho_test", metadata: {} }, mode, fail = {} } = {}) {
  models ??= user === PAID_USER ? PAID_MODELS : MODELS
  let clock = 1_800_000_000_000
  const calls = []
  let autoCount = 0
  const fetch = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ url, path, init })
    if (fail[path]) return { ok: false, status: fail[path], json: async () => ({}) }
    if (path === "/copilot_internal/user") return { ok: true, json: async () => user }
    if (path === "/models") return { ok: true, json: async () => models }
    if (path === "/auto") {
      autoCount++
      const answer = auto ? auto(autoCount) : { selected_model: { id: "mai-code-2-flash" }, session_token: "auto-token-" + autoCount, expires_at: clock / 1000 + 3600 }
      return { ok: true, json: async () => answer }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const plugin = createPlugin({ fetch, readCredential: async () => credential, now: () => clock, mode })
  const hooks = {}
  let transform
  let reloads = 0
  const ctx = {
    session: {
      hook: async (name, fn, options) => { hooks[name] = { fn, options } },
      context: async () => [{ type: "user", text: "fix the failing test" }],
    },
    model: { transform: async (fn) => { transform = fn }, reload: async () => { reloads++ } },
  }
  return {
    plugin, ctx, hooks, calls,
    get transform() { return transform },
    advance: (ms) => { clock += ms },
    autoCount: () => autoCount,
    reloads: () => reloads,
    async resolve(id, sessionID = "s1", kind = "primary") {
      const call = { sessionID, kind, model: { providerID: "github-copilot", id } }
      await hooks["experimental.model.resolve"].fn(call)
      return call
    },
    request(id, sessionID = "s1", kind = "primary") {
      const call = { sessionID, kind, model: { providerID: "github-copilot", id }, headers: {} }
      hooks["model.request"].fn(call)
      return call
    },
  }
}

function fakeModels(ids) {
  const state = new Map(ids.map((id) => [id, { id, enabled: false }]))
  return {
    state,
    get: (provider, id) => (provider === "github-copilot" ? state.get(id) : undefined),
    update: (provider, id, fn) => fn(state.get(id)),
  }
}

test("free account: routes an allowed model through Auto and sends the session token", async () => {
  const t = setup()
  await t.plugin.setup(t.ctx)
  const call = await t.resolve("gpt-6-luna")
  assert.deepEqual(call.model, { providerID: "github-copilot", id: "mai-code-2-flash" })
  assert.equal(t.request("mai-code-2-flash").headers["Copilot-Session-Token"], "auto-token-1")
  const autoCall = t.calls.find((c) => c.path === "/auto")
  assert.deepEqual(JSON.parse(autoCall.init.body), { prompt: "fix the failing test" })
  assert.equal(autoCall.init.headers.Authorization, "Bearer gho_test")
})

test("only enabled chat models with tool calls count as allowed", async () => {
  const t = setup()
  await t.plugin.setup(t.ctx)
  await t.resolve("mai-code-2-flash")
  for (const id of ["claude-opus-5.5", "gpt-4o", "text-embedding-3-small"]) {
    const call = await t.resolve(id, "other-" + id)
    assert.equal(call.model.id, id, id + " should be left alone")
  }
})

test("unhides the allowed models in the picker, and only those", async () => {
  const t = setup()
  await t.plugin.setup(t.ctx)
  await t.resolve("mai-code-2-flash") // account loaded
  const models = fakeModels(["mai-code-2-flash", "gpt-6-luna", "claude-opus-5.5"])
  t.transform(models)
  assert.equal(models.state.get("mai-code-2-flash").enabled, true)
  assert.equal(models.state.get("gpt-6-luna").enabled, true)
  assert.equal(models.state.get("claude-opus-5.5").enabled, false)
})

test("reuses Auto's pick within a session and asks once for parallel calls", async () => {
  const t = setup()
  await t.plugin.setup(t.ctx)
  await Promise.all([t.resolve("mai-code-2-flash"), t.resolve("mai-code-2-flash"), t.resolve("gpt-6-luna")])
  await t.resolve("mai-code-2-flash")
  assert.equal(t.autoCount(), 1)
  await t.resolve("mai-code-2-flash", "s2")
  assert.equal(t.autoCount(), 2)
})

test("asks Auto again shortly before the session token expires", async () => {
  const t = setup()
  await t.plugin.setup(t.ctx)
  await t.resolve("mai-code-2-flash")
  t.advance(54 * 60 * 1000)
  await t.resolve("mai-code-2-flash")
  assert.equal(t.autoCount(), 1)
  t.advance(2 * 60 * 1000) // 56 min: inside the 5-minute renewal window
  await t.resolve("mai-code-2-flash")
  assert.equal(t.autoCount(), 2)
  assert.equal(t.request("mai-code-2-flash").headers["Copilot-Session-Token"], "auto-token-2")
})

test("a missing or bad expiry still expires the pick", async () => {
  const t = setup({ auto: (n) => ({ selected_model: { id: "mai-code-2-flash" }, session_token: "tok" + n, expires_at: "soon" }) })
  await t.plugin.setup(t.ctx)
  await t.resolve("mai-code-2-flash")
  t.advance(21 * 60 * 1000)
  await t.resolve("mai-code-2-flash")
  assert.equal(t.autoCount(), 2)
})

test("no session token once the pick has expired", async () => {
  const t = setup()
  await t.plugin.setup(t.ctx)
  await t.resolve("mai-code-2-flash")
  t.advance(2 * 60 * 60 * 1000)
  assert.equal(t.request("mai-code-2-flash").headers["Copilot-Session-Token"], undefined)
})

test("an account OpenCode can serve itself is left alone", async () => {
  const t = setup({ user: PAID_USER })
  await t.plugin.setup(t.ctx)
  const call = await t.resolve("gpt-6-luna")
  assert.equal(call.model.id, "gpt-6-luna")
  assert.equal(t.autoCount(), 0)
})

test("an account with only an Auto discount is left alone too", async () => {
  const models = { data: MODELS.data.map((m) => ({ ...m, billing: { auto_discount: 0.1 } })) }
  const t = setup({ models })
  await t.plugin.setup(t.ctx)
  assert.equal((await t.resolve("gpt-6-luna")).model.id, "gpt-6-luna")
})

test("detection doesn't depend on GitHub's plan name", async () => {
  const t = setup({ user: { access_type_sku: "some_future_plan_name", endpoints: FREE_USER.endpoints } })
  await t.plugin.setup(t.ctx)
  assert.equal((await t.resolve("gpt-6-luna")).model.id, "mai-code-2-flash")
})

test("OPENCODE_COPILOT_AUTO=always routes on a paid plan too", async () => {
  const t = setup({ user: PAID_USER, mode: "always" })
  await t.plugin.setup(t.ctx)
  assert.equal((await t.resolve("gpt-6-luna")).model.id, "mai-code-2-flash")
})

test("OPENCODE_COPILOT_AUTO=off registers nothing", async () => {
  const t = setup({ mode: "off" })
  await t.plugin.setup(t.ctx)
  assert.deepEqual(Object.keys(t.hooks), [])
  assert.equal(t.calls.length, 0)
})

test("title requests are left alone", async () => {
  const t = setup()
  await t.plugin.setup(t.ctx)
  assert.equal((await t.resolve("gpt-6-luna", "s1", "title")).model.id, "gpt-6-luna")
  assert.equal(t.autoCount(), 0)
})

test("other providers are left alone", async () => {
  const t = setup()
  await t.plugin.setup(t.ctx)
  const call = { sessionID: "s1", kind: "primary", model: { providerID: "ollama", id: "mai-code-2-flash" } }
  await t.hooks["experimental.model.resolve"].fn(call)
  assert.equal(call.model.providerID, "ollama")
  assert.equal(t.autoCount(), 0)
})

test("no Copilot login: does nothing", async () => {
  const t = setup({ credential: null })
  await t.plugin.setup(t.ctx)
  assert.equal((await t.resolve("gpt-6-luna")).model.id, "gpt-6-luna")
  assert.equal(t.calls.length, 0)
})

test("a failed account check does nothing and is retried a minute later", async () => {
  const t = setup({ fail: { "/copilot_internal/user": 503 } })
  await t.plugin.setup(t.ctx)
  assert.equal((await t.resolve("gpt-6-luna")).model.id, "gpt-6-luna")
  const checks = () => t.calls.filter((c) => c.path === "/copilot_internal/user").length
  await t.resolve("gpt-6-luna")
  assert.equal(checks(), 1)
  t.advance(61 * 1000)
  await t.resolve("gpt-6-luna")
  assert.equal(checks(), 2)
})

test("an Auto failure gives a clear error and is retried on the next call", async () => {
  const t = setup({ fail: { "/auto": 500 } })
  await t.plugin.setup(t.ctx)
  await assert.rejects(t.resolve("gpt-6-luna"), /copilot-auto: Copilot Auto failed \(\/auto answered HTTP 500\)/)
  await assert.rejects(t.resolve("gpt-6-luna"))
  assert.equal(t.calls.filter((c) => c.path === "/auto").length, 2)
})

test("an Auto answer without a model gives a clear error", async () => {
  const t = setup({ auto: () => ({ selected_model: null }) })
  await t.plugin.setup(t.ctx)
  await assert.rejects(t.resolve("gpt-6-luna"), /returned no model/)
})

test("compaction makes the session ask Auto again", async () => {
  const t = setup()
  await t.plugin.setup(t.ctx)
  await t.resolve("mai-code-2-flash")
  t.hooks.compaction.fn({ sessionID: "s1" })
  await t.resolve("mai-code-2-flash")
  assert.equal(t.autoCount(), 2)
})

test("a new Copilot login is noticed within 30 seconds and drops the old pick", async () => {
  const credential = { token: "gho_one", metadata: {} }
  const t = setup({ credential })
  await t.plugin.setup(t.ctx)
  await t.resolve("mai-code-2-flash")
  credential.token = "gho_two"
  t.advance(31 * 1000)
  await t.resolve("mai-code-2-flash")
  assert.equal(t.autoCount(), 2)
  const last = t.calls.filter((c) => c.path === "/auto").at(-1)
  assert.equal(last.init.headers.Authorization, "Bearer gho_two")
})

test("GitHub Enterprise logins use the enterprise API host", async () => {
  const t = setup({ credential: { token: "ghu_ent", metadata: { enterpriseUrl: "https://acme.ghe.com/" } }, user: { ...FREE_USER, endpoints: {} } })
  await t.plugin.setup(t.ctx)
  await t.resolve("mai-code-2-flash")
  assert.ok(t.calls.some((c) => c.url === "https://api.acme.ghe.com/copilot_internal/user"))
  assert.ok(t.calls.some((c) => c.url === "https://copilot-api.acme.ghe.com/models"))
})

test("keeps at most 200 sessions", async () => {
  const t = setup()
  await t.plugin.setup(t.ctx)
  for (let i = 0; i < 205; i++) await t.resolve("mai-code-2-flash", "s" + i)
  assert.equal(t.request("mai-code-2-flash", "s0").headers["Copilot-Session-Token"], undefined)
  assert.ok(t.request("mai-code-2-flash", "s204").headers["Copilot-Session-Token"])
})

test("rebuilds OpenCode's model list once the allowed models are known", async () => {
  const t = setup()
  await t.plugin.setup(t.ctx)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(t.reloads(), 1)
})

test("no rebuild on a paid plan", async () => {
  const t = setup({ user: PAID_USER })
  await t.plugin.setup(t.ctx)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(t.reloads(), 0)
})

test("reads the Copilot login through OpenCode's integration API", async () => {
  const { readCredentialFromOpenCode } = await import("../index.js")
  const ctx = (credential, connection = { id: "c1" }) => ({
    integration: { connection: { active: async (id) => (id === "github-copilot" ? connection : undefined), resolve: async () => credential } },
  })
  assert.deepEqual(
    await readCredentialFromOpenCode(ctx({ type: "oauth", refresh: "gho_x", access: "gho_x", metadata: { apiEndpoint: "https://e" } })),
    { token: "gho_x", metadata: { apiEndpoint: "https://e" } },
  )
  assert.equal(await readCredentialFromOpenCode(ctx({ type: "oauth" })), undefined)
  assert.equal(await readCredentialFromOpenCode(ctx({ type: "key", key: "k" })), undefined)
  assert.equal(await readCredentialFromOpenCode(ctx(undefined, null)), undefined)
  assert.equal(await readCredentialFromOpenCode({}), undefined)
})

test("after disconnecting Copilot the plugin steps aside instead of failing", async () => {
  let credential = { token: "gho_one", metadata: {} }
  const t = setup()
  const { createPlugin } = await import("../index.js")
  let clock = 1_800_000_000_000
  const plugin = createPlugin({
    fetch: async (url) => {
      const path = new URL(url).pathname
      if (path === "/copilot_internal/user") return { ok: true, json: async () => FREE_USER }
      if (path === "/models") return { ok: true, json: async () => MODELS }
      return { ok: true, json: async () => ({ selected_model: { id: "mai-code-2-flash" }, session_token: "t", expires_at: 4e9 }) }
    },
    readCredential: async () => credential,
    now: () => clock,
  })
  await plugin.setup(t.ctx)
  assert.equal((await t.resolve("gpt-6-luna")).model.id, "mai-code-2-flash")
  credential = undefined
  clock += 31 * 1000
  assert.equal((await t.resolve("gpt-6-luna", "s2")).model.id, "gpt-6-luna")
})

test("a login that can't be read is treated as no login", async () => {
  const t = setup()
  const { createPlugin } = await import("../index.js")
  const plugin = createPlugin({ fetch: async () => { throw new Error("no network expected") }, readCredential: async () => { throw new Error("boom") } })
  await plugin.setup(t.ctx)
  assert.equal((await t.resolve("gpt-6-luna")).model.id, "gpt-6-luna")
})

test("a model list rebuild that throws doesn't break setup", async () => {
  const t = setup()
  t.ctx.model.reload = () => { throw new Error("not now") }
  await t.plugin.setup(t.ctx)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((await t.resolve("gpt-6-luna")).model.id, "mai-code-2-flash")
})
