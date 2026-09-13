# Authored browser application

The browser admits authoritative Lua packages, renders their operations and
state, and executes them in a dedicated worker over declared Web Serial or
WebUSB profiles.

Build and serve it locally:

```sh
npm ci
npm run build
npm run serve
```

The server listens on `http://127.0.0.1:4174` by default. Set `PDR_WEB_PORT`
to choose another port. Browser permission choosers stay in the page's user
gesture while the worker owns the connection, authored session, diagnostics,
resources, and capture.

The browser imports both transport adapters. A profile is unsupported when
its browser API is absent. Multiple eligible modes, profiles, or candidates
require explicit selection. Admission and help never request permission.

Each opened session can record a bounded in-memory capture. The capture queue
and retained bytes share one memory envelope, and exceeding it fails loudly.
Declared file inputs and results remain streamed through browser-owned resource
handles.
