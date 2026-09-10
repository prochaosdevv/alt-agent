# PRD: x402-Paid Local LLM Inference PoC with Hedera Agent Kit

## 1. Executive Summary

Build a minimal proof-of-concept (PoC) where a **Hedera Agent Kit** chat agent pays for every inference request using the **x402** protocol on **Hedera testnet** (USDC). The agent has its own ECDSA wallet, calls a custom **OpenAI-compatible `/chat/completions` service** running locally, and the service gates each request with an x402 payment before proxying to a **local model served by LM Studio**. The official **x402.org facilitator** handles verification and settlement.

This document synthesizes the integration points for x402, Hedera, the Agent Kit, LM Studio, and OpenAI-compatible inference, using **Venice AI's x402 pattern** as a reference.

---

## 2. Goals

- A simple chat interface built with **Hedera Agent Kit** and **Vercel AI SDK**.
- The agent owns an **ECDSA Hedera wallet** and pays **$0.01 (1 USDC cent)** per inference request.
- Payments settle on **Hedera testnet** using the **x402 `exact` scheme** and **USDC token `0.0.429274`**.
- Use the **official x402.org facilitator** (`https://x402.org/facilitator`) for verification/settlement.
- A custom **Express service** exposes an OpenAI-compatible `POST /v1/chat/completions` endpoint.
- The service proxies inference to a **local LM Studio server** at `http://localhost:1234/v1`.
- The service only grants access after the x402 payment is verified/settled.

---

## 3. Non-Goals

- Mainnet deployment or production-grade security.
- Persistent chat history beyond the in-memory session.
- Multi-tenant wallets, top-up balances, or refund flows.
- Per-token metering; price is a flat per-request fee.

---

## 4. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  User (CLI / Web)                                                   │
└──────────────────┬──────────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Agent App (Hedera Agent Kit + Vercel AI SDK)                       │
│  - ECDSA Hedera wallet (payer)                                      │
│  - x402 fetch wrapper (`wrapFetchWithPayment`)                      │
│  - `createOpenAI` pointed at custom service                         │
└──────────────────┬──────────────────────────────────────────────────┘
                   │  POST /v1/chat/completions (+ x402 payment)
                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Custom Inference Service (Express + @x402/express)                 │
│  - x402 payment middleware on `/v1/chat/completions`                │
│  - verifies payment via x402.org facilitator                        │
│  - proxies to LM Studio OpenAI-compatible endpoint                  │
└──────────────────┬──────────────────────────────────────────────────┘
                   │  POST /v1/chat/completions
                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  LM Studio (local server)                                           │
│  - OpenAI-compatible endpoint at `http://localhost:1234/v1`         │
└─────────────────────────────────────────────────────────────────────┘

External: x402.org Facilitator ──▶ Hedera Testnet (USDC / HBAR)
```

---

## 5. Integration Points

### 5.1 x402 Protocol on Hedera

- **Protocol**: x402 v2 uses HTTP `402 Payment Required` and headers `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`.
- **Hedera scheme**: `exact` (one exact amount per request).
- **Network**: `hedera:testnet` (CAIP-2).
- **USDC token ID**: `0.0.429274` (6 decimals, official Circle testnet USDC).
- **HBAR asset**: `0.0.0` (native HBAR, not used for this PoC).
- **Facilitator fee payer** (advertised by `https://x402.org/facilitator/supported`):
  - `0.0.9185802` for `hedera:testnet`
  - Confirmed live: the `/supported` endpoint returns `{"network":"hedera:testnet","extra":{"feePayer":"0.0.9185802"}}`.
- **Amount**: `$0.01` = `10000` USDC base units (6 decimals).
- **Payment flow**:
  1. Client calls protected endpoint.
  2. Server returns `402` with `PAYMENT-REQUIRED` header containing `PaymentRequirements`.
  3. Client creates a partially-signed Hedera `TransferTransaction`.
  4. Client sets `transactionId.accountId` to the facilitator's `feePayer`.
  5. Client signs the transaction and base64-encodes it as `PAYMENT-SIGNATURE`.
  6. Server forwards payload to facilitator `/verify` and then `/settle`.
  7. Facilitator co-signs as fee payer, submits to Hedera, returns `SettlementResponse`.
  8. Server grants access.

