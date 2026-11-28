// opencode-copilot-auto: makes GitHub Copilot Free usable in OpenCode 2.x.
//
// Copilot Free only answers requests that go through Copilot's Auto mode: ask
// /auto which model to use, then send the request to that model together with
// the session token Auto returned. OpenCode only does this for plans whose models
// carry an Auto discount, which Free doesn't, so every request fails with
// "The requested model is not supported" and the model picker stays empty.
//
// It turns on only when OpenCode can't serve the account by itself: GitHub marks
// none of the account's models as pickable and none has an Auto discount. That is
// Copilot Free today. It then:
//   - shows the chat models GitHub allows the account in the model picker,
//     each labelled "· via Auto", since Auto decides which model answers
//     whatever is picked. They all stay switched on: OpenCode refuses to run a
//     hidden model, and Auto may pick any of them.
//   - when one is used, asks Auto which model to run and routes the request
//     there with Auto's session token.
// On any other account it does nothing, so OpenCode's own Copilot support is untouched.
//
// Set OPENCODE_COPILOT_AUTO=off to turn it off, or =always to route through Auto
// whatever the plan.
//
// Separately, on every Copilot account, it keeps requests small. Copilot stores
// nothing between requests, so OpenCode re-sends the whole chat each time,
// including every photo. On a slow upload that soon takes longer than Copilot
// waits ("Timed out reading request body"). So while a request is over a size
// limit, it swaps photos and files from earlier messages for a short note, oldest
// first; the latest message keeps its own. After a body timeout it retries once
// with every earlier attachment removed, then stops retrying.
// Set OPENCODE_COPILOT_SLIM=off to turn this off, and OPENCODE_COPILOT_SLIM_KB to
// change the limit (default 400).

import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"

export const VERSION = "0.2.0"
const PROVIDER = "github-copilot"
const USER_AGENT = `opencode-copilot-auto/${VERSION}`
const API_VERSION = "2026-08-01" // what OpenCode 2.3 sends to the Copilot API
const USER_API_VERSION = "2025-04-01" // what OpenCode 2.3 sends to copilot_internal/user
const CREDENTIAL_TTL_MS = 30 * 1000 // notice a reconnect or disconnect within 30 seconds
const ACCOUNT_TTL_MS = 60 * 60 * 1000 // re-check plan and models hourly
const ACCOUNT_RETRY_MS = 60 * 1000 // after a failed check, try again a minute later
const RENEW_EARLY_MS = 5 * 60 * 1000 // renew Auto's pick 5 minutes before its token expires
const DEFAULT_ROUTE_MS = 20 * 60 * 1000 // when Auto gives no expiry
const TIMEOUT_MS = 15 * 1000
const MAX_SESSIONS = 200
const MAX_PROMPT_CHARS = 2000
const VIA_AUTO = " · via Auto"
const SLIM_DEFAULT_KB = 400
const BODY_TIMEOUT = "timed out reading request body"
const REMOVED_NOTE = "[An attachment sent earlier was removed from this request to keep the upload small. Ask the user to send it again if you need it.]"

// ---------- keeping requests small ----------

const isDataUrl = (value) => typeof value === "string" && value.startsWith("data:")

// The data URL or inline data a content part carries, if it is a photo or file.
function attachmentData(part) {
  if (!part || typeof part !== "object") return undefined
  if (part.type === "input_image" && isDataUrl(part.image_url)) return part.image_url // Responses API
  if (part.type === "image_url" && isDataUrl(part.image_url?.url)) return part.image_url.url // Chat Completions
  if (part.type === "input_file" && typeof part.file_data === "string") return part.file_data
  if (part.type === "file" && typeof part.file?.file_data === "string") return part.file.file_data
  return undefined
}

const isUserMessage = (item) => item?.role === "user" && (item.type === undefined || item.type === "message")

// Shrinks a Copilot request body (Responses or Chat Completions) in place by
// swapping photos and files of earlier turns for a note, oldest first, while the
// body is over the limit (or all of them with dropAllAttachments). Everything from
// the latest user message on is the current turn and stays as it is.
export function slimBody(body, { limitBytes, dropAllAttachments = false }) {
  const stats = { attachments: 0 }
  const responses = Array.isArray(body?.input)
  const list = responses ? body.input : Array.isArray(body?.messages) ? body.messages : undefined
  if (!list) return stats
  let current = -1
  for (let i = list.length - 1; i >= 0; i--) if (isUserMessage(list[i])) { current = i; break }
  if (current <= 0) return stats

  const textType = responses ? "input_text" : "text"
  const size = () => Buffer.byteLength(JSON.stringify(body))
  let total = dropAllAttachments ? Infinity : size()
  const holders = [] // [array, index] of each earlier attachment, oldest first
  const collect = (value) => {
    if (Array.isArray(value)) {
      value.forEach((part, index) => {
        if (attachmentData(part) !== undefined) holders.push([value, index])
        else collect(part)
      })
    } else if (value && typeof value === "object") {
      for (const key of ["content", "output"]) if (value[key] !== undefined) collect(value[key])
    }
  }
  for (let i = 0; i < current; i++) collect(list[i])
  for (const [array, index] of holders) {
    if (total <= limitBytes) break
    const data = attachmentData(array[index])
    array[index] = { type: textType, text: REMOVED_NOTE }
    stats.attachments++
    total = dropAllAttachments ? Infinity : total - Buffer.byteLength(JSON.stringify(data)) + REMOVED_NOTE.length
  }
  return stats
}

