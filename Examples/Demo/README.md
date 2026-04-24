# Node SDK demo server

A tiny zero-dependency Node HTTP server that exercises the `@owlmetry/node` SDK. Used as the backend for the iOS demo's "Backend Demo" section — both apps emit events under the seeded **Demo Project** so you can see cross-SDK session correlation in the Owlmetry dashboard.

The demo resolves `@owlmetry/node` via `file:../..` so it always runs against the in-repo SDK — it doubles as a pre-release smoke test.

## Prerequisites

- Node.js 20+
- An Owlmetry API server running on `http://localhost:4000` (see the [main repo](https://github.com/owlmetry/owlmetry) — `pnpm dev:server`)
- The seeded server client key `owl_client_svr_0000000000000000000000000000000000000000` (created by `pnpm dev:seed` in the main repo)

## Run it

```bash
# 1. From the repo root, build the SDK so dist/ exists
cd ../..
npm install
npm run build

# 2. Start the demo
cd Examples/Demo
npm install
npm start
```

The server listens on `http://localhost:4007`.

```bash
curl -s http://localhost:4007/health    # {"status":"ok"}
```

## Endpoints

| Method | Path              | Body                                       | What it does                                                           |
|--------|-------------------|--------------------------------------------|------------------------------------------------------------------------|
| GET    | `/health`         | —                                          | Liveness probe                                                         |
| POST   | `/api/greet`      | `{ name?, userId? }`                       | Starts + completes an Owlmetry operation; returns a greeting           |
| POST   | `/api/checkout`   | `{ item?, userId? }`                       | Starts an operation, emits a warn, fails the operation; returns 500    |
| POST   | `/api/profile`    | `{ userId, plan?, company? }`              | Sets user properties; emits an info event                              |
| POST   | `/api/feedback`   | `{ message, name?, email?, userId? }`      | Submits end-user feedback via `Owl.sendFeedback`                       |

Pass `X-Owl-Session-Id` on any POST to correlate the resulting events with an existing session (the iOS demo does this so its session and the backend's line up).

## iOS demo integration

Start the API server, then this demo, then the iOS demo from [`owlmetry-swift/Examples/Demo/`](https://github.com/owlmetry/owlmetry-swift/tree/main/Examples/Demo). The iOS app's "Backend Demo" buttons call `http://localhost:4007/api/greet` and `/api/checkout` — the full end-to-end flow is walked through in [`owlmetry/demos/DEMO_TEST_GUIDE.md`](https://github.com/owlmetry/owlmetry/blob/main/demos/DEMO_TEST_GUIDE.md).
