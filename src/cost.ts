export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Takes precedence over pipeline pricing when set. */
  costUsd?: number;
  modelId?: string;
}

export interface TokenPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/**
 * Either one price for everything, a table keyed by model id (with an optional
 * `default`), or a function for anything more involved.
 */
export type Pricing =
  | TokenPrice
  | Record<string, TokenPrice>
  | ((usage: { modelId?: string; inputTokens: number; outputTokens: number }) => number);

export const MICROS_PER_USD = 1_000_000;

export function toMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

export function fromMicros(micros: number | string | bigint): number {
  return Number(micros) / MICROS_PER_USD;
}

function isTokenPrice(p: unknown): p is TokenPrice {
  return typeof p === 'object' && p !== null && 'inputPerMTok' in p && 'outputPerMTok' in p;
}

export function priceUsage(usage: Usage, pricing: Pricing | undefined): number {
  if (usage.costUsd !== undefined) return usage.costUsd;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (!pricing) return 0;
  if (typeof pricing === 'function') return pricing({ modelId: usage.modelId, inputTokens, outputTokens });

  const price = isTokenPrice(pricing)
    ? pricing
    : ((usage.modelId ? pricing[usage.modelId] : undefined) ?? pricing.default);
  if (!price) return 0;
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
}

/** Accumulates usage for one stage execution. */
export class UsageMeter {
  inputTokens = 0;
  outputTokens = 0;
  costMicros = 0;

  constructor(private readonly pricing: Pricing | undefined) {}

  add(usage: Usage): void {
    this.inputTokens += usage.inputTokens ?? 0;
    this.outputTokens += usage.outputTokens ?? 0;
    this.costMicros += toMicros(priceUsage(usage, this.pricing));
  }
}