### 5.2 x402.org Facilitator

- **URL**: `https://x402.org/facilitator`
- **Endpoints**: `GET /supported`, `POST /verify`, `POST /settle`
- **Use**: testnet only; no API key required.
- The service's `HTTPFacilitatorClient` points to this URL.
- Reference check: `curl https://x402.org/facilitator/supported` returns `hedera:testnet` with fee payer `0.0.9185802`.

### 5.3 Hedera Agent Kit

- **Package scope**: `@hashgraph` (v4 monorepo).
- **Core packages**:
  - `@hashgraph/hedera-agent-kit`
  - `@hashgraph/hedera-agent-kit-ai-sdk` (Vercel AI SDK)
  - `@hiero-ledger/sdk`
- **Agent setup**:
  - `Client.forTestnet().setOperator(accountId, PrivateKey.fromStringECDSA(...))`
  - `HederaAIToolkit` with `AgentMode.AUTONOMOUS`.
  - `wrapLanguageModel` to inject Hedera middleware.
- **Wallet**: The agent uses an **ECDSA** Hedera account (required for `@x402/hedera` signing; the `createClientHederaSigner` expects ECDSA).

### 5.4 Vercel AI SDK + OpenAI-Compatible Provider

- **Packages**: `ai`, `@ai-sdk/openai`.
- **Pattern**: Create a custom OpenAI provider with `createOpenAI`:
  - `baseURL` = `http://localhost:4021/v1` (custom service)
  - `apiKey` = dummy token (e.g., `x`)
  - `fetch` = `wrapFetchWithPayment(globalThis.fetch, x402Client)`
- **Model factory**: Use `openaiProvider.chat('local-model')` because the custom endpoint supports Chat Completions, not the Responses API.
- **Generation**: `generateText` for non-streaming; `streamText` for streaming.

### 5.5 Custom OpenAI-Compatible Service

- **Framework**: Express.js with `@x402/express` middleware.
- **Route**: `POST /v1/chat/completions`
- **Payment config**:
  - `scheme: "exact"`
  - `price: "$0.01"`
  - `network: "hedera:testnet"`
  - `payTo`: service's Hedera account ID
  - `asset`: `0.0.429274` (default from `@x402/hedera` server scheme for testnet)
- **Handler**:
  1. Read request body.
  2. Forward `POST /v1/chat/completions` to `http://localhost:1234/v1/chat/completions`.
  3. For `stream: true`, pipe Server-Sent Events (SSE) through.
  4. For non-streaming, proxy the JSON response.
- **x402 behavior**: The middleware verifies the payment before the handler and settles after the handler completes successfully (status < 400).

### 5.6 LM Studio Local Server

