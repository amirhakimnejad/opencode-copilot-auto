// opencode-copilot-auto: makes GitHub Copilot Free usable in OpenCode 2.x.
//
// Copilot Free only answers requests that go through Copilot's Auto mode: ask
// /auto which model to use, then send the request to that model together with
// the session token Auto returned. OpenCode only does this for plans whose models
// carry an Auto discount, which Free doesn't, so every request fails with
// "The requested model is not supported" and the model picker stays empty.
//
// On a Copilot Free account this plugin:
//   - shows the chat models GitHub allows the account in the model picker,
//   - when one of them is used, asks Auto which model to run and routes the
//     request there with Auto's session token (Auto decides, not the pick).
// On any other plan it does nothing, so OpenCode's own Copilot support is untouched.
//
// Set OPENCODE_COPILOT_AUTO=off to turn it off, or =always to route through Auto
// whatever the plan.

import { createHash } from "node:crypto"

export const VERSION = "0.1.0"
const PROVIDER = "github-copilot"
const USER_AGENT = `opencode-copilot-auto/${VERSION}`
const API_VERSION = "2026-08-01" // what OpenCode 2.3 sends to the Copilot API
const USER_API_VERSION = "2025-04-01" // what OpenCode 2.3 sends to copilot_internal/user
const ACCOUNT_TTL_MS = 60 * 60 * 1000 // re-check plan and models hourly
const ACCOUNT_RETRY_MS = 60 * 1000 // after a failed check, try again a minute later
const RENEW_EARLY_MS = 5 * 60 * 1000 // renew Auto's pick 5 minutes before its token expires
const DEFAULT_ROUTE_MS = 20 * 60 * 1000 // when Auto gives no expiry
const TIMEOUT_MS = 15 * 1000
const MAX_SESSIONS = 200
const MAX_PROMPT_CHARS = 2000

// ---------- reading OpenCode's Copilot login ----------

// Uses OpenCode's own integration API, so the plugin never touches its database.
export async function readCredentialFromOpenCode(ctx) {
  const connections = ctx?.integration?.connection
  if (typeof connections?.active !== "function" || typeof connections?.resolve !== "function") return undefined
  const connection = await connections.active(PROVIDER)
  if (!connection) return undefined
  const credential = await connections.resolve(connection)
  const token = credential?.type === "oauth" ? credential.refresh || credential.access : undefined
  if (typeof token !== "string" || !token) return undefined
  return { token, metadata: credential.metadata ?? {} }
}

// ---------- the plugin ----------

