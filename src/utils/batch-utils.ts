/**
 * 计算灵活的批次大小分配
 * 目标：每批15-25个字幕，避免最后一批太少
 */
export function calculateBatchSizes(
  totalCount: number,
  targetBatchSize: number = 20,
  minBatchSize: number = 15,
  maxBatchSize: number = 25
): number[] {
  if (totalCount <= 0) return [];
  if (totalCount <= targetBatchSize) return [totalCount];

  const batches: number[] = [];
  let remaining = totalCount;

  while (remaining > 0) {
    if (remaining <= maxBatchSize) {
      batches.push(remaining);
      break;
    } else if (remaining <= maxBatchSize + minBatchSize) {
      const batch1 = Math.ceil(remaining / 2);
      const batch2 = remaining - batch1;
      batches.push(batch1, batch2);
      break;
    } else {
      batches.push(targetBatchSize);
      remaining -= targetBatchSize;
    }
  }

  return batches;
}
