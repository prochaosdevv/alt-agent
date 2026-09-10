# Alt-agent

An AI agent that pays per inference call using the **x402 payment protocol** on **Hedera**, with a router that picks the cheapest capable model (Claude/GPT), a prepaid-credits system funded by a connected wallet, and every paid call logged to Hedera Consensus Service for a public audit trail. Built for the ETHOnline 2026 Hedera AI & Agentic Payments track.

Forked from [`hedera-dev/x402-inference-pay-per-request-poc`](https://github.com/hedera-dev/x402-inference-pay-per-request-poc) — see [Attribution](#attribution--reused-vs-new) below for exactly what's reused vs. new.

---

## What this demonstrates

- **x402 on Hedera** — the `exact` payment scheme using USDC or native HBAR on `hedera:testnet` / `hedera:mainnet`, settled via public facilitators.
- **Runtime network + asset switching** — toggle between testnet/mainnet and USDC/HBAR directly in the chat UI without restarting servers.
- **Hedera Agent Kit** — `HederaAIToolkit` + `wrapLanguageModel` from `@hashgraph/hedera-agent-kit-ai-sdk` wraps the local model with Hedera middleware.
- **OpenAI-compatible local inference** — LM Studio serves any GGUF model over an OpenAI-compatible API; the proxy adds the payment gate in front of it.
- **Live payment status** — the browser receives a Server-Sent Events stream as the payment moves through `connecting → payment required → signing → submitted → model running → settled`.

---

## Architecture

```
Browser (Chat UI)
    │  POST /api/chat  { messages, network, asset }  (SSE stream)
    ▼
Agent Server  :3001                    packages/agent
    │  Dual x402 clients (testnet + mainnet signers)
    │  HederaAIToolkit middleware (per network)
    │  Routes to /v1/{network}/{asset}/chat/completions
    ▼
Inference Service  :4021               packages/service
    │  4 payment-gated routes (testnet+mainnet × USDC+HBAR)
    │  Testnet routes → x402.org/facilitator
    │  Mainnet routes → api.blocky402.com
    │  → proxies to LM Studio on verify
    ▼
LM Studio  :1234                       local desktop app
    │  OpenAI-compatible /v1/chat/completions
    ▼
 Response travels back up the chain
 Facilitator settles tx on Hedera (async)
```

### Service routes

| Route | Network | Asset | Facilitator |
|---|---|---|---|
| `POST /v1/testnet/usdc/chat/completions` | hedera:testnet | USDC `0.0.429274` | x402.org |
| `POST /v1/testnet/hbar/chat/completions` | hedera:testnet | HBAR `0.0.0` | x402.org |
| `POST /v1/mainnet/usdc/chat/completions` | hedera:mainnet | USDC `0.0.456858` | api.blocky402.com |
| `POST /v1/mainnet/hbar/chat/completions` | hedera:mainnet | HBAR `0.0.0` | api.blocky402.com |

### Router-priced `/infer` endpoints (new)

On top of the four chat-completions routes above, the service exposes a router-priced `/infer` family for the AI & Agentic Payments track deliverable: a lightweight router picks the cheapest capable model tier per prompt, and every successful paid call is logged to HCS.

x402 requires a static price per route, so each tier gets its own route rather than one dynamically-priced `POST /infer`:

| Route | Tier | Price | Selection rule |
|---|---|---|---|
| `POST /infer/small-fast/chat/completions` | small-fast | $0.0005 | Prompt ≤ 60 characters |
| `POST /infer/default/chat/completions` | default | $0.001 | Everything else |
| `POST /infer/large-capable/chat/completions` | large-capable | $0.002 | Prompt ≥ 400 characters, or contains a keyword like `code`, `debug`, `analyze`, `summarize`, `write a` |

Each route ends in `/chat/completions` so it's OpenAI-compatible-provider-shaped — the Vercel AI SDK's OpenAI provider (used by the agent) always appends that suffix to whatever base URL it's given.

The router (`packages/shared/src/router.ts`) is a plain function — no ML, no training — see its unit tests in `packages/shared/src/router.test.ts`. It's shared between the service (to price `/infer` routes) and the agent (to auto-pick a tier client-side for the "Auto" model toggle in the chat UI). The **caller** runs the router locally on the prompt to decide which priced route to call (`scripts/smoke-test-infer.ts` is a working example), pays via x402, and the service forwards the request to LM Studio and fires the HCS log.

### Chat UI model selector (new)

The chat UI (`packages/agent/public/index.html`) has a **Model** toggle next to Net/Asset: **Auto** (router picks a tier per prompt), **Fast**, **Standard**, **Pro** (pin a tier manually). It's only enabled for Testnet + USDC — the only combination the `/infer` routes are registered for — and greys out otherwise, falling back to the original flat-price route. The assistant's reply bubble shows which tier was actually used next to the payment badge.

> **Note on tiers:** LM Studio in this PoC only ever runs one loaded local model — the tiers vary the *price* and the routing decision, not the underlying model weights. This keeps the demo simple and working rather than standing up three separate model servers; the router and pricing plumbing generalize directly to a real multi-model deployment.

Run the end-to-end flow with:

```bash
npm run smoke-test -- "your prompt here"
```

### HCS audit trail (new)

Every successful paid call to `/infer/*` fires a fire-and-forget message to a Hedera Consensus Service topic (`packages/service/src/hcs.ts`), logging `{ timestamp, model, price, txReference }`. The `txReference` is the settled x402 payment's transaction reference, decoded from the `PAYMENT-RESPONSE` response header.

Create the topic once:

```bash
npm run create-topic
```

This prints a topic ID — add it to `.env` as `HCS_TOPIC_ID`. View logged messages on [HashScan](https://hashscan.io/testnet) at `https://hashscan.io/testnet/topic/<HCS_TOPIC_ID>`.

Logging failures are caught and logged to the console — they never affect the inference response already sent to the caller.

### Payment flow (per request)

1. Browser sends `{ messages, network, asset }` to `/api/chat`.
2. Agent server calls the corresponding inference service route — gets **HTTP 402**.
3. x402 client selects the registered signer matching the network in the 402 response.
4. Client builds a Hedera `TransferTransaction`, signs with the agent's ECDSA key.
5. Retries the request with the base64-encoded transaction in the `PAYMENT-SIGNATURE` header.
6. Inference service calls the appropriate facilitator `/verify` → on success, proxies to LM Studio.
7. LM Studio generates the response; inference service returns it to the agent.
8. Facilitator co-signs and submits the transfer to Hedera (async settlement).

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 20 | `node -v` to check |
| LM Studio | [lmstudio.ai](https://lmstudio.ai) — desktop app |
| 2 × Hedera Testnet ECDSA accounts | Agent (payer) + service (receiver) |
| 2 × Hedera Mainnet ECDSA accounts | Required only if using Mainnet in the UI |
| Testnet HBAR | For transaction fees on testnet accounts |
| Testnet USDC | Agent account only — from [faucet.circle.com](https://faucet.circle.com) (Hedera Testnet) |
| Mainnet HBAR | For fees on mainnet accounts (if using Mainnet) |
| Mainnet USDC | Agent mainnet account only — from [faucet.circle.com](https://faucet.circle.com) (Hedera Mainnet) |

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/narbs91/x402-inference-agent-kit-poc.git
cd x402-inference-agent-kit-poc
npm install
```

### 2. Create Hedera accounts

Go to [portal.hedera.com](https://portal.hedera.com) and create **two ECDSA accounts** for testnet — one for the agent (payer) and one for the inference service (receiver). Save the Account IDs and private keys.

Fund both accounts with testnet HBAR via the [Hedera Faucet](https://faucet.hedera.com).

For **Mainnet** support, repeat with two mainnet ECDSA accounts.

### 3. Associate USDC (testnet)

The x402 facilitator requires both testnet accounts to hold a USDC token association before USDC payments can flow. HBAR is native and requires no association.

```bash
# Associate agent wallet
HEDERA_ACCOUNT_ID=0.0.XXXXX HEDERA_PRIVATE_KEY=0x... npm run associate -w scripts

# Associate service wallet
HEDERA_ACCOUNT_ID=0.0.YYYYY HEDERA_PRIVATE_KEY=0x... npm run associate -w scripts
```

For **mainnet USDC**, run the same script with `HEDERA_NETWORK=mainnet`:

```bash
HEDERA_ACCOUNT_ID=0.0.AAAAA HEDERA_PRIVATE_KEY=0x... HEDERA_NETWORK=mainnet npm run associate -w scripts
HEDERA_ACCOUNT_ID=0.0.BBBBB HEDERA_PRIVATE_KEY=0x... HEDERA_NETWORK=mainnet npm run associate -w scripts
```

### 4. Fund wallets with USDC

Go to [faucet.circle.com](https://faucet.circle.com) and fund the **agent** accounts (not service) with USDC on the relevant networks. The service account only receives, so it needs no USDC balance to start.

### 5. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials. At minimum, testnet credentials are required. Mainnet credentials are only needed if you want to use the Mainnet toggle in the UI.

`X402_TESTNET_FACILITATOR_URL` defaults to Blocky402's testnet facilitator (`https://api.testnet.blocky402.com`), required for AI & Agentic Payments track eligibility.

### 5b. Create the HCS audit topic (one-time)

```bash
npm run create-topic
```

Copy the printed topic ID into `.env` as `HCS_TOPIC_ID`.

### 6. Start LM Studio

Download a chat-tuned model (e.g. Qwen 2.5 7B Instruct, Llama 3.1 8B) and start the local server:

- **GUI**: Developer tab → Start Server (port 1234)
- **CLI**: `lms server start`

Note the model name exactly — paste it into `LM_STUDIO_MODEL` in your `.env`.

### 7. Run

```bash
npm run dev
```

This starts both servers concurrently:

- **Inference service** on `http://localhost:4021`
- **Agent UI** on `http://localhost:3001`

Open **http://localhost:3001** in your browser.

---

## Docker

An alternative to the local `npm run dev` flow above — runs the inference service, the agent UI,
and MongoDB (for credits) as three containers via Docker Compose. Still needs a filled-in `.env`
(copy `.env.example` first, same as the Quick Start above) — secrets are injected via `env_file`,
never baked into the images.

```bash
docker compose up -d --build
```

- **Inference service** on `http://localhost:4021`
- **Agent UI** on `http://localhost:3001`
- **MongoDB** on `localhost:27017` (a named volume persists credit balances across restarts)

`docker-compose.yml` overrides two URLs so container-to-container calls use Docker's internal
network while the browser still gets a host-reachable address:

| Variable | Plain local dev | Docker Compose |
|---|---|---|
| `MONGODB_URI` | `mongodb://localhost:27017` | `mongodb://mongo:27017` |
| `INFERENCE_SERVICE_URL` (agent server → service) | `http://localhost:4021` | `http://service:4021` |
| `PUBLIC_SERVICE_URL` (handed to the browser) | same as above | `http://localhost:4021` |

Deploying beyond localhost (a real host/domain)? Override `PUBLIC_SERVICE_URL` to that public
address — the browser makes direct wallet-connect calls (buying credits, paying per message) to
whatever URL this returns from `/api/config`, so it must be something the browser can actually
reach, not an internal container hostname.

```bash
docker compose logs -f            # tail all three services
docker compose down                # stop (add -v to also drop the mongo-data volume)
```

The `Dockerfile` is a single multi-stage build shared by both app images (`--target service` /
`--target agent`) — it needs the full monorepo as build context (npm workspaces), so both targets
build from the repo root, not per-package.

---

## Project Structure

```
├── packages/
│   ├── shared/                  Code shared between service + agent (new)
│   │   └── src/
│   │       ├── router.ts        Model-tier router — pure function, hardcoded catalogue
│   │       └── router.test.ts   Router unit tests
│   │
│   ├── service/                 Inference proxy
│   │   └── src/
│   │       ├── server.ts        Payment-gated routes: 4 chat-completions + 3 /infer tiers
│   │       ├── x402.ts          Resource server factory — one per facilitator
│   │       └── hcs.ts           HCS audit logger (new) — fire-and-forget per paid /infer call
│   │
│   └── agent/                   Agent + chat UI
│       ├── public/
│       │   └── index.html       Chat UI — network/asset/model toggles, SSE, Hedera branding
│       └── src/
│           ├── server.ts        Express API — /api/chat accepts { network, asset, tier }
│           ├── x402-client.ts   Dual signers (testnet + mainnet) registered at startup
│           └── model.ts         Per-network / per-tier model builders; routes to correct service URL
│
├── scripts/
│   ├── associate-token.ts       USDC token association — supports testnet + mainnet
│   ├── create-hcs-topic.ts      One-time HCS topic creation (new)
│   └── smoke-test-infer.ts      Router → x402-paid /infer call, end to end (new)
│
├── .env.example                 Environment variable template
├── SETUP.md                     Detailed wallet setup guide
└── tsconfig.base.json           Shared TypeScript config
```

---

## Tech Stack

| Layer | Package | Version |
|---|---|---|
| AI SDK | `ai` | ^6.0.86 |
| OpenAI provider | `@ai-sdk/openai` | ^3.0.84 |
| Hedera Agent Kit | `@hashgraph/hedera-agent-kit` | ^4.0.0 |
| Hedera Agent Kit AI | `@hashgraph/hedera-agent-kit-ai-sdk` | ^1.0.0 |
| Hedera SDK | `@hiero-ledger/sdk` | ^2.85.0 |
| x402 client | `@x402/fetch`, `@x402/hedera`, `@x402/core` | ^2.18.0 |
| x402 server | `@x402/express`, `@x402/hedera`, `@x402/core` | ^2.18.0 |
| HTTP framework | `express` | ^4.21.2 |
| Local LLM | LM Studio | — |
| Testnet facilitator | `https://api.testnet.blocky402.com` (Blocky402) | — |
| Mainnet facilitator | `https://api.blocky402.com` | — |

---

## Live Payment Status UI

The chat interface streams Server-Sent Events while a request is in flight. Each bubble shows a live step tracker:

```
🔌 Connect         ✓ done
💳 Sign tx         ✓ done
📤 Submit to x402  ◉ active  ← spinner while facilitator verifies
🧠 Model running   ○ pending
✓  Settled         ○ pending

↳ Submitting payment to x402 facilitator…
```

Once the response arrives the tracker is replaced with the assistant bubble, which:
- Renders the full reply as **Markdown** (code blocks, tables, lists, etc.)
- Shows a `✓ x402 paid · 0.001 USDC` (or `0.001 HBAR`) badge
- Includes a **HashScan ↗** link to the service account on [hashscan.io](https://hashscan.io) pointing to the correct network (testnet or mainnet)

### Network and asset toggles

The header contains two pill-style toggle groups:

- **Net**: `Testnet` | `Mainnet` — switches which Hedera network payments are routed to and which facilitator verifies them
- **Asset**: `USDC` | `HBAR` — switches between stablecoin and native HBAR payments

The spend counter, payment badge, and HashScan link all update automatically to reflect the active selection.

---

## Smoke Tests

```bash
# Testnet USDC route returns 402 with correct payment requirements
curl -si -X POST http://localhost:4021/v1/testnet/usdc/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local-model","messages":[{"role":"user","content":"hi"}]}' \
  | grep -i payment

# Mainnet HBAR route returns 402
curl -si -X POST http://localhost:4021/v1/mainnet/hbar/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local-model","messages":[{"role":"user","content":"hi"}]}' \
  | grep -i payment

# Verify testnet facilitator supports hedera:testnet
curl -s https://x402.org/facilitator/supported \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print([k for k in d['kinds'] if 'hedera' in k.get('network','')])"

# Verify mainnet facilitator supports hedera:mainnet
curl -s https://api.blocky402.com/supported \
  | python3 -m json.tool

# LM Studio health
curl http://localhost:1234/v1/models

# /infer tier route returns 402 with correct payment requirements
curl -si -X POST http://localhost:4021/infer/default/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}' \
  | grep -i payment

# Router unit tests
npm test

# Full router -> x402 payment -> LM Studio -> HCS log flow (needs funded testnet agent wallet)
npm run smoke-test -- "explain how x402 payments work in one paragraph"
```

---

## Environment Variables

### Required — Testnet

| Variable | Description |
|---|---|
| `HEDERA_AGENT_ACCOUNT_ID` | Agent testnet wallet (e.g. `0.0.12345`) |
| `HEDERA_AGENT_PRIVATE_KEY` | Agent testnet ECDSA private key (`0x…`) |
| `HEDERA_SERVICE_ACCOUNT_ID` | Service testnet wallet |
| `HEDERA_SERVICE_PRIVATE_KEY` | Service testnet key — used by the associate script, the create-topic script, and at runtime to submit HCS audit log messages |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | At least one required — router tiers call real Claude/GPT models, see `packages/service/src/providers.ts` |
| `HCS_TOPIC_ID` | HCS topic for the inference audit log — create with `npm run create-topic` |
| `MONGODB_URI` | Prepaid credits ledger — `mongodb://localhost:27017` for local dev, `mongodb://mongo:27017` under Docker Compose |
| `INTERNAL_API_KEY` | Shared secret between the agent and service for the internal `/credits/deduct` / `/credits/refund` calls — any random string |
| `WALLETCONNECT_PROJECT_ID` | Free project ID from [cloud.reown.com](https://cloud.reown.com) — required for the "Connect Wallet" flow |

### Optional — Mainnet (required for Mainnet UI toggle)

| Variable | Description |
|---|---|
| `HEDERA_AGENT_MAINNET_ACCOUNT_ID` | Agent mainnet wallet (falls back to testnet account) |
| `HEDERA_AGENT_MAINNET_PRIVATE_KEY` | Agent mainnet ECDSA private key |
| `HEDERA_SERVICE_MAINNET_ACCOUNT_ID` | Service mainnet wallet (falls back to testnet account) |

### Optional — Infrastructure

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4021` | Inference service port |
| `AGENT_PORT` | `3001` | Agent UI port |
| `X402_TESTNET_FACILITATOR_URL` | `https://api.testnet.blocky402.com` | Testnet facilitator override — Blocky402 by default (track eligibility requirement) |
| `X402_MAINNET_FACILITATOR_URL` | `https://api.blocky402.com` | Mainnet facilitator override |
| `INFERENCE_SERVICE_URL` | `http://localhost:4021` | Service host used by the agent **server** — do **not** append `/v1`. Docker Compose overrides this to `http://service:4021` |
| `PUBLIC_SERVICE_URL` | same as `INFERENCE_SERVICE_URL` | Service host handed to the **browser** for direct wallet-connect calls — must be reachable from wherever the browser runs, see [Docker](#docker) |
| `MONGODB_DB_NAME` | `x402_inference_poc` | Mongo database name for the credits ledger |
| `OPENAI_MODEL_SMALL` / `ANTHROPIC_MODEL_DEFAULT` / `ANTHROPIC_MODEL_LARGE` | see `providers.ts` | Override which real model backs each router tier |

---

## Facilitator Support

| Facilitator                              | Hedera Testnet | Hedera Mainnet |
|-------------------------------------------|---|---|
| `api.testnet.blocky402.com` (Blocky402)   | ✓ | — |
| `api.blocky402.com` (Blocky402)           | ✓ | ✓ |
| `x402.org` (x402 Foundation)               | ✓ | — |

The service uses Blocky402's testnet facilitator (`api.testnet.blocky402.com`) for testnet routes by default and `api.blocky402.com` for mainnet routes. Both can be overridden via env vars — see [Environment Variables](#environment-variables).

---

## Limitations (by design)

This is a proof-of-concept. The following are intentional non-goals:

- **No persistent chat history** — conversation resets on page refresh.
- **No per-token metering** — flat $0.001 per request on the original chat-completions routes; the `/infer` routes price by tier (router-selected), not by token count.
- **Router picks a price tier, not a different model** — LM Studio only ever runs one loaded local model in this PoC (see [Router-priced `/infer` endpoints](#router-priced-infer-endpoints-new)).
- **No streaming inference** — the full response is returned after payment settles.
- **Single-user** — one agent wallet shared for all browser sessions.
- **HBAR on testnet** — the x402.org testnet facilitator may not support HBAR; use the BlockyDevs testnet endpoint (`api.testnet.blocky402.com`) if needed.

---

## Attribution — Reused vs. New

This is a fork of [`hedera-dev/x402-inference-pay-per-request-poc`](https://github.com/hedera-dev/x402-inference-pay-per-request-poc) built for the ETHOnline 2026 Hedera AI & Agentic Payments track. Per the track rules, this section states plainly what was reused unchanged and what was added.

**Reused from the base repo, unchanged:**
- All x402 payment plumbing — `packages/service/src/x402.ts` (resource server / facilitator wiring), the `paymentMiddleware` wiring pattern in `packages/service/src/server.ts`, and the entire `packages/agent/` package (x402 client, Hedera Agent Kit wrapping, chat UI, SSE status streaming).
- The four `/v1/{network}/{asset}/chat/completions` routes and the LM Studio proxy (`proxyToLMStudio`) they use.
- `scripts/associate-token.ts` (USDC token association).
- Overall project scaffolding: npm workspaces layout, `tsconfig.base.json`, `.env.example` structure, `SETUP.md`, `PRD.md`, CI/PR templates under `.github/`.

**New, added on top for this track submission:**
- `packages/shared/src/router.ts` + `router.test.ts` — the model-tier router and its unit tests.
- The three `/infer/{small-fast,default,large-capable}/chat/completions` x402-gated routes in `packages/service/src/server.ts`, and the accompanying `PAYMENT-RESPONSE` header decoding used to extract the tx reference.
- `packages/service/src/hcs.ts` — the HCS audit logger.
- `scripts/create-hcs-topic.ts` — one-time HCS topic creation.
- `scripts/smoke-test-infer.ts` — end-to-end router → x402 → LM Studio → HCS verification script.
- The **Model** toggle (Auto/Fast/Standard/Pro) in the chat UI (`packages/agent/public/index.html`) and its wiring in `packages/agent/src/server.ts` / `model.ts`.
- `packages/shared/` — new workspace package holding the router so both `service` and `agent` can import it without breaking `tsc`'s per-package `rootDir`.
- Switching the default testnet facilitator to Blocky402 (`X402_TESTNET_FACILITATOR_URL`) and the associated `.env.example` / README updates.

No payment plumbing, signing logic, or facilitator integration was rebuilt from scratch — the new pieces are additive (router, `/infer` routes, HCS logging) and reuse the base repo's existing `x402ResourceServer` / `paymentMiddleware` setup as-is.

## AI Usage Disclosure

This submission's new code (the router, the `/infer` routes, the HCS logger, the topic-creation and smoke-test scripts, and this README's new sections) was written with [Claude Code](https://claude.com/claude-code) (Anthropic), working from the track's requirements interactively with a human directing scope, reviewing diffs, and running tests. No part of the base repo (`hedera-dev/x402-inference-pay-per-request-poc`) was AI-generated as part of this submission — it was forked as-is; see [Attribution](#attribution--reused-vs-new) above for the exact boundary.

## References

- [x402 Protocol Specification v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
- [Hedera Exact Scheme Spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)
- [x402 on Hedera — Hedera Docs](https://docs.hedera.com/solutions/ai/x402)
- [x402.org Facilitator](https://docs.x402.org/core-concepts/facilitator)
- [BlockyDevs Facilitator](https://blocky402.com)
- [Hedera Agent Kit JS Quickstart](https://docs.hedera.com/solutions/ai/agent-kit/js/quickstart)
- [Vercel AI SDK — OpenAI Provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)
- [LM Studio OpenAI Compatibility](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)