export function createPlugin(deps = {}) {
  const readCredentialFrom = deps.readCredential ?? readCredentialFromOpenCode
  const http = deps.fetch ?? ((...args) => fetch(...args))
  const now = deps.now ?? (() => Date.now())
  const mode = (deps.mode ?? process.env.OPENCODE_COPILOT_AUTO ?? "auto").toLowerCase()
  const log = deps.log ?? (() => {})

  let account // { key, free, models: Set, base, checkedAt, ok }
  let accountLoad // in-flight account check
  const routes = new Map() // sessionID -> { model, token, until, key }
  const picking = new Map() // sessionID -> in-flight pick

  async function request(url, { token, version, body }) {
    const response = await http(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        Authorization: "Bearer " + token,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": version,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`${new URL(url).pathname} answered HTTP ${response.status}`)
    return response.json()
  }

  let host // the plugin context, set in setup
  const readCredential = () => readCredentialFrom(host)

  async function checkAccount() {
    const credential = await readCredential()
    if (!credential) return { key: undefined, free: false, models: new Set(), ok: true }
    const key = createHash("sha256").update(credential.token).digest("hex").slice(0, 16)
    const enterprise = typeof credential.metadata.enterpriseUrl === "string" && credential.metadata.enterpriseUrl
    const host = enterprise ? enterprise.replace(/^https?:\/\//, "").replace(/\/+$/, "") : undefined
    const user = await request(`${host ? `https://api.${host}` : "https://api.github.com"}/copilot_internal/user`, {
      token: credential.token,
      version: USER_API_VERSION,
    })
    const base = String(
      user?.endpoints?.api || credential.metadata.apiEndpoint ||
        (host ? `https://copilot-api.${host}` : "https://api.githubcopilot.com"),
    ).replace(/\/+$/, "")
    const sku = String(user?.access_type_sku ?? "")
    const free = /free/i.test(sku) || String(user?.copilot_plan ?? "") === "free"
    if (!free && mode !== "always") return { key, free, base, models: new Set(), ok: true }
    const list = await request(`${base}/models`, { token: credential.token, version: API_VERSION })
    const models = new Set(
      (Array.isArray(list?.data) ? list.data : [])
        .filter((m) =>
          m && typeof m.id === "string" && m.policy?.state === "enabled" &&
          (m.capabilities?.type ?? "chat") === "chat" && m.capabilities?.supports?.tool_calls === true)
        .map((m) => m.id),
    )
    return { key, free, base, models, ok: true }
  }

  // Cached account state; never throws (a failed check means "do nothing").
  async function getAccount() {
    const age = account ? now() - account.checkedAt : Infinity
    if (account && age < (account.ok ? ACCOUNT_TTL_MS : ACCOUNT_RETRY_MS)) return account
    if (!accountLoad) {
      accountLoad = checkAccount()
        .catch((error) => {
          log("account check failed: " + error.message)
          return { ...(account ?? { free: false, models: new Set() }), ok: false }
        })
        .then((result) => {
          account = { ...result, checkedAt: now() }
          return account
        })
        .finally(() => { accountLoad = undefined })
    }
    return accountLoad
  }

  function active(acct) {
    return mode !== "off" && acct.key !== undefined && (acct.free || mode === "always")
  }

  async function promptFor(ctx, sessionID) {
    try {
      if (typeof ctx.session?.context !== "function") return undefined
      const entries = await ctx.session.context({ sessionID })
      const user = Array.isArray(entries) ? entries.findLast((e) => e?.type === "user") : undefined
      return typeof user?.text === "string" ? user.text.slice(0, MAX_PROMPT_CHARS) : undefined
    } catch {
      return undefined
    }
  }

  async function pick(ctx, sessionID, acct) {
    const credential = await readCredential()
    if (!credential) throw new Error("GitHub Copilot isn't connected in OpenCode")
    const prompt = (await promptFor(ctx, sessionID)) || "Help me with my code."
    const answer = await request(`${acct.base}/auto`, { token: credential.token, version: API_VERSION, body: { prompt } })
    const model = answer?.selected_model?.id
    if (typeof model !== "string" || typeof answer?.session_token !== "string") {
      throw new Error("Copilot Auto returned no model")
    }
    const expires = Number(answer.expires_at) * 1000
    const until = Number.isFinite(expires) && expires > now() ? Math.max(now(), expires - RENEW_EARLY_MS) : now() + DEFAULT_ROUTE_MS
    return { model, token: answer.session_token, until, key: acct.key }
  }

  function remember(sessionID, route) {
    routes.delete(sessionID)
    routes.set(sessionID, route)
    while (routes.size > MAX_SESSIONS) routes.delete(routes.keys().next().value)
  }

  async function routeFor(ctx, sessionID, acct) {
    const cached = routes.get(sessionID)
    if (cached && cached.key === acct.key && cached.until > now()) return cached
    let pending = picking.get(sessionID)
    if (!pending) {
      pending = pick(ctx, sessionID, acct)
        .then((route) => { remember(sessionID, route); return route })
        .finally(() => picking.delete(sessionID))
      picking.set(sessionID, pending)
    }
    return pending
  }

  return {
    id: "copilot-auto",
    async setup(ctx) {
      if (mode === "off") return
      host = ctx
      // Check the account now. OpenCode may have built its model list already,
      // so rebuild it once the allowed models are known, to unhide them.
      getAccount().then((acct) => {
        if (active(acct) && acct.models.size && typeof ctx.model?.reload === "function") {
          Promise.resolve(ctx.model.reload()).catch(() => {})
        }
      })

      if (typeof ctx.model?.transform === "function") {
        await ctx.model.transform((models) => {
          if (!account || !active(account)) return
          for (const id of account.models) {
            if (models.get(PROVIDER, id)) models.update(PROVIDER, id, (m) => { m.enabled = true })
          }
        })
      }

      await ctx.session.hook("experimental.model.resolve", async (call) => {
        if (call.kind === "title" || call.model?.providerID !== PROVIDER) return
        const acct = await getAccount()
        if (!active(acct) || !acct.models.has(call.model.id)) return
        let route
        try {
          route = await routeFor(ctx, call.sessionID, acct)
        } catch (error) {
          throw new Error(`copilot-auto: Copilot Auto failed (${error.message}). Try again in a moment, or pick another model.`)
        }
        call.model = { providerID: PROVIDER, id: route.model }
      }, { providerID: PROVIDER })

      await ctx.session.hook("model.request", (call) => {
        if (call.kind === "title") return
        const route = routes.get(call.sessionID)
        if (route && route.model === call.model?.id && route.until > now()) {
          call.headers["Copilot-Session-Token"] = route.token
        }
      }, { providerID: PROVIDER })

      // A compacted session asks Auto again.
      await ctx.session.hook("compaction", (call) => { routes.delete(call.sessionID) }, { providerID: PROVIDER })
    },
  }
}

export default createPlugin()
