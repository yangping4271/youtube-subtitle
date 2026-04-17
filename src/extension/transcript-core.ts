/**
 * YouTube SubtitlePlus - 转录核心功能
 * 处理 YouTube 页面上的转录面板操作
 */

import type { VideoInfo } from '../types';
import { getVideoDescription, getAISummary } from './video-metadata.js';
import { normalizeSubtitleFetchErrorMessage } from './subtitle-fetch-log.js';
import {
  extractTranscriptSegmentData,
  resolveCaptionTrackText,
  findTranscriptTrigger,
  getTranscriptPanel,
  getTranscriptPanelState,
  getTranscriptSegmentElements,
  hasYouTubeLoginPrompt,
  isTranscriptReady,
  shouldForceLegacyTranscriptOpen,
} from './youtube-subtitle-fetch.js';

interface TranscriptSegment {
  timeStr: string;
  text: string;
}

interface YouTubeCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
}

declare const chrome: {
  runtime?: {
    id?: string;
    sendMessage?: (message: unknown) => Promise<unknown>;
  };
};

interface UserConfig {
  buttonIcons: {
    download: string;
    copy: string;
    translate: string;
  };
  fileNamingFormat: string;
  includeTimestamps: boolean;
  includeChapterHeaders: boolean;
  settingsGuide: boolean;
}

const USER_CONFIG: UserConfig = {
  buttonIcons: {
    download: '↓',
    copy: '📋',
    translate: '🚀',
  },
  fileNamingFormat: 'title-channel',
  includeTimestamps: true,
  includeChapterHeaders: true,
  settingsGuide: false,
};

function getWatchFlexyElement(): HTMLElement | null {
  return document.querySelector('ytd-watch-flexy');
}

function showNotification(message: string): void {
  const overlay = document.createElement('div');
  overlay.classList.add('YTSP-overlay');

  const modal = document.createElement('div');
  modal.classList.add('YTSP-notification');
  modal.textContent = message;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  setTimeout(() => overlay.remove(), 1000);
}

export function getVideoInfo(): VideoInfo {
  const watchFlexyElement = getWatchFlexyElement();
  if (!watchFlexyElement) {
    return {
      ytTitle: 'N/A',
      channelName: 'N/A',
      uploadDate: 'N/A',
      videoURL: window.location.href,
      videoId: '',
      description: '',
      aiSummary: null,
    };
  }

  const ytTitle =
    watchFlexyElement.querySelector('div#title h1 > yt-formatted-string')?.textContent?.trim() ||
    'N/A';
  const channelName =
    watchFlexyElement
      .querySelector('ytd-video-owner-renderer ytd-channel-name#channel-name yt-formatted-string#text a')
      ?.textContent?.trim() || 'N/A';
  const uploadDate =
    watchFlexyElement
      .querySelector('ytd-video-primary-info-renderer #info-strings yt-formatted-string')
      ?.textContent?.trim() || 'N/A';
  const videoURL = window.location.href;
  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get('v') || '';

  // 获取视频说明和 AI 摘要
  const description = getVideoDescription();
  const aiSummary = getAISummary();

  return { ytTitle, channelName, uploadDate, videoURL, videoId, description, aiSummary };
}

function parseTimeSeconds(timeStr: string): number {
  const parts = timeStr.split(':').map(Number);
  let seconds = 0;
  if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  }
  return seconds;
}

function formatTimeSRT(seconds: number): string {
  const date = new Date(0);
  date.setSeconds(seconds);
  const iso = date.toISOString().substring(11, 19);
  return `${iso},000`;
}

function getTranscriptSegments(): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  getTranscriptSegmentElements(document).forEach((element) => {
    const segmentData = extractTranscriptSegmentData(element);
    if (segmentData) {
      segments.push({
        timeStr: segmentData.timestampText,
        text: segmentData.bodyText.replace(/\s+/g, ' ').trim(),
      });
    }
  });

  return segments;
}

