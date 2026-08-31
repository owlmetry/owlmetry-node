# @owlmetry/node

Node.js SDK for [Owlmetry](https://owlmetry.com) — self-hosted metrics tracking for mobile and backend apps.

Zero runtime dependencies. Works with any Node.js framework.

## Install

```bash
npm install @owlmetry/node
```

## Quick Start

ESM:

```js
import { Owl } from "@owlmetry/node";
```

CommonJS:

```js
const { Owl } = require("@owlmetry/node");
```

```js
Owl.configure({
  apiKey: "owl_client_...",
  endpoint: "https://ingest.owlmetry.com",
  // wrapHandler waits at most 500 ms for its final telemetry flush.
  handlerFlushTimeoutMs: 500,
});

// Log events
Owl.info("User signed up", { screen: "onboarding" });
Owl.error("Payment failed", { orderId: "abc123" });

// Track metrics
const op = Owl.startOperation("api-request");
// ... do work ...
op.complete({ route: "/users" });

// Record funnel steps
Owl.step("signup-started");

// Serverless support
export default Owl.wrapHandler(async (req, res) => {
  Owl.info("Request received");
  res.json({ ok: true });
});
```

`Owl.wrapHandler` preserves the wrapped handler's return value or thrown error.
It starts a best-effort telemetry flush after the handler settles, ignores flush
failures, and stops waiting after `handlerFlushTimeoutMs` so telemetry cannot
hold a product response open. The default deadline is 500 ms. Set the option to
an integer from 0 through 2,147,483,647, or set it to `null` only when the
handler must wait for the complete flush with no deadline.

## Example

A runnable demo server lives at [`Examples/Demo/`](./Examples/Demo/). It exercises the full SDK surface (operations, feedback, user properties, `wrapHandler`) and is the backend the iOS SDK demo calls from its "Backend Demo" screen, so cross-SDK session correlation shows up in one place in the dashboard.

## Links

- [Website](https://owlmetry.com)
- [Docs](https://owlmetry.com/docs/sdks/node)
- [Main repo](https://github.com/owlmetry/owlmetry) — server, dashboard, CLI
- [Claude Code skills](https://github.com/owlmetry/owlmetry-skills) — install with `/plugin marketplace add owlmetry/owlmetry-skills` to get AI agent instrumentation skills
