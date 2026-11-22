# Changelog

## 0.1.1 (2026-11-22)

- Fixes 0.1.0 hiding the models Auto routes to. OpenCode refuses a hidden model, so a request failed whenever Auto picked a model other than the picker's one entry. All allowed models stay on again, each labelled "· via Auto".

## 0.1.0 (2026-11-22)

- Makes GitHub Copilot Free work in OpenCode 2.x by routing requests through Copilot's Auto mode.
- Turns on only for accounts OpenCode can't serve by itself, and follows login changes within 30 seconds.
- Shows one picker entry, "Auto (Copilot picks the model)", since Auto decides which model answers. (This broke routing; fixed in 0.1.1.)