function getTranscriptTextOnly(): string {
  const lines: string[] = [];

  getTranscriptSegmentElements(document).forEach((element) => {
    if (element.tagName === 'YTD-TRANSCRIPT-SECTION-HEADER-RENDERER') {
      if (USER_CONFIG.includeChapterHeaders) {
        const chapterTitle = element.querySelector('h2 > span')?.textContent?.trim();
        if (chapterTitle) lines.push(`\nChapter: ${chapterTitle}`);
      }
      return;
    }

    const segmentData = extractTranscriptSegmentData(element);
    if (segmentData) {
      lines.push(segmentData.bodyText.replace(/\s+/g, ' ').trim());
    }
  });

  return lines.join('\n');
}

function getTranscriptUnavailableMessage(): string {
  if (hasYouTubeLoginPrompt(document)) {
    return 'YouTube 当前要求先登录以确认不是机器人，请登录后刷新页面再试。';
  }

  return '转写面板已打开，但字幕内容尚未加载完成，请稍后重试。';
}

function getTranscriptSegmentContainer(): Element | null {
  const watchFlexyElement = getWatchFlexyElement();
  if (!watchFlexyElement) return null;

  return watchFlexyElement.querySelector(
    'ytd-transcript-segment-list-renderer #segments-container'
  );
}

async function ensureTranscriptLoaded(): Promise<boolean> {
  if (isTranscriptReady(getTranscriptPanelState(document))) {
    return true;
  }

  if (!openTranscript()) {
    return false;
  }

  return waitForTranscriptContent();
}

async function getTranscriptTextFromCaptionTracks(videoId: string): Promise<{
  text: string;
  resolution: {
    source: 'page-player-response' | 'youtubei-player';
    fallbackReason?: string;
    trackLanguageCode?: string;
    trackKind?: string;
  };
}> {
  const resolution = await resolveCaptionTrackText(videoId);
  return {
    text: extractTranscriptTextFromXml(resolution.trackText),
    resolution,
  };
}

function logTranscriptCopyFetch(
  source: 'caption-tracks' | 'transcript-panel' | 'unavailable',
  subtitleCount: number,
  details: {
    strategy?: string;
    trackLanguageCode?: string;
    trackKind?: string;
    fallbackReason?: string;
    captionTrackError?: string;
    panelError?: string;
  } = {}
): void {
  if (!chrome.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
    return;
  }

  const { videoId, videoURL } = getVideoInfo();
  if (!videoId || !videoURL) {
    return;
  }

  void chrome.runtime.sendMessage({
    action: 'logSubtitleFetchSource',
    videoId,
    data: {
      source,
      subtitleCount,
      ...details,
    },
  }).catch((error: unknown) => {
    console.log('发送复制字幕来源日志失败:', error);
  });
}

function extractTranscriptTextFromXml(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('字幕 XML 解析失败');
  }

  const srv3Lines = Array.from(doc.querySelectorAll('p'))
    .map((segment) => {
      const textParts = Array.from(segment.querySelectorAll('s'))
        .map((part) => part.textContent || '')
        .join('');
      const rawText = textParts || segment.textContent || '';
      return rawText.replace(/\s+/g, ' ').trim();
    })
    .filter((line) => line.length > 0);

  if (srv3Lines.length > 0) {
    return srv3Lines.join('\n');
  }

  const timedTextLines = Array.from(doc.querySelectorAll('text'))
    .map((segment) => (segment.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);

  return timedTextLines.join('\n');
}
function getTranscriptSRT(): string {
  const segments = getTranscriptSegments();
  if (segments.length === 0) return '';

  let srtOutput = '';
  segments.forEach((seg, index) => {
    const startSeconds = parseTimeSeconds(seg.timeStr);
    let endSeconds = startSeconds + 5;

    if (index < segments.length - 1) {
      const nextStart = parseTimeSeconds(segments[index + 1].timeStr);
      if (nextStart > startSeconds) {
        endSeconds = nextStart;
      }
    }

    srtOutput += `${index + 1}\n`;
    srtOutput += `${formatTimeSRT(startSeconds)} --> ${formatTimeSRT(endSeconds)}\n`;
    srtOutput += `${seg.text}\n\n`;
  });

  return srtOutput;
}