- **Install**: [lmstudio.ai](https://lmstudio.ai)
- **CLI**: `lms server start` or GUI Developer tab → Start Server.
- **Default port**: `1234`
- **Endpoint**: `POST /v1/chat/completions` (OpenAI-compatible)
- **Model**: Any chat-tuned GGUF (e.g., a local Qwen, Llama, or Mistral model).
- **CORS**: Enable if the service is called from a browser frontend.
- The custom service uses LM Studio as an **upstream provider** exactly like Venice uses its model fleet.

### 5.7 Venice AI Reference Pattern

- Venice uses x402 with:
  - `X-Sign-In-With-X` header for wallet-based auth.
  - `/x402/top-up` to add prepaid USDC credits.
  - Then calls `/chat/completions` and consumes from the balance.
- **PoC simplification**: Skip the top-up/balance layer and use **per-request `exact` payments** directly on the `/chat/completions` route. The agent's wallet pays the service for each request; the service has no prepaid balance.

---

## 6. Tech Stack

| Layer | Package / Tool |
|-------|----------------|
| Agent | `ai`, `@ai-sdk/openai`, `@hashgraph/hedera-agent-kit`, `@hashgraph/hedera-agent-kit-ai-sdk`, `@hiero-ledger/sdk` |
| x402 client | `@x402/core`, `@x402/hedera`, `@x402/fetch` |
| x402 server | `@x402/express`, `@x402/hedera` |
| Inference proxy | `express` |
| Local LLM | LM Studio (desktop app or `lms` CLI) |
| Network | Hedera Testnet |
| Facilitator | `https://x402.org/facilitator` |

---

## 7. Detailed Data Flow

### 7.1 Happy Path (Non-Streaming)

1. User sends a message to the agent chat loop.
2. Agent appends the message to `conversationHistory`.
3. Agent calls `generateText({ model, messages, tools })`.
4. Vercel AI SDK sends `POST http://localhost:4021/v1/chat/completions` via the wrapped `fetch`.
5. Custom service **x402 middleware** intercepts the request and returns `402` with `PAYMENT-REQUIRED` header.
6. `wrapFetchWithPayment` parses the header, invokes `x402Client.createPaymentPayload`.
7. `@x402/hedera` builds a `TransferTransaction` of `10000` USDC units from the agent to the service `payTo` account, sets `transactionId.accountId` to facilitator `0.0.9185802`, and signs it.
8. Wrapped `fetch` retries the request with `PAYMENT-SIGNATURE` header containing the base64 transaction.
9. Service calls facilitator `/verify` to validate the transaction.
10. Service executes the handler: forwards the body to `http://localhost:1234/v1/chat/completions`.
11. Service calls facilitator `/settle` after the response is sent successfully.
12. Facilitator co-signs and submits the transfer to Hedera testnet.
13. Service returns the LM Studio JSON response to the agent.
14. Agent displays the assistant response.

### 7.2 Streaming Path

- Same as above, but the request body contains `stream: true`.
- The `wrapFetchWithPayment` returns the `Response` object without consuming the body when status is `200`, allowing the Vercel AI SDK to read the SSE stream.
- The service handler sets `Content-Type: text/event-stream; charset=utf-8` and pipes the LM Studio SSE stream directly to the client.

---

## 8. API Specifications

### 8.1 x402 `PaymentRequirements` (server-to-client)

```json
{
  "scheme": "exact",
  "network": "hedera:testnet",
  "amount": "10000",
  "asset": "0.0.429274",
  "payTo": "0.0.<service-account>",
  "maxTimeoutSeconds": 300,
  "extra": {
    "feePayer": "0.0.9185802"
  }
}
```

### 8.2 x402 `PaymentPayload` (client-to-server)

```json
{
  "x402Version": 2,
  "resource": {
    "url": "http://localhost:4021/v1/chat/completions",
    "description": "LLM inference",
    "mimeType": "application/json"
  },
  "accepted": { ...PaymentRequirements... },
  "payload": {
    "transaction": "<base64-partially-signed-TransferTransaction>"
  }
}
```

### 8.3 OpenAI `POST /v1/chat/completions` (Request)

```json
{
  "model": "local-model",
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "stream": false,
  "temperature": 0.7
}
```

### 8.4 OpenAI `POST /v1/chat/completions` (Non-Streaming Response)

```json
{
  "id": "chatcmpl-local-1",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "local-model",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello!" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 1,
    "completion_tokens": 2,
    "total_tokens": 3
  }
}
```

### 8.5 Streaming Response

SSE chunks:

```
data: {"id":"chatcmpl-local-1","object":"chat.completion.chunk","created":1700000000,"model":"local-model","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: [DONE]
```

---

## 9. Implementation Details

### 9.1 Agent x402 Client Setup

```typescript
import { x402Client } from '@x402/core/client';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createClientHederaSigner } from '@x402/hedera';
import { wrapFetchWithPayment } from '@x402/fetch';
import { PrivateKey } from '@hiero-ledger/sdk';

const signer = createClientHederaSigner(
  process.env.HEDERA_AGENT_ACCOUNT_ID!,
  PrivateKey.fromStringECDSA(process.env.HEDERA_AGENT_PRIVATE_KEY!),
  { network: 'hedera:testnet' },
);

const x402Client = new x402Client().register(
  'hedera:*',
  new ExactHederaScheme(signer),
);

const fetchWithPayment = wrapFetchWithPayment(fetch, x402Client);
```

### 9.2 Agent AI SDK Model

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { HederaAIToolkit, AgentMode } from '@hashgraph/hedera-agent-kit';
import { Client, PrivateKey } from '@hiero-ledger/sdk';
import { wrapLanguageModel } from 'ai';

const hederaClient = Client.forTestnet().setOperator(
  process.env.HEDERA_AGENT_ACCOUNT_ID!,
  PrivateKey.fromStringECDSA(process.env.HEDERA_AGENT_PRIVATE_KEY!),
);

const customOpenAI = createOpenAI({
  baseURL: 'http://localhost:4021/v1',
  apiKey: 'x',
  fetch: fetchWithPayment,
});

// For a simple chat, pass an empty tool list; add Hedera tools if you want
// the agent to perform on-chain actions in addition to chat.
const hederaToolkit = new HederaAIToolkit({
  client: hederaClient,
  configuration: {
    tools: [],
    plugins: [],
    context: { mode: AgentMode.AUTONOMOUS },
  },
});

const model = wrapLanguageModel({
  model: customOpenAI.chat('local-model'),
  middleware: hederaToolkit.middleware(),
});
```

### 9.3 Custom Inference Service

```typescript
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

const app = express();
app.use(express.json({ limit: '10mb' }));

const facilitatorClient = new HTTPFacilitatorClient({
  url: 'https://x402.org/facilitator',
});

const resourceServer = new x402ResourceServer(facilitatorClient).register(
  'hedera:*',
  new ExactHederaScheme({
    defaultAssets: {
      'hedera:testnet': { asset: '0.0.429274', decimals: 6 },
    },
  }),
);

app.use(
  paymentMiddleware(
    {
      'POST /v1/chat/completions': {
        accepts: [
          {
            scheme: 'exact',
            price: '$0.01',
            network: 'hedera:testnet',
            payTo: process.env.HEDERA_SERVICE_ACCOUNT_ID!,
          },
        ],
        description: 'LLM inference',
        mimeType: 'application/json',
      },
    },
    resourceServer,
  ),
);

app.post('/v1/chat/completions', async (req, res) => {
  const lmStudioResponse = await fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  });

  res.status(lmStudioResponse.status);
  lmStudioResponse.headers.forEach((value, key) => res.setHeader(key, value));

  if (req.body.stream) {
    // stream the response body
    const reader = lmStudioResponse.body!.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    };
    pump();
  } else {
    const json = await lmStudioResponse.json();
    res.json(json);
  }
});

