/**
 * YouTube SubtitlePlus - 转录核心功能
 * 处理 YouTube 页面上的转录面板操作
 */

import type { SimpleSubtitleEntry, VideoInfo } from '../types';
import { buildPlainTextTranscript } from '../core/transcript-text.js';
import { extractErrorMessage } from '../utils/error-handler.js';
import { getVideoDescription, getAISummary } from './video-metadata.js';
import { acquireYouTubeSubtitles } from './youtube-subtitle-fetch.js';

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
  const watchFlexyElement = document.querySelector<HTMLElement>('ytd-watch-flexy');
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

function formatTimeSRT(seconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(wholeSeconds).padStart(2, '0'),
  ].join(':') + `,${String(milliseconds).padStart(3, '0')}`;
}

function buildSRTFromSubtitles(subtitles: SimpleSubtitleEntry[]): string {
  if (subtitles.length === 0) {
    return '';
  }

  return subtitles.map((subtitle, index) => {
    return `${index + 1}\n${formatTimeSRT(subtitle.startTime)} --> ${formatTimeSRT(subtitle.endTime)}\n${subtitle.text}`;
  }).join('\n\n') + '\n\n';
}

async function downloadTranscriptAsSRT(): Promise<void> {
  const { ytTitle, channelName, videoId } = getVideoInfo();
  if (!videoId) {
    showNotification('无法获取视频ID');
    return;
  }

  let subtitleEntries: SimpleSubtitleEntry[];
  try {
    subtitleEntries = (await acquireYouTubeSubtitles(videoId)).subtitles;
  } catch (error) {
    showNotification(extractErrorMessage(error) || '无法获取字幕');
    return;
  }

  const srtContent = buildSRTFromSubtitles(subtitleEntries);
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
  } catch {
    showNotification('复制失败');
  }
}

async function selectAndCopyTranscript(): Promise<void> {
  const { videoId } = getVideoInfo();
  if (!videoId) {
    showNotification('无法获取视频ID');
    return;
  }

  let finalText: string;
  try {
    const result = await acquireYouTubeSubtitles(videoId);
    finalText = buildPlainTextTranscript(result.subtitles);
  } catch (error) {
    showNotification(extractErrorMessage(error) || '无法获取字幕');
    return;
  }

  await copyTranscriptText(finalText);
}

interface ButtonConfig {
  id: string;
  text: string;
  clickHandler: () => void;
  tooltip: string;
}

const BUTTONS: ButtonConfig[] = [
  {
    id: 'transcript-download-button',
    text: '↓',
    clickHandler: () => void downloadTranscriptAsSRT(),
    tooltip: '下载字幕',
  },
  {
    id: 'transcript-copy-button',
    text: '📋',
    clickHandler: () => void selectAndCopyTranscript(),
    tooltip: '复制字幕',
  },
];

function createButtons(): void {
  const masthead = document.querySelector('#end');
  if (!masthead) return;

  BUTTONS.forEach(({ id, text, clickHandler, tooltip }) => {
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

    buttonWrapper.append(button, tooltipDiv);
    masthead.prepend(buttonWrapper);
  });
}

function init(): void {
  createButtons();

  const observer = new MutationObserver(createButtons);
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
