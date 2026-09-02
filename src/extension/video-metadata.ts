import { setupLogger } from '../utils/logger.js';

const logger = setupLogger('video-metadata');

export function getVideoDescription(): string {
  try {
    for (const selector of [
      '#description yt-attributed-string',
      '#description-inline-expander yt-attributed-string',
    ]) {
      const description = document.querySelector(selector)?.textContent?.trim();
      if (description) return description;
    }
    logger.warn('⚠️ 未找到视频说明');
  } catch (error) {
    logger.warn(`获取视频说明失败，继续使用无说明上下文: ${error}`);
  }
  return '';
}

export function getAISummary(): string | null {
  try {
    for (const renderer of Array.from(document.querySelectorAll('ytd-expandable-metadata-renderer'))) {
      const label = renderer
        .querySelector('#prominent-label-text, #expanded-title')
        ?.textContent?.trim().toLowerCase() || '';
      if (label.includes('ai') || label.includes('摘要') || label.includes('summary') || label.includes('generated')) {
        const content =
          renderer.querySelector('#collapsed-title yt-formatted-string')?.textContent?.trim()
          || renderer.querySelector('#content')?.textContent?.trim();
        if (content) return content;
      }
    }
    logger.info('ℹ️ 该视频没有 AI 生成的摘要');
  } catch (error) {
    logger.warn(`获取 AI 摘要失败，继续使用无摘要上下文: ${error}`);
  }
  return null;
}
