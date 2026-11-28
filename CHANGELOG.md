# Changelog

## 0.2.0 (2026-11-28)

- Keeps Copilot requests small on every Copilot account. OpenCode re-sends the whole chat with every message, photos included, and on a slow upload Copilot fails with "Timed out reading request body". Photos and files from earlier messages are now swapped for a short note while a request is over 400 KB (`OPENCODE_COPILOT_SLIM_KB`); the latest message keeps its own.
- After a body timeout, retries once without any earlier attachments, then stops retrying. OpenCode used to send the same upload 7 times or more.
- `OPENCODE_COPILOT_SLIM=off` turns both off. `OPENCODE_COPILOT_AUTO_DEBUG=<file>` logs what the plugin does.
- Tested with OpenCode 2.4.1.

## 0.1.2 (2026-11-22)

- README: the install example used `"plugin"`; OpenCode 2.x reads `"plugins"`.

## 0.1.1 (2026-11-22)

- Fixes 0.1.0 hiding the models Auto routes to. OpenCode refuses a hidden model, so a request failed whenever Auto picked a model other than the picker's one entry. All allowed models stay on again, each labelled "· via Auto".

## 0.1.0 (2026-11-22)

- Makes GitHub Copilot Free work in OpenCode 2.x by routing requests through Copilot's Auto mode.
- Turns on only for accounts OpenCode can't serve by itself, and follows login changes within 30 seconds.
- Shows one picker entry, "Auto (Copilot picks the model)", since Auto decides which model answers. (This broke routing; fixed in 0.1.1.)
