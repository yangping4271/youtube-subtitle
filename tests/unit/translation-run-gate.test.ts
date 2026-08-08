import { describe, expect, it } from 'vitest';

import {
  TranslationRunGate,
  type TranslationRunEvent,
} from '../../src/extension/translation-run-gate.js';

describe('TranslationRunGate', () => {
  it('旧 run 的 invalidate 事件不会清理当前 run', () => {
    const gate = new TranslationRunGate();

    expect(gate.apply({ type: 'activate', runId: 'run-a', generation: 1 })).toBe(true);
    expect(gate.apply({ type: 'activate', runId: 'run-b', generation: 2 })).toBe(true);

    const staleFailure: TranslationRunEvent = {
      type: 'invalidate',
      runId: 'run-a',
    };
    expect(gate.apply(staleFailure)).toBe(false);
    expect(gate.accepts('run-b')).toBe(true);
  });

  it('晚到的旧 activate 事件不会覆盖较新的 run', () => {
    const gate = new TranslationRunGate();

    expect(gate.apply({
      type: 'activate',
      runId: 'run-b',
      generation: 2,
    })).toBe(true);
    expect(gate.apply({
      type: 'activate',
      runId: 'run-a',
      generation: 1,
    })).toBe(false);
    expect(gate.accepts('run-b')).toBe(true);
    expect(gate.accepts('run-a')).toBe(false);
  });

  it('Service Worker 恢复同一个 run 时允许重新激活并清理旧 partial', () => {
    const gate = new TranslationRunGate();
    const activation: TranslationRunEvent = {
      type: 'activate',
      runId: 'run-a',
      generation: 1,
    };

    expect(gate.apply(activation)).toBe(true);
    expect(gate.apply(activation)).toBe(true);
    expect(gate.accepts('run-a')).toBe(true);
  });

  it('当前 run 的 invalidate 事件会拒绝后续 partial，并允许执行清理', () => {
    const gate = new TranslationRunGate();

    expect(gate.apply({ type: 'activate', runId: 'run-a', generation: 1 })).toBe(true);
    expect(gate.accepts('run-a')).toBe(true);
    expect(gate.apply({ type: 'invalidate', runId: 'run-a' })).toBe(true);
    expect(gate.accepts('run-a')).toBe(false);
  });

  it('没有 run ID 的显式 reset 会清空生命周期状态', () => {
    const gate = new TranslationRunGate();

    gate.apply({ type: 'activate', runId: 'run-a', generation: 1 });
    expect(gate.apply({ type: 'reset' })).toBe(true);
    expect(gate.accepts('run-b')).toBe(true);
  });
});
