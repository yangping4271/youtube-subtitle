/** 并发配置的唯一归一化规则。 */
export const DEFAULT_CONCURRENCY = 6;

export function normalizeConcurrency(
  value: unknown,
  max?: number,
  fallback = DEFAULT_CONCURRENCY
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  const safeFallback = Number.isFinite(fallback) && fallback >= 1
    ? Math.floor(fallback)
    : DEFAULT_CONCURRENCY;
  const normalizedMax = Number.isFinite(max) && (max as number) >= 1
    ? Math.floor(max as number)
    : undefined;

  if (!Number.isFinite(parsed) || parsed < 1) {
    return normalizedMax === undefined
      ? safeFallback
      : Math.min(safeFallback, normalizedMax);
  }

  const normalized = Math.floor(parsed);
  return normalizedMax === undefined
    ? normalized
    : Math.min(normalized, normalizedMax);
}
