# opencode-copilot-auto

Makes **GitHub Copilot Free** work in [OpenCode](https://opencode.ai) 2.x.

## The problem

With a Copilot Free account connected, OpenCode's model picker shows the Copilot
models for a moment and then empties. Picking one by name fails with
`The requested model is not supported.`

Copilot Free only serves requests that go through Copilot's **Auto** mode: the
client asks Copilot which model to use, then sends the request to that model with
a short-lived session token. OpenCode only does this for plans whose models carry
an Auto discount, which Free doesn't have.

## What the plugin does

On a Copilot Free account it:

- shows the chat models GitHub allows your account in the model picker, and
- routes requests for those models through Auto: it asks Copilot which model to
  use, switches the request to it, and adds Auto's session token. Auto keeps its
  pick for the session until the token is about to expire, or until the session
  is compacted.

On any other Copilot plan it does nothing, so OpenCode's own Copilot support is
untouched. It doesn't impersonate another client: requests use your OpenCode
Copilot login and identify themselves as `opencode-copilot-auto`.

## Install

1. Connect GitHub Copilot in OpenCode as usual.
2. Add the plugin to `opencode.json`:

   ```json
   { "plugin": ["opencode-copilot-auto@0.1.0"] }
   ```

   or copy `index.js` to `~/.config/opencode/plugins/copilot-auto.js`.
3. Restart OpenCode and pick any GitHub Copilot model.

**Auto decides which model answers**, not your pick. Picking a Copilot model
only turns the routing on.

## Settings

| `OPENCODE_COPILOT_AUTO` | Effect |
|---|---|
| unset or `auto` | Route through Auto on Copilot Free only |
| `always` | Route through Auto on every plan |
| `off` | Do nothing |

## Limits

- Copilot Free has a small monthly chat allowance, and an agent sends one
  request per tool step, so long tasks use it up quickly.
- Session titles aren't routed (they would spend the allowance). Set a
  `small_model` from another provider for titles.
- It relies on OpenCode's plugin API (`integration.connection`, `model.transform`,
  `session.hook`) and on Copilot's `/auto` endpoint, neither of which is a
  documented stable API. Tested with OpenCode 2.3.2 on 2026-11-18. On older
  OpenCode versions that lack the API it does nothing.

## Development

```bash
npm test
```

The tests use a fake OpenCode host and a fake Copilot API; they make no network
requests.
