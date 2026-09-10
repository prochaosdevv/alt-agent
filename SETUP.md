# Setup Guide

This guide walks through all prerequisites before running the PoC.

---

## Prerequisites

- **Node.js 20+** — check with `node -v`
- **LM Studio** — download from [lmstudio.ai](https://lmstudio.ai)
- **Two Hedera testnet accounts** (ECDSA, one for the agent, one for the service)

---

## 1. LM Studio — Local LLM

1. Install [LM Studio](https://lmstudio.ai).
2. Download a chat-tuned model (e.g. **Qwen 2.5 7B Instruct**, **Llama 3.1 8B**, or similar GGUF).
3. Start the local server:
   - GUI: **Developer** tab → **Start Server** (port 1234)
   - CLI: `lms server start`
4. Note the **exact model name** shown in the LM Studio UI — you'll need it for `LM_STUDIO_MODEL`.

Verify it's running:
```bash
curl http://localhost:1234/v1/models
```

---

## 2. Hedera Testnet Accounts

You need **two separate ECDSA accounts** — one for the agent (payer) and one for the service (receiver).

### 2a. Create accounts

1. Go to [portal.hedera.com](https://portal.hedera.com) → **Create Account**
2. Select **ECDSA** key type (required for x402 signing)
3. Save the **Account ID** (format: `0.0.XXXXX`) and **private key** (hex-encoded)
4. Repeat for the second account

> **Alternatively**, use the Hedera CLI or any wallet that exports raw ECDSA private keys.

### 2b. Fund with testnet HBAR

Both accounts need HBAR for transaction fees:
- [Hedera Faucet](https://faucet.hedera.com) — pastes your account ID, receive test HBAR

---

## 3. Associate USDC Token

The x402 facilitator requires both accounts to be **associated** with USDC token `0.0.429274` before payments can flow.

First install dependencies:
```bash
npm install
```

Then associate for the **agent wallet** (the one that pays):
```bash
HEDERA_ACCOUNT_ID=0.0.AGENT_ID HEDERA_PRIVATE_KEY=0x... npm run associate -w scripts
```

And for the **service wallet** (the one that receives):
```bash
HEDERA_ACCOUNT_ID=0.0.SERVICE_ID HEDERA_PRIVATE_KEY=0x... npm run associate -w scripts
```

Or, if you've already filled in `.env`, the script will read from there (using `HEDERA_AGENT_ACCOUNT_ID` / `HEDERA_AGENT_PRIVATE_KEY` as defaults).

---

## 4. Get Testnet USDC

Fund the **agent wallet** with testnet USDC:

1. Go to [faucet.circle.com](https://faucet.circle.com)
2. Select **Hedera Testnet**
3. Enter the agent's **Account ID** (e.g. `0.0.12345`)
4. Request USDC

The agent wallet needs at least a few USDC cents to pay for inference.

---

## 5. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Agent wallet (pays $0.01 USDC per inference request)
HEDERA_AGENT_ACCOUNT_ID=0.0.XXXXX
HEDERA_AGENT_PRIVATE_KEY=0x...

# Service wallet (receives payments)
HEDERA_SERVICE_ACCOUNT_ID=0.0.YYYYY
HEDERA_SERVICE_PRIVATE_KEY=0x...   # only needed for the associate script

# LM Studio model name (as shown in LM Studio UI)
LM_STUDIO_MODEL=your-model-name-here
```

---

## 6. Run the Application

Start both servers:
```bash
npm run dev
```

This starts:
- **Inference service** on `http://localhost:4021` (x402-gated proxy to LM Studio)
- **Agent UI server** on `http://localhost:3001` (serves the chat UI)

Open **http://localhost:3001** in your browser to start chatting.

---

## Architecture Recap

```
Browser (Chat UI)
    │ POST /api/chat
    ▼
Agent Server (port 3001)
    │ POST /v1/chat/completions + PAYMENT-SIGNATURE header
    ▼
Inference Service (port 4021)  ←── x402 verifies via x402.org/facilitator
    │ POST /v1/chat/completions
    ▼
LM Studio (port 1234)
```

Each inference request:
1. Agent server's x402 client intercepts the 402 response from the inference service
2. Signs a Hedera `TransferTransaction` of **10,000 USDC base units ($0.01)** from agent → service
3. Facilitator at `https://x402.org/facilitator` verifies and settles on Hedera testnet
4. Inference service proxies the request to LM Studio and returns the response

---

## Smoke Tests

```bash
# Inference service returns 402 without payment
curl -X POST http://localhost:4021/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local-model","messages":[{"role":"user","content":"hello"}]}'
# Expected: 402 Payment Required

# Facilitator discovery (external)
curl https://x402.org/facilitator/supported
# Expected: contains hedera:testnet with feePayer: 0.0.9185802
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `✗ LM Studio not reachable` | Start LM Studio server and load a model |
| `HEDERA_SERVICE_ACCOUNT_ID is required` | Check `.env` is populated |
| `pay_to_not_associated` from facilitator | Run the token-association script for the service wallet |
| `insufficient_balance` from facilitator | Top up agent wallet USDC via Circle faucet |
| `PrivateKey.fromStringECDSA` error | Ensure private key is hex-encoded ECDSA (not ED25519) |
