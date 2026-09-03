import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(
    new URL('../../public/extension/manifest.json', import.meta.url),
    'utf8'
  )
) as {
  host_permissions?: string[];
  optional_host_permissions?: string[];
};

describe('manifest API permissions', () => {
  it('内置 API 使用固定 host permission，自定义 HTTPS API 保留可选权限', () => {
    expect(manifest.host_permissions).toEqual(expect.arrayContaining([
      'https://api.openai.com/*',
      'https://openrouter.ai/*',
      'https://api.deepseek.com/*',
    ]));
    expect(manifest.optional_host_permissions).toContain('https://*/*');
  });
});
