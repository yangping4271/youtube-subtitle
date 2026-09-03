import type { CancellationSignal } from '../utils/cancellation.js';

/**
 * 浏览器内容层的翻译 run 生命周期。
 * 事件是判别联合，避免把 runId、phase 和清理语义拆成可互相矛盾的可选字段。
 */
export type TranslationRunEvent =
  | { type: 'activate'; runId: string; generation: number }
  | { type: 'invalidate'; runId: string }
  | { type: 'reset' };

export interface TranslationRunPublication {
  runId: string;
  videoId?: string;
  signal: CancellationSignal;
}

export function isTranslationPublicationForVideo(
  publicationVideoId: string | undefined,
  currentVideoId: string | null
): boolean {
  return !publicationVideoId || publicationVideoId === currentVideoId;
}

export class TranslationRunGate {
  private activeRunId: string | null = null;
  private activeGeneration: number | null = null;
  private invalidatedRunId: string | null = null;

  /**
   * 应用生命周期事件，并返回调用方是否可以执行对应的清理动作。
   * 过期 run 的 invalidate 只拒绝事件，不影响当前 run。
   */
  apply(event: TranslationRunEvent): boolean {
    if (event.type === 'reset') {
      this.reset();
      return true;
    }

    if (event.type === 'activate') {
      if (this.activeGeneration !== null) {
        if (event.generation < this.activeGeneration) return false;
        if (event.generation === this.activeGeneration && event.runId !== this.activeRunId) {
          return false;
        }
      }

      this.activeRunId = event.runId;
      this.activeGeneration = event.generation;
      this.invalidatedRunId = null;
      return true;
    }

    if (this.activeRunId !== event.runId) {
      return false;
    }

    this.invalidatedRunId = event.runId;
    return true;
  }

  /** 判断带 run ID 的字幕发布消息是否仍属于当前有效 run。 */
  accepts(runId?: string): boolean {
    if (!runId) return true;

    if (!this.activeRunId) {
      this.activeRunId = runId;
      this.invalidatedRunId = null;
      return true;
    }

    return this.activeRunId === runId
      && this.invalidatedRunId !== runId;
  }

  reset(): void {
    this.activeRunId = null;
    this.activeGeneration = null;
    this.invalidatedRunId = null;
  }
}