app.listen(4021);
```

### 9.4 Chat Loop

```typescript
import { generateText, streamText } from 'ai';

const history: { role: 'user' | 'assistant'; content: string }[] = [];

while (true) {
  const userInput = await prompt('You: ');
  if (userInput === 'exit') break;
  history.push({ role: 'user', content: userInput });

  // Non-streaming
  const result = await generateText({
    model,
    messages: history,
  });

  // // Streaming alternative
  // const result = await streamText({
  //   model,
  //   messages: history,
  // });
  // for await (const chunk of result.textStream) {
  //   process.stdout.write(chunk);
  // }

  console.log('Assistant:', result.text);
  history.push({ role: 'assistant', content: result.text });
}
```

---

## 10. Environment & Wallet Setup

### 10.1 Agent Wallet

1. Create an **ECDSA** Hedera testnet account on the [Hedera Developer Portal](https://portal.hedera.com) or use the anonymous faucet.
2. Fund with testnet HBAR via the portal faucet or [Hedera Testnet Faucet](https://docs.hedera.com/hedera/getting-started-evm-developers/hedera-testnet-faucet).
3. **Associate USDC token `0.0.429274`** with the account (use a `TokenAssociateTransaction` or a wallet UI).
4. Request testnet USDC from the [Circle Testnet Faucet](https://faucet.circle.com) selecting **Hedera Testnet**.

### 10.2 Service Wallet

1. Create a second **ECDSA** Hedera testnet account.
2. Fund with testnet HBAR.
3. **Associate USDC `0.0.429274`** so the service can receive the paid amount.
4. Use this account ID as `HEDERA_SERVICE_ACCOUNT_ID` / `payTo`.

> **Note**: The x402 facilitator preflight checks that `payTo` is associated with the token or has an available auto-association slot. Otherwise, the facilitator will reject the payment with `pay_to_not_associated`.

### 10.3 Environment Variables

```env
# Agent
HEDERA_AGENT_ACCOUNT_ID=0.0.xxxx
HEDERA_AGENT_PRIVATE_KEY=0x...

