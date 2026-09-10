import type { ModelTier } from '@x402-poc/shared';

export type Provider = 'anthropic' | 'openai';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface NormalizedChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [{ index: number; message: { role: 'assistant'; content: string }; finish_reason: string }];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// Demo cost guard: caps spend per x402-paid call regardless of prompt length, since the
// testnet payment amount ($0.0005–$0.002) is a demo price, not a real reflection of API cost.
const MAX_TOKENS = 512;

/**
 * Real model behind each router tier. Env-overridable, resolved at call time (not module load)
 * so it always sees values from a .env loaded by dotenv earlier in server startup.
 */
export function getModelForTier(tier: ModelTier): { provider: Provider; model: string } {
  switch (tier) {
    case 'small-fast':
      return { provider: 'openai', model: process.env.OPENAI_MODEL_SMALL ?? 'gpt-4o-mini' };
    case 'default':
      return { provider: 'anthropic', model: process.env.ANTHROPIC_MODEL_DEFAULT ?? 'claude-sonnet-5' };
    case 'large-capable':
      return { provider: 'anthropic', model: process.env.ANTHROPIC_MODEL_LARGE ?? 'claude-opus-5' };
  }
}

export async function callProvider(provider: Provider, model: string, messages: ChatMessage[]): Promise<NormalizedChatCompletion> {
  return provider === 'openai' ? callOpenAI(messages, model) : callAnthropic(messages, model);
}

async function callOpenAI(messages: ChatMessage[], model: string): Promise<NormalizedChatCompletion> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
  }

  // Chat Completions responses are already in the shape we normalize to.
  return (await res.json()) as NormalizedChatCompletion;
}

async function callAnthropic(messages: ChatMessage[], model: string): Promise<NormalizedChatCompletion> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const conversation = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: conversation,
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const text = (data.content ?? [])
    .filter((block: { type: string }) => block.type === 'text')
    .map((block: { text: string }) => block.text)
    .join('');

  return {
    id: data.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: data.stop_reason ?? 'stop' }],
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
  };
}