function downloadTranscriptAsSRT(): void {
  const srtContent = getTranscriptSRT();
  if (!srtContent) {
    showNotification('字幕为空');
    return;
  }

  const { ytTitle, channelName, videoId } = getVideoInfo();
  const blob = new Blob([srtContent], { type: 'text/plain' });

  const sanitize = (str: string) => str.replace(/[<>:"/\\|?*]+/g, '');
  const fileName = `${sanitize(ytTitle)} - ${sanitize(channelName)}_${videoId}.srt`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showNotification('SRT 文件已下载');
}

async function copyTranscriptText(finalText: string): Promise<void> {
  const { ytTitle, channelName, uploadDate, videoURL } = getVideoInfo();
  const fullContent = `Information about the YouTube Video:\nTitle: ${ytTitle}\nChannel: ${channelName}\nUpload Date: ${uploadDate}\nURL: ${videoURL}\n\n\nYouTube Transcript:\n${finalText.trimStart()}`;

  try {
    await navigator.clipboard.writeText(fullContent);
    showNotification('字幕已复制');
  } catch (err) {
    console.error('Failed to copy: ', err);
    showNotification('复制失败');
  }
}

function waitForTranscriptContent(retries = 0): Promise<boolean> {
  const maxRetries = 20;
  const interval = 500;

  return new Promise((resolve) => {
    if (isTranscriptReady(getTranscriptPanelState(document))) {
      resolve(true);
    } else if (retries < maxRetries) {
      setTimeout(() => {
        void waitForTranscriptContent(retries + 1).then(resolve);
      }, interval);
    } else {
      resolve(false);
    }
  });
}

async function selectAndCopyTranscript(): Promise<void> {
  const { videoId } = getVideoInfo();
  let captionTrackError: Error | null = null;

  if (videoId) {
    try {
      const { text, resolution } = await getTranscriptTextFromCaptionTracks(videoId);
      if (text) {
        logTranscriptCopyFetch('caption-tracks', text.split('\n').filter(Boolean).length, {
          strategy: resolution.source,
          trackLanguageCode: resolution.trackLanguageCode,
          trackKind: resolution.trackKind,
          fallbackReason: resolution.fallbackReason
            ? normalizeSubtitleFetchErrorMessage(resolution.fallbackReason)
            : undefined,
        });
        await copyTranscriptText(text);
        return;
      }
    } catch (error) {
      captionTrackError = error instanceof Error ? error : new Error(String(error));
      console.log('通过字幕轨接口复制字幕失败，回退到 transcript 面板:', error);
    }
  }

  let finalText = getTranscriptTextOnly();
  if (!finalText) {
    const loaded = await ensureTranscriptLoaded();
    if (!loaded) {
      logTranscriptCopyFetch('unavailable', 0, {
        captionTrackError: captionTrackError
          ? normalizeSubtitleFetchErrorMessage(captionTrackError.message)
          : undefined,
      });
      showNotification(getTranscriptUnavailableMessage());
      return;
    }

    finalText = getTranscriptTextOnly();
  }

  if (!finalText) {
    logTranscriptCopyFetch('unavailable', 0, {
      captionTrackError: captionTrackError
        ? normalizeSubtitleFetchErrorMessage(captionTrackError.message)
        : undefined,
      panelError: normalizeSubtitleFetchErrorMessage(getTranscriptUnavailableMessage()),
    });
    showNotification(getTranscriptUnavailableMessage());
    return;
  }

  logTranscriptCopyFetch('transcript-panel', finalText.split('\n').filter(Boolean).length, {
    fallbackReason: captionTrackError
      ? normalizeSubtitleFetchErrorMessage(captionTrackError.message)
      : undefined,
  });
  await copyTranscriptText(finalText);
}

function openTranscript(): boolean {
  const transcriptButton = findTranscriptTrigger(document);

  if (transcriptButton) {
    (transcriptButton as HTMLButtonElement).click();
    const engagementPanel = getTranscriptPanel(document) as HTMLElement | null;
    if (shouldForceLegacyTranscriptOpen(true, !!engagementPanel)) {
      window.dispatchEvent(new CustomEvent('YTSP_OpenTranscript'));
    }
    return true;
  }

  const engagementPanel = getTranscriptPanel(document) as HTMLElement | null;

  if (shouldForceLegacyTranscriptOpen(false, !!engagementPanel)) {
    window.dispatchEvent(new CustomEvent('YTSP_OpenTranscript'));
    return true;
  }

  return false;
}

function handleTranscriptAction(callback: () => void): void {
  const watchFlexyElement = getWatchFlexyElement();
  if (!watchFlexyElement) return;

  const transcriptContainer = getTranscriptSegmentContainer();
  if (transcriptContainer && transcriptContainer.children.length > 0) {
    callback();
    return;
  }

  if (openTranscript()) {
    showNotification('正在打开文字记录...');
    waitForTranscript(callback);
  } else {
    alert('无法获取文字记录，请确保视频有字幕');
  }
}

function waitForTranscript(callback: () => void, retries = 0): void {
  const maxRetries = 20;
  const interval = 500;

  const transcriptContainer = getWatchFlexyElement()?.querySelector(
    'ytd-transcript-segment-list-renderer #segments-container'
  );

  if (transcriptContainer && transcriptContainer.children.length > 0) {
    callback();
  } else if (retries < maxRetries) {
    setTimeout(() => waitForTranscript(callback, retries + 1), interval);
  } else {
    showNotification('加载失败');
    alert('加载失败，请手动打开文字记录面板后重试');
  }
}

function handleDownloadClick(): void {
  handleTranscriptAction(downloadTranscriptAsSRT);
}

function handleCopyClick(): void {
  void selectAndCopyTranscript();
}

function handleTranslateClick(): void {
  triggerExtensionTranslation();
}

function triggerExtensionTranslation(): void {
  showNotification('正在启动翻译...');
  window.dispatchEvent(new CustomEvent('YTSP_StartTranslation'));
}

interface ButtonConfig {
  id: string;
  text: string;
  clickHandler: () => void;
  tooltip: string;
}

function buttonLocation(buttons: ButtonConfig[], callback?: () => void): void {
  const masthead = document.querySelector('#end');

  if (masthead) {
    buttons.forEach(({ id, text, clickHandler, tooltip }) => {
      if (document.getElementById(id)) return;

      const buttonWrapper = document.createElement('div');
      buttonWrapper.classList.add('YTSP-button-wrapper');

      const button = document.createElement('button');
      button.id = id;
      button.textContent = text;
      button.classList.add('YTSP-button-style');
      button.addEventListener('click', clickHandler);

      const tooltipDiv = document.createElement('div');
      tooltipDiv.textContent = tooltip;
      tooltipDiv.classList.add('YTSP-button-tooltip');

      const arrowDiv = document.createElement('div');
      arrowDiv.classList.add('YTSP-button-tooltip-arrow');
      tooltipDiv.appendChild(arrowDiv);

      let tooltipTimeout: ReturnType<typeof setTimeout>;
      button.addEventListener('mouseenter', () => {
        tooltipTimeout = setTimeout(() => {
          tooltipDiv.style.visibility = 'visible';
          tooltipDiv.style.opacity = '1';
        }, 700);
      });

      button.addEventListener('mouseleave', () => {
        clearTimeout(tooltipTimeout);
        tooltipDiv.style.visibility = 'hidden';
        tooltipDiv.style.opacity = '0';
      });

      buttonWrapper.appendChild(button);
      buttonWrapper.appendChild(tooltipDiv);
      masthead.prepend(buttonWrapper);
    });
  } else {
    const observer = new MutationObserver((_mutations, obs) => {
      const mastheadEl = document.querySelector('#end');
      if (mastheadEl) {
        obs.disconnect();
        if (callback) callback();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

function createButtons(): void {
  const buttonsToCreate: ButtonConfig[] = [
    {
      id: 'transcript-download-button',
      text: USER_CONFIG.buttonIcons.download,
      clickHandler: handleDownloadClick,
      tooltip: '下载字幕',
    },
    {
      id: 'transcript-copy-button',
      text: USER_CONFIG.buttonIcons.copy,
      clickHandler: handleCopyClick,
      tooltip: '复制字幕',
    },
    {
      id: 'transcript-translate-button',
      text: USER_CONFIG.buttonIcons.translate,
      clickHandler: handleTranslateClick,
      tooltip: '开始翻译',
    },
  ];

  buttonLocation(buttonsToCreate, () => createButtons());
}

function init(): void {
  createButtons();

  const observer = new MutationObserver(() => {
    if (!document.getElementById('transcript-download-button') && document.querySelector('#end')) {
      createButtons();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
    }
  }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
