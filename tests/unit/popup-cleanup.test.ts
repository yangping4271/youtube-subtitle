import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '../..');
const popupHtml = readFileSync(
  resolve(projectRoot, 'public/extension/popup.html'),
  'utf8'
);
const popupScript = readFileSync(
  resolve(projectRoot, 'public/extension/popup.js'),
  'utf8'
);
const popupStyles = readFileSync(
  resolve(projectRoot, 'public/extension/popup.css'),
  'utf8'
);

describe('popup static wiring', () => {
  it('在 popup controller 之前加载统一 config implementation', () => {
    expect(popupHtml.indexOf('<script src="config.js"></script>')).toBeGreaterThan(-1);
    expect(popupHtml.indexOf('<script src="config.js"></script>')).toBeLessThan(
      popupHtml.indexOf('<script src="popup.js"></script>')
    );
  });

  it('翻译只通过 background translation interface 启动', () => {
    expect(popupScript).toContain("action: 'startTranslation'");
    expect(popupScript).not.toContain('translateSubtitlesWithProgress(');
    expect(popupScript).not.toContain('callTranslateApi(');
    expect(popupScript).not.toContain('translatorService');
    expect(popupHtml).not.toContain('<script src="translator.js"></script>');
  });

  it('不保留已经没有 DOM interface 的本地服务器配置实现', () => {
    expect(popupHtml).not.toMatch(
      /id="(?:autoLoadToggle|serverUrl|testServer|configPanel|configToggle)"/
    );
    expect(popupScript).not.toMatch(
      /loadAutoLoadSettings|checkServerStatus|testServerConnection|\/health/
    );
    expect(popupScript).not.toMatch(
      /getElementById\('(?:statusIcon|statusText|statusSubtext)'\)/
    );
    expect(popupStyles).not.toMatch(
      /\.(?:auto-load-card|server-status-card|config-panel|status-circle)\b/
    );
  });

  it('只保留一个当前视频状态初始化 implementation', () => {
    expect(popupScript.match(/initCurrentVideoState\(\)/g)).toHaveLength(2);
    expect(popupScript).not.toContain('initAutoLoadMode()');
  });

  it('API 配置只使用 config.js 提供的 normalization implementation', () => {
    expect(popupScript).toContain('window.SubtitleConfig.normalizeApiConfig');
    expect(popupScript).not.toContain('normalizeApiConfig(config = {})');
  });
});
