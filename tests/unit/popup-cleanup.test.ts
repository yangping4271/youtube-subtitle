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
const manifest = JSON.parse(readFileSync(
  resolve(projectRoot, 'public/extension/manifest.json'),
  'utf8'
));

describe('popup static wiring', () => {
  it('通过可选 host permission 支持运行时配置的第三方 API', () => {
    expect(manifest.optional_host_permissions).toContain('https://*/*');
    expect(manifest.host_permissions).not.toContain('https://api.krill-ai.net/*');
    expect(popupScript).toContain('chrome.permissions.request');
  });

  it('为 MV3 中断任务恢复声明 alarms 权限', () => {
    expect(manifest.permissions).toContain('alarms');
  });

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

  it('不把内部 start 状态原样显示给用户', () => {
    expect(popupScript).toContain("'start': '准备翻译...'");
    expect(popupScript).toContain("'resume': '恢复翻译中...'");
    expect(popupScript).toContain('Number.isFinite(progress.current)');
  });

  it('根据持久化完成状态显示翻译完成，而不是把空进度当成完成', () => {
    expect(popupScript).toContain('progress && progress.completed');
    expect(popupScript).toContain('newValue && newValue.completed');
    expect(popupScript).toContain('async showTranslationCompleted(options = {})');
    expect(popupScript).toContain("autoLoadStatus.textContent = '翻译完成!';");
    expect(popupScript).not.toContain('} else {\n                // 翻译完成');
  });

  it('API 配置只使用 config.js 提供的 normalization implementation', () => {
    expect(popupScript).toContain('window.SubtitleConfig.normalizeApiConfig');
    expect(popupScript).not.toContain('normalizeApiConfig(config = {})');
  });

  it('并发数使用可动态限制的数字输入，而不是固定范围滑块', () => {
    expect(popupHtml).toMatch(/type="number" id="threadNum"/);
    expect(popupHtml).not.toMatch(/id="threadNum"[^>]*max="2500"/);
    expect(popupHtml).not.toMatch(/type="range" id="threadNum"/);
    expect(popupScript).toContain('getModelConcurrencyLimit');
  });

  it('保持 API 配置界面简洁，并保护内置供应商', () => {
    expect(popupHtml).not.toContain('实际翻译请求：');
    expect(popupHtml).not.toContain('测试连接：');
    expect(popupScript).not.toContain('updateApiBaseUrlHint');
    expect(popupScript).toContain('isDefaultApiProviderId');
    expect(popupScript).toContain('内置配置不可删除');
    expect(popupScript).toContain('normalizeApiBaseUrl');
    expect(popupScript).toContain('formatApiResponseError');
    expect(popupScript).toContain('请选择模型');
    expect(popupScript).toContain('setApiProviderFieldMutability');
    expect(popupScript).toContain('自定义模型必须填写 API Base URL 和翻译模型');
    expect(popupScript).toContain("const lockedFieldIds = ['apiProviderName', 'apiBaseUrl'];");
    expect(popupScript).toContain("Toast.error('请填写翻译模型')");
    expect(popupScript).toContain("if (!this.isDefaultApiProvider(provider)) {");
    expect(popupScript).toContain('this.apiConfig.requiresProviderSelection = true;');
    expect(popupHtml).toMatch(/id="apiBaseUrl"[^>]*required/);
    expect(popupHtml).toMatch(/id="llmModel"[^>]*required/);
  });

  it('支持兼容 API，且不显示额外说明或迁移提示', () => {
    expect(manifest.host_permissions).toContain('http://127.0.0.1/*');
    expect(manifest.optional_host_permissions).toContain('http://localhost/*');
    expect(popupHtml).not.toContain('仅支持远程 HTTPS API');
    expect(popupHtml).not.toContain('配置说明');
    expect(popupScript).not.toContain('apiConfigMigrationNotice');
    expect(popupScript).toContain('window.SubtitleConfig.migrateApiConfig');
    expect(popupScript).toContain('this.apiConfig.requiresProviderSelection = false;');
    expect(popupScript).toContain('async persistApiConfig()');
    expect(popupScript).toContain('await this.persistApiConfig();');
  });
});
