import { createOpenAI } from '@ai-sdk/openai';
import { AgentMode } from '@hashgraph/hedera-agent-kit';
import { HederaAIToolkit } from '@hashgraph/hedera-agent-kit-ai-sdk';
import { Client, PrivateKey } from '@hiero-ledger/sdk';
import { wrapLanguageModel, type LanguageModel } from 'ai';

// One toolkit per network, lazily initialised and shared across requests.
let _testnetToolkit: HederaAIToolkit | null = null;
let _mainnetToolkit: HederaAIToolkit | null = null;

function getToolkit(network: 'testnet' | 'mainnet'): HederaAIToolkit {
  if (network === 'mainnet') {
    if (_mainnetToolkit) return _mainnetToolkit;
    const accountId    = process.env.HEDERA_AGENT_MAINNET_ACCOUNT_ID ?? process.env.HEDERA_AGENT_ACCOUNT_ID!;
    const privateKeyStr = process.env.HEDERA_AGENT_MAINNET_PRIVATE_KEY ?? process.env.HEDERA_AGENT_PRIVATE_KEY!;
    _mainnetToolkit = new HederaAIToolkit({
      client: Client.forMainnet().setOperator(accountId, PrivateKey.fromStringECDSA(privateKeyStr)),
      configuration: { tools: [], plugins: [], context: { mode: AgentMode.AUTONOMOUS } },
    });
    return _mainnetToolkit;
  }

  if (_testnetToolkit) return _testnetToolkit;
  const accountId    = process.env.HEDERA_AGENT_ACCOUNT_ID!;
  const privateKeyStr = process.env.HEDERA_AGENT_PRIVATE_KEY!;
  _testnetToolkit = new HederaAIToolkit({
    client: Client.forTestnet().setOperator(accountId, PrivateKey.fromStringECDSA(privateKeyStr)),
    configuration: { tools: [], plugins: [], context: { mode: AgentMode.AUTONOMOUS } },
  });
  return _testnetToolkit;
}

// The service picks the real upstream model server-side (packages/service/src/providers.ts) —
// this value only fills the outgoing request body's "model" field, which the service ignores.
const PLACEHOLDER_MODEL_NAME = 'server-selected';

// Called per /api/chat request. Routes to /v1/{network}/{asset}/chat/completions on the service.
export function buildModelForRequest(
  fetchFn: typeof fetch,
  network: 'testnet' | 'mainnet',
  asset: string,
): LanguageModel {
  const serviceBase = (process.env.INFERENCE_SERVICE_URL ?? 'http://localhost:4021').replace(/\/v1\/?$/, '');
  const serviceUrl  = `${serviceBase}/v1/${network}/${asset.toLowerCase()}`;

  const openaiProvider = createOpenAI({ baseURL: serviceUrl, apiKey: 'x', fetch: fetchFn });

  return wrapLanguageModel({
    model: openaiProvider.chat(PLACEHOLDER_MODEL_NAME),
    middleware: getToolkit(network).middleware(),
  });
}

// Router-priced variant — routes to /infer/{tier}/chat/completions on the service.
// Testnet + USDC only (the tiered x402 routes aren't registered for mainnet/HBAR).
export function buildModelForTier(fetchFn: typeof fetch, tier: string): LanguageModel {
  const serviceBase = (process.env.INFERENCE_SERVICE_URL ?? 'http://localhost:4021').replace(/\/v1\/?$/, '');
  const serviceUrl  = `${serviceBase}/infer/${tier}`;

  const openaiProvider = createOpenAI({ baseURL: serviceUrl, apiKey: 'x', fetch: fetchFn });

  return wrapLanguageModel({
    model: openaiProvider.chat(PLACEHOLDER_MODEL_NAME),
    middleware: getToolkit('testnet').middleware(),
  });
}