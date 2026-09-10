/**
 * Router: picks the cheapest model tier capable of handling a prompt.
 * Plain if/then rules on prompt length and keywords — no ML, no training.
 */

export type ModelTier = 'small-fast' | 'default' | 'large-capable';

export interface ModelCatalogueEntry {
  tier: ModelTier;
  /** Logical tier label. The real provider + model behind each tier is resolved server-side
   *  (see packages/service/src/providers.ts) — kept out of this package since it's env-configured
   *  and this package must stay a pure, dependency-free function for easy unit testing. */
  model: string;
  /** USDC price, as accepted by the x402 `Money` price format. A demo price, not a literal
   *  pass-through of the real provider API cost behind the tier. */
  price: string;
  description: string;
}

export const MODEL_CATALOGUE: Record<ModelTier, ModelCatalogueEntry> = {
  'small-fast': {
    tier: 'small-fast',
    model: 'small-fast',
    price: '$0.0005',
    description: 'Short, simple prompts — greetings, one-line questions.',
  },
  default: {
    tier: 'default',
    model: 'default',
    price: '$0.001',
    description: 'General-purpose prompts of moderate length.',
  },
  'large-capable': {
    tier: 'large-capable',
    model: 'large-capable',
    price: '$0.002',
    description: 'Long prompts or requests for code, analysis, or detailed explanations.',
  },
};

const LARGE_KEYWORDS = [
  'code', 'debug', 'refactor', 'analyze', 'analysis',
  'detailed', 'summarize', 'write a', 'explain in detail',
];

const SMALL_MAX_LENGTH = 60;
const LARGE_MIN_LENGTH = 400;

/**
 * Selects a model tier for a given prompt.
 * Rules (checked in order): long or keyword-matched prompts -> large-capable;
 * short prompts -> small-fast; everything else -> default.
 */
export function selectModel(prompt: string): ModelCatalogueEntry {
  const trimmed = (prompt ?? '').trim();
  const lower = trimmed.toLowerCase();

  if (trimmed.length >= LARGE_MIN_LENGTH || LARGE_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return MODEL_CATALOGUE['large-capable'];
  }
  if (trimmed.length <= SMALL_MAX_LENGTH) {
    return MODEL_CATALOGUE['small-fast'];
  }
  return MODEL_CATALOGUE.default;
}