function errorText(error) {
  const parts = [error?.message, error?.response?.body, typeof error === "string" ? error : undefined]
  return parts.filter((p) => typeof p === "string").join(" ").toLowerCase()
}

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
  const slim = (deps.slim ?? process.env.OPENCODE_COPILOT_SLIM ?? "on").toLowerCase() !== "off"
  const slimKb = Number(deps.slimKb ?? process.env.OPENCODE_COPILOT_SLIM_KB)
  const limitBytes = (Number.isFinite(slimKb) && slimKb > 0 ? slimKb : SLIM_DEFAULT_KB) * 1024
  // OPENCODE_COPILOT_AUTO_DEBUG=/path/to/file appends what the plugin does to that file.
  const debugFile = process.env.OPENCODE_COPILOT_AUTO_DEBUG
  const log = deps.log ?? ((line) => {
    if (!debugFile) return
    try { appendFileSync(debugFile, `${new Date().toISOString()} ${line}\n`) } catch {}
  })
  const bodyTimeouts = new Map() // sessionID -> body timeouts in a row
  const slowSessions = new Set() // sessions that had a body timeout: drop every earlier attachment
  const lastSize = new Map() // sessionID -> KB of the last request sent
  const bound = (collection) => {
    while (collection.size > MAX_SESSIONS) collection.delete(collection.keys().next().value)
  }

  let account // { key, needsAuto, models: Set, base, plan, checkedAt, ok }
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

  async function checkAccount(credential, key) {
    const enterprise = typeof credential.metadata.enterpriseUrl === "string" && credential.metadata.enterpriseUrl
    const enterpriseHost = enterprise ? enterprise.replace(/^https?:\/\//, "").replace(/\/+$/, "") : undefined
    const apiHost = enterpriseHost ? `https://api.${enterpriseHost}` : "https://api.github.com"
    const user = await request(`${apiHost}/copilot_internal/user`, { token: credential.token, version: USER_API_VERSION })
    const base = String(
      user?.endpoints?.api || credential.metadata.apiEndpoint ||
        (enterpriseHost ? `https://copilot-api.${enterpriseHost}` : "https://api.githubcopilot.com"),
    ).replace(/\/+$/, "")
    const list = await request(`${base}/models`, { token: credential.token, version: API_VERSION })
    const data = (Array.isArray(list?.data) ? list.data : []).filter((m) => m && typeof m.id === "string")
    // OpenCode serves an account by itself when it can show models or route Auto.
    const servedByOpenCode = data.some((m) => m.model_picker_enabled === true || m.billing?.auto_discount !== undefined)
    const models = new Set(
      data
        .filter((m) =>
          m.policy?.state === "enabled" &&
          (m.capabilities?.type ?? "chat") === "chat" && m.capabilities?.supports?.tool_calls === true)
        .map((m) => m.id),
    )
    log(`account: plan ${user?.access_type_sku}, ${data.length} models, ${models.size} allowed, ` +
      (servedByOpenCode ? "served by OpenCode itself" : "needs Auto"))
    return { key, needsAuto: !servedByOpenCode, base, models, plan: String(user?.access_type_sku ?? ""), ok: true }
  }

  // The current login, re-read at most every 30 seconds. Never throws.
  let login // { credential, key, at }
  async function currentLogin(ctx) {
    if (login && now() - login.at < CREDENTIAL_TTL_MS) return login
    let credential
    try { credential = await readCredentialFrom(ctx) } catch (error) { log("reading the Copilot login failed: " + error.message) }
    const key = credential ? createHash("sha256").update(credential.token).digest("hex").slice(0, 16) : undefined
    login = { credential, key, at: now() }
    return login
  }

  // Cached account state for the current login; never throws (a failed check means "do nothing").
  async function getAccount(ctx) {
    const { credential, key } = await currentLogin(ctx)
    if (!credential) return { key: undefined, needsAuto: false, models: new Set() }
    if (account && account.key === key) {
      const age = now() - account.checkedAt
      if (age < (account.ok ? ACCOUNT_TTL_MS : ACCOUNT_RETRY_MS)) return account
    }
    if (!accountLoad || accountLoad.key !== key) {
      const load = checkAccount(credential, key)
        .catch((error) => {
          log("account check failed: " + error.message)
          const previous = account?.key === key ? account : { key, needsAuto: false, models: new Set() }
          return { ...previous, ok: false }
        })
        .then((result) => {
          account = { ...result, checkedAt: now() }
          return account
        })
        .finally(() => { if (accountLoad?.promise === load) accountLoad = undefined })
      accountLoad = { key, promise: load }
    }
    return accountLoad.promise
  }

  function active(acct) {
    return mode !== "off" && acct.key !== undefined && (acct.needsAuto || mode === "always")
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
    const { credential, key } = await currentLogin(ctx)
    if (!credential || key !== acct.key) throw new Error("the GitHub Copilot login changed; try again")
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

  async function setupSlim(ctx) {
    await ctx.session.hook("http.request", async (call) => {
      const request = call.request
      if (!request || request.method !== "POST") return
      if (!(request.headers.get("content-type") ?? "").includes("json")) return
      let text, body
      try {
        text = await request.clone().text()
        body = JSON.parse(text)
      } catch {
        return
      }
      const before = Buffer.byteLength(text)
      lastSize.set(call.sessionID, Math.ceil(before / 1024))
      bound(lastSize)
      const dropAllAttachments = slowSessions.has(call.sessionID)
      if (before <= limitBytes && !dropAllAttachments) return
      const stats = slimBody(body, { limitBytes, dropAllAttachments })
      if (!stats.attachments) {
        log(`request ${Math.round(before / 1024)} KB, nothing earlier to remove`)
        return
      }
      const slimmed = JSON.stringify(body)
      const headers = new Headers(request.headers)
      headers.delete("content-length")
      call.request = new Request(request.url, { method: "POST", headers, body: slimmed, signal: request.signal })
      lastSize.set(call.sessionID, Math.ceil(Buffer.byteLength(slimmed) / 1024))
      log(`request ${Math.round(before / 1024)} KB -> ${Math.round(Buffer.byteLength(slimmed) / 1024)} KB ` +
        `(removed ${stats.attachments} earlier attachments)`)
    }, { providerID: PROVIDER })

    // Re-sending the same body after a body timeout fails the same way. From then on
    // the session drops every earlier attachment; it retries once, then stops.
    await ctx.session.hook("retry", (call) => {
      if (!errorText(call.error).includes(BODY_TIMEOUT)) return
      const seen = (bodyTimeouts.get(call.sessionID) ?? 0) + 1
      bodyTimeouts.set(call.sessionID, seen)
      slowSessions.add(call.sessionID)
      bound(bodyTimeouts)
      bound(slowSessions)
      log(`body timeout ${seen} in a row in ${call.sessionID} (request ${lastSize.get(call.sessionID) ?? "?"} KB)`)
      if (seen >= 2) call.decision = { retry: false }
    }, { providerID: PROVIDER })

    // A request that got through starts the count again.
    await ctx.session.hook("http.response", (call) => {
      if (call.response?.ok) bodyTimeouts.delete(call.sessionID)
    }, { providerID: PROVIDER })
  }

  return {
    id: "copilot-auto",
    async setup(ctx) {
      if (slim) await setupSlim(ctx)
      if (mode === "off") return
      // Check the account now. OpenCode may have built its model list already,
      // so rebuild it once the allowed models are known, to unhide them.
      getAccount(ctx).then((acct) => {
        if (!active(acct) || !acct.models.size || typeof ctx.model?.reload !== "function") return
        try {
          Promise.resolve(ctx.model.reload()).catch(() => {})
        } catch {}
      })

      if (typeof ctx.model?.transform === "function") {
        await ctx.model.transform((models) => {
          if (!account || !active(account) || account.key !== login?.key) return
          // Every allowed model stays on: Auto may route to any of them, and OpenCode
          // refuses a hidden one. The label says Auto decides, whatever is picked.
          for (const id of account.models) {
            if (!models.get(PROVIDER, id)) continue
            models.update(PROVIDER, id, (m) => {
              m.enabled = true
              const name = typeof m.name === "string" && m.name ? m.name : id
              if (!name.endsWith(VIA_AUTO)) m.name = name + VIA_AUTO
            })
          }
        })
      }

      await ctx.session.hook("experimental.model.resolve", async (call) => {
        if (call.kind === "title" || call.model?.providerID !== PROVIDER) return
        const acct = await getAccount(ctx)
        if (!active(acct) || !acct.models.has(call.model.id)) {
          if (active(acct)) log(`${call.model.id} is not one of the allowed models (${[...acct.models].join(", ")}); left alone`)
          return
        }
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