# Service
HEDERA_SERVICE_ACCOUNT_ID=0.0.yyyy
HEDERA_SERVICE_PRIVATE_KEY=0x...   # optional, for service setup transactions
PORT=4021

# Infrastructure
X402_FACILITATOR_URL=https://x402.org/facilitator
LM_STUDIO_BASE_URL=http://localhost:1234/v1
```

---

## 11. Testing Plan

| Test | Steps | Expected Result |
|------|-------|-----------------|
| Facilitator discovery | `curl https://x402.org/facilitator/supported` | Contains `hedera:testnet` with `feePayer: 0.0.9185802` |
| Agent x402 payment | Call service without payment header | `402` with `PAYMENT-REQUIRED` |
| Successful inference | Agent sends chat message | Agent pays 1 USDC cent and receives assistant reply |
| Streaming inference | Request with `stream: true` | SSE stream returned, payment settled after successful response |
| Insufficient balance | Agent wallet with zero USDC | Facilitator preflight returns `insufficient_balance` |
| Token not associated | `payTo` not associated | Facilitator returns `pay_to_not_associated` |
| LM Studio health | `curl http://localhost:1234/v1/models` | Returns the loaded model |

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `@x402/hedera` requires token association on both sides. | Document and script the `TokenAssociateTransaction` for both wallets. |
| Streaming + x402 middleware may double-read response bodies. | Use `wrapFetchWithPayment` only on `fetch` calls; it returns raw `Response` for `200`, preserving the stream. |
| LM Studio model must be loaded before inference. | Add `/v1/models` check at startup and fail fast with a clear message. |
| Hedera Agent Kit's default middleware may intercept tool calls. | Keep `tools: []` or only load tools relevant to the PoC; the model is the custom local LLM. |
| `createOpenAI` default factory uses Responses API. | Use `customOpenAI.chat('model-id')` for Chat Completions compatibility. |
| x402.org facilitator is testnet only. | Scope the PoC to testnet; document mainnet facilitator options for future. |

---

## 13. Open Questions / Next Steps

1. Should the PoC include a minimal web UI, or is a CLI chat loop sufficient?
2. Should the service support the `x402` payment **only** on the chat endpoint, or also expose `/x402/top-up` like Venice?
3. Do we need to persist the `SettlementResponse` for the agent to track spend, or is console logging enough?
4. Should we use `HederaAIToolkit` with an empty tool list, or integrate a custom "pay for inference" tool to make the payment flow explicit to the agent?

---

## 14. References

- [x402 Protocol Spec](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
- [Hedera Exact Scheme Spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md)
- [x402 Payment Standard on Hedera](https://docs.hedera.com/solutions/ai/x402)
- [x402.org Facilitator](https://docs.x402.org/core-concepts/facilitator)
- [x402 Networks & Token Support](https://docs.x402.org/core-concepts/network-and-token-support)
- [Hedera Agent Kit JS Quickstart](https://docs.hedera.com/solutions/ai/agent-kit/js/quickstart)
- [Venice AI X402 Docs](https://docs.venice.ai/guides/integrations/x402-venice-api)
- [LM Studio OpenAI Compatibility](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)
- [hedera-dev/x402-hedera reference repo](https://github.com/hedera-dev/x402-hedera)
- [Vercel AI SDK OpenAI Provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)
