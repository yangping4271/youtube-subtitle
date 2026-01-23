/**
 * YouTube 视频元数据获取
 * 获取视频说明和 AI 生成的摘要等元数据信息
 */

import { setupLogger } from '../utils/logger.js';

const logger = setupLogger('video-metadata');

/**
 * 获取视频说明
 * @returns 视频说明文本，如果不存在则返回空字符串
 */
export function getVideoDescription(): string {
    try {
        // 尝试多个可能的选择器（按优先级）
        const selectors = [
            // 展开后的描述
            '#description yt-attributed-string',
            '#description yt-attributed-string span',
            // 未expand的描述
            '#description-inline-expander yt-attributed-string',
            '#description-inline-expander yt-attributed-string span',
            'ytd-text-inline-expander #description-inline-expander yt-attributed-string',
            // 新版 YouTube 结构
            'ytd-watch-metadata #description yt-attributed-string',
            'ytd-watch-metadata #description-inline-expander yt-attributed-string',
        ];

        for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element?.textContent?.trim()) {
                const description = element.textContent.trim();
                return description;
            }
        }

        logger.warn('⚠️ 未找到视频说明');
        return '';
    } catch (error) {
        logger.error(`获取视频说明失败: ${error}`);
        return '';
    }
}

/**
 * 获取 AI 生成的摘要
 * @returns AI 摘要文本，如果不存在则返回 null
 */
export function getAISummary(): string | null {
    try {
        // 查找 AI 摘要渲染器
        const summaryRenderers = document.querySelectorAll('ytd-expandable-metadata-renderer');

        for (const renderer of Array.from(summaryRenderers)) {
            // 检查标签（label）是否包含 AI 摘要相关的关键词
            // 中文：折叠状态是 "摘要"，展开状态是 "AI 生成的视频摘要"
            // 英文：可能是 "AI-generated summary" 或 "Summary"
            const labelElement = renderer.querySelector('#prominent-label-text, #expanded-title');
            const labelText = labelElement?.textContent?.trim() || '';

            // 多语言支持：支持中文、英文等
            if (
                labelText.includes('AI') ||
                labelText.includes('摘要') ||
                labelText.toLowerCase().includes('summary') ||
                labelText.toLowerCase().includes('generated')
            ) {
                // 获取摘要内容 - 尝试多个位置
                let content = '';

                // 首选：collapsed-title 下的 yt-formatted-string（最可靠）
                const collapsedText = renderer.querySelector('#collapsed-title yt-formatted-string');
                if (collapsedText?.textContent?.trim()) {
                    content = collapsedText.textContent.trim();
                } else {
                    // 备选：直接从 #content 获取
                    const contentElement = renderer.querySelector('#content');
                    if (contentElement?.textContent?.trim()) {
                        content = contentElement.textContent.trim();
                    }
                }

                if (content) {
                    return content;
                }
            }
        }

        logger.info('ℹ️ 该视频没有 AI 生成的摘要');
        return null;
    } catch (error) {
        logger.error(`获取 AI 摘要失败: ${error}`);
        return null;
    }
}

/**
 * 获取所有视频元数据并输出到控制台（用于调试）
 */
export function debugVideoMetadata(): void {
    const description = getVideoDescription();
    const aiSummary = getAISummary();

    console.group('🎬 YouTube 视频元数据');
    console.log('📄 视频说明:');
    console.log(description || '(无)');
    console.log('');
    console.log('🤖 AI 摘要:');
    console.log(aiSummary || '(无)');
    console.groupEnd();
}

// 将调试函数暴露到全局，方便在控制台调用
if (typeof window !== 'undefined') {
    (window as any).debugVideoMetadata = debugVideoMetadata;
}
