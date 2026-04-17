/**
 * YouTube Subtitle Extension - Content Script
 * 在 YouTube 页面上叠加字幕的核心逻辑
 */

import { getDefaultEnglishSettings, getDefaultChineseSettings, getDefaultConfig } from './config';
import { SubtitleParser } from './subtitle-parser';
import {
  normalizeSubtitleFetchErrorMessage,
  type SubtitleFetchLogPayload,
  type SubtitleFetchSource,
} from './subtitle-fetch-log';
import { getVideoInfo } from './transcript-core';
import {
  extractTranscriptSegmentData,
  extractTranscriptSegmentStartTime,
  findTranscriptTrigger,
  getTranscriptPanel,
  getTranscriptPanelState,
  getTranscriptSegmentElements,
  hasYouTubeLoginPrompt,
  isTranscriptReady,
  parseTranscriptTimestamp,
  resolveCaptionTrackText,
  shouldForceLegacyTranscriptOpen,
} from './youtube-subtitle-fetch';
import type { SimpleSubtitleEntry, SubtitleStyleSettings, VideoSubtitleData, ASSParseResult, TranslationProgress } from '../types';

// Chrome API 类型声明
declare const chrome: {
  runtime: {
    id?: string;
    sendMessage: (message: unknown) => Promise<{ success: boolean;[key: string]: unknown }>;
    onMessage: {
      addListener: (
        callback: (
          request: ChromeMessage,
          sender: unknown,
          sendResponse: (response: unknown) => void
        ) => boolean | void
      ) => void;
    };
  };
  storage: {
    local: {
      get: (keys: string | string[]) => Promise<Record<string, unknown>>;
      remove: (keys: string | string[]) => Promise<void>;
    };
  };
};

interface ChromeMessage {
  action: string;
  enabled?: boolean;
  subtitleData?: SimpleSubtitleEntry[];
  englishSubtitles?: SimpleSubtitleEntry[];
  chineseSubtitles?: SimpleSubtitleEntry[];
  language?: 'english' | 'chinese';
  settings?: Partial<SubtitleStyleSettings>;
  videoId?: string;
}

class YouTubeSubtitleOverlay {
  private subtitleData: SimpleSubtitleEntry[] = [];
  private englishSubtitles: SimpleSubtitleEntry[] = [];
  private chineseSubtitles: SimpleSubtitleEntry[] = [];
  private currentVideo: HTMLVideoElement | null = null;
  private overlayElement: HTMLElement | null = null;
  private isEnabled = false;

  private autoLoadEnabled = false;
  private currentVideoId: string | null = null;

  private englishSettings: SubtitleStyleSettings;
  private chineseSettings: SubtitleStyleSettings;

  private enableDPRCompensation: boolean;
  private dprCompensationFactor: number;

  private onTimeUpdate: (() => void) | null = null;
  private onEnded: (() => void) | null = null;
  private onPlay: (() => void) | null = null;
  private onPause: (() => void) | null = null;
  private onSeeking: (() => void) | null = null;
  private onSeeked: (() => void) | null = null;
  private onRateChange: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrollListener: (() => void) | null = null;
  private fullscreenListener: (() => void) | null = null;
  private resizeWindowListener: (() => void) | null = null;
  private youtubeStateObserver: MutationObserver | null = null;
  private urlChangeObserver: MutationObserver | null = null;
  private subtitleSyncVideo: HTMLVideoElement | null = null;
  private subtitleVideoFrameRequestId: number | null = null;
  private subtitleAnimationFrameId: number | null = null;

  constructor() {
    this.englishSettings = getDefaultEnglishSettings();
    this.chineseSettings = getDefaultChineseSettings();

    const config = getDefaultConfig();
    this.enableDPRCompensation = config.dpr.enabled;
    this.dprCompensationFactor = this.calculateDPRCompensation(config.dpr.compensationFactor);

    this.init();
  }

  private calculateDPRCompensation(compensationFactor: number): number {
    const dpr = window.devicePixelRatio || 1;
    if (dpr <= 1) return 1.0;
    return 1 + (dpr - 1) * compensationFactor;
  }

  private init(): void {
    this.createOverlayElement();
    this.observeVideoChanges();
    this.loadSubtitleData();
    this.bindMessageListener();
    this.bindWindowMessageListener();
  }

  private async startTranslationFromPage(): Promise<void> {
    try {
      // 检查扩展上下文是否有效
      if (!chrome.runtime?.id) {
        this.showErrorNotification('扩展已重新加载，请刷新页面后再试');
        return;
      }

      // 检查是否正在翻译
      const progressResult = await chrome.storage.local.get(['translationProgress']);
      const progress = progressResult.translationProgress as TranslationProgress | undefined;

      if (progress && progress.isTranslating) {
        const elapsed = Date.now() - (progress.timestamp || 0);
        if (elapsed > 10 * 60 * 1000) {
          // 超时，清除状态
          await chrome.storage.local.remove('translationProgress');
        } else {
          // 正在翻译中，取消翻译（与 popup 行为一致）
          console.log('翻译正在进行中，取消当前翻译');
          await chrome.runtime.sendMessage({ action: 'cancelTranslation' });
          return;
        }
      }

      // 获取视频ID
      const videoId = this.getVideoId();
      if (!videoId) {
        this.showErrorNotification('无法获取视频ID');
        return;
      }

      // 检查缓存（与 popup 行为一致：有缓存则重新翻译）
      const cacheKey = `videoSubtitles_${videoId}`;
      const cacheResult = await chrome.storage.local.get([cacheKey]);
      const cached = cacheResult[cacheKey] as VideoSubtitleData | undefined;

      if (cached && (cached.englishSubtitles?.length || cached.chineseSubtitles?.length)) {
        // 有缓存，清除缓存并重新翻译（与 popup 行为一致）
        console.log('发现缓存，清除并重新翻译');
        await chrome.storage.local.remove([cacheKey]);
        await chrome.runtime.sendMessage({ action: 'clearSubtitleData' });
      }

      // 获取字幕
      const subtitles = await this.fetchYouTubeOfficialSubtitles();
      if (!subtitles || subtitles.length === 0) {
        this.showErrorNotification('无法获取字幕');
        return;
      }

      // 获取完整的视频信息（包括说明和 AI 摘要）
      const videoInfo = getVideoInfo();

      const result = await chrome.storage.local.get(['apiConfig']);
      const apiConfig = (result.apiConfig as Record<string, string>) || {};

      chrome.runtime.sendMessage({
        action: 'startTranslation',
        subtitles,
        targetLanguage: apiConfig.targetLanguage || 'zh',
        videoId,
        apiConfig,
        videoInfo,  // 传递完整的视频信息
      });
    } catch (error) {
      console.error('启动翻译失败:', error);
      // 检查是否是扩展上下文失效错误
      if (error instanceof Error && error.message.includes('Extension context invalidated')) {
        this.showErrorNotification('扩展已重新加载，请刷新页面后再试');
      } else if (error instanceof Error && error.message) {
        this.showErrorNotification(error.message);
      }
    }
  }

  private bindMessageListener(): void {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      switch (request.action) {
        case 'toggleSubtitle':
          this.toggleSubtitle(request.enabled || false);
          break;
        case 'loadSubtitle':
          this.loadNewSubtitle(request.subtitleData || []);
          break;
        case 'loadBilingualSubtitles':
          this.loadBilingualSubtitles(
            request.englishSubtitles || [],
            request.chineseSubtitles || []
          );
          break;
        case 'appendBilingualSubtitles':
          this.appendBilingualSubtitles(
            request.englishSubtitles || [],
            request.chineseSubtitles || []
          );
          break;
        case 'clearData':
          this.clearSubtitleData();
          break;
        case 'forceReset':
          this.forceReset();
          break;
        case 'updateSettings':
          if (request.language && request.settings) {
            this.updateLanguageSettings(request.language, request.settings);
          }
          break;
        case 'toggleAutoLoad':
          this.toggleAutoLoad(request.enabled || false);
          break;
        case 'getVideoInfo': {
          const videoId = this.getVideoId();
          const subtitleLoaded =
            this.englishSubtitles.length > 0 || this.chineseSubtitles.length > 0;
          const videoInfo = getVideoInfo();
          sendResponse({
            videoId,
            subtitleLoaded,
            autoLoadEnabled: this.autoLoadEnabled,
            title: videoInfo.ytTitle,
            description: videoInfo.description,
            aiSummary: videoInfo.aiSummary,
          });
          break;
        }
        case 'getSubtitleStatus': {
          const currentVideoId = this.getVideoId();
          const englishCount = this.englishSubtitles.length;
          const chineseCount = this.chineseSubtitles.length;
          const hasSubtitles = englishCount > 0 || chineseCount > 0;

          sendResponse({
            videoId: currentVideoId,
            hasSubtitles,
            englishCount,
            chineseCount,
            autoLoadEnabled: this.autoLoadEnabled,
            subtitleEnabled: this.isEnabled,
          });
          break;
        }
        case 'getYouTubeSubtitles':
          this.fetchYouTubeOfficialSubtitles()
            .then((subtitles) => {
              sendResponse({ success: true, subtitles });
            })
            .catch((error) => {
              sendResponse({ success: false, error: (error as Error).message });
            });
          return true;
        case 'triggerAutoLoad':
          this.autoLoadEnabled = true;
          this.attemptAutoLoad();
          break;
        case 'startTranslationFromPage':
          this.startTranslationFromPage();
          break;
      }
    });
  }

  private bindWindowMessageListener(): void {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data.type === 'YTSP_StartTranslation') {
        this.startTranslationFromPage();
      }
    });
  }

  private async fetchYouTubeOfficialSubtitles(): Promise<SimpleSubtitleEntry[]> {
    const videoId = this.getVideoId();
    if (!videoId) {
      throw new Error('无法获取视频ID');
    }

    let captionTrackError: Error | null = null;
    try {
      const { subtitles, resolution } = await this.getSubtitlesFromCaptionTracks(videoId);
      if (subtitles.length > 0) {
        this.logSubtitleFetchSource('caption-tracks', subtitles.length, {
          strategy: resolution.source,
          trackLanguageCode: resolution.trackLanguageCode,
          trackKind: resolution.trackKind,
          fallbackReason: resolution.fallbackReason
            ? normalizeSubtitleFetchErrorMessage(resolution.fallbackReason)
            : undefined,
        });
        return subtitles;
      }
    } catch (error) {
      captionTrackError = error instanceof Error ? error : new Error(String(error));
      console.log('通过字幕轨接口获取字幕失败，回退到 transcript 面板:', error);
    }

    try {
      const panelSubtitles = await this.getSubtitlesFromTranscriptPanel();
      if (panelSubtitles.length > 0) {
        this.logSubtitleFetchSource('transcript-panel', panelSubtitles.length, {
          fallbackReason: captionTrackError
            ? normalizeSubtitleFetchErrorMessage(captionTrackError.message)
            : undefined,
        });
        return panelSubtitles;
      }
    } catch (panelError) {
      const normalizedPanelError = panelError instanceof Error ? panelError : new Error(String(panelError));
      this.logSubtitleFetchSource('unavailable', 0, {
        captionTrackError: captionTrackError
          ? normalizeSubtitleFetchErrorMessage(captionTrackError.message)
          : undefined,
        panelError: normalizeSubtitleFetchErrorMessage(normalizedPanelError.message),
      });

      if (captionTrackError?.message.includes('请先登录 YouTube')) {
        throw captionTrackError;
      }

      if (hasYouTubeLoginPrompt(document)) {
        throw new Error('YouTube 当前要求先登录以确认不是机器人，请登录后刷新页面再试。');
      }

      throw normalizedPanelError;
    }

    this.logSubtitleFetchSource('unavailable', 0, {
      captionTrackError: captionTrackError
        ? normalizeSubtitleFetchErrorMessage(captionTrackError.message)
        : '字幕轨未返回可用字幕',
    });
    if (captionTrackError) {
      throw captionTrackError;
    }

    throw new Error('无法获取 YouTube 字幕，请确保视频有可用字幕。');
  }

  private logSubtitleFetchSource(
    source: SubtitleFetchSource,
    subtitleCount: number,
    details: Partial<Omit<SubtitleFetchLogPayload, 'source' | 'subtitleCount'>> = {}
  ): void {
    const videoId = this.getVideoId();
    if (!chrome.runtime?.id || !videoId) {
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
    }).catch((error) => {
      console.log('发送字幕来源日志失败:', error);
    });
  }

  private async getSubtitlesFromCaptionTracks(videoId: string): Promise<{
    subtitles: SimpleSubtitleEntry[];
    resolution: {
      source: 'page-player-response' | 'youtubei-player';
      fallbackReason?: string;
      trackLanguageCode?: string;
      trackKind?: string;
    };
  }> {
    const resolution = await resolveCaptionTrackText(videoId);
    return {
      subtitles: this.parseTimedTextXml(resolution.trackText),
      resolution,
    };
  }

  private parseTimedTextXml(xml: string): SimpleSubtitleEntry[] {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('字幕 XML 解析失败');
    }

    const subtitles = this.parseSrv3Subtitles(doc);
    if (subtitles.length > 0) {
      return this.normalizeSubtitleTiming(subtitles);
    }

    return this.normalizeSubtitleTiming(this.parseTimedTextSubtitles(doc));
  }

  private parseSrv3Subtitles(doc: Document): SimpleSubtitleEntry[] {
    const timedSpanSubtitles = this.parseSrv3SpanSubtitles(doc);
    if (timedSpanSubtitles.length > 0) {
      return timedSpanSubtitles;
    }

    const subtitles: SimpleSubtitleEntry[] = [];

    doc.querySelectorAll('p').forEach((segment) => {
      const startMs = Number(segment.getAttribute('t'));
      if (Number.isNaN(startMs)) {
        return;
      }

      const durationMs = Number(segment.getAttribute('d'));
      const textParts = Array.from(segment.querySelectorAll('s'))
        .map((part) => part.textContent || '')
        .join('');
      const rawText = textParts || segment.textContent || '';
      const text = rawText.replace(/\s+/g, ' ').trim();

      if (!text) {
        return;
      }

      subtitles.push({
        startTime: startMs / 1000,
        endTime: Number.isNaN(durationMs) ? startMs / 1000 : (startMs + durationMs) / 1000,
        text,
      });
    });

    return subtitles;
  }

  private parseSrv3SpanSubtitles(doc: Document): SimpleSubtitleEntry[] {
    const subtitles: SimpleSubtitleEntry[] = [];

    doc.querySelectorAll('p').forEach((segment) => {
      const paragraphStartMs = Number(segment.getAttribute('t'));
      if (Number.isNaN(paragraphStartMs)) {
        return;
      }

      const paragraphDurationMs = Number(segment.getAttribute('d'));
      const paragraphEndMs = Number.isNaN(paragraphDurationMs)
        ? null
        : paragraphStartMs + paragraphDurationMs;

      const spans = Array.from(segment.querySelectorAll('s'));
      if (spans.length === 0) {
        return;
      }

      const spanOffsets = spans.map((span) => {
        const offsetMs = Number(span.getAttribute('t'));
        return Number.isNaN(offsetMs) ? null : offsetMs;
      });

      if (!spanOffsets.some((offsetMs) => offsetMs !== null)) {
        return;
      }

      spans.forEach((span, index) => {
        const text = (span.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) {
          return;
        }

        const relativeStartMs =
          spanOffsets[index] ?? (index === 0 ? 0 : spanOffsets[index - 1] ?? 0);
        let relativeEndMs: number | null = null;

        for (let nextIndex = index + 1; nextIndex < spanOffsets.length; nextIndex++) {
          if (spanOffsets[nextIndex] !== null) {
            relativeEndMs = spanOffsets[nextIndex];
            break;
          }
        }

        const startMs = paragraphStartMs + relativeStartMs;
        let endMs = relativeEndMs !== null
          ? paragraphStartMs + relativeEndMs
          : paragraphEndMs ?? startMs;

        if (endMs <= startMs) {
          endMs = paragraphEndMs && paragraphEndMs > startMs
            ? paragraphEndMs
            : startMs;
        }

        subtitles.push({
          startTime: startMs / 1000,
          endTime: endMs / 1000,
          text,
        });
      });
    });

    return subtitles;
  }

  private parseTimedTextSubtitles(doc: Document): SimpleSubtitleEntry[] {
    const subtitles: SimpleSubtitleEntry[] = [];

    doc.querySelectorAll('text').forEach((segment) => {
      const start = Number(segment.getAttribute('start'));
      if (Number.isNaN(start)) {
        return;
      }

      const duration = Number(segment.getAttribute('dur'));
      const text = (segment.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) {
        return;
      }

      subtitles.push({
        startTime: start,
        endTime: Number.isNaN(duration) ? start : start + duration,
        text,
      });
    });

    return subtitles;
  }

  private normalizeSubtitleTiming(subtitles: SimpleSubtitleEntry[]): SimpleSubtitleEntry[] {
    if (subtitles.length === 0) {
      return [];
    }

    return subtitles.map((subtitle, index) => {
      const next = subtitles[index + 1];
      let endTime = subtitle.endTime;

      if (!Number.isFinite(endTime) || endTime <= subtitle.startTime) {
        endTime = next && next.startTime > subtitle.startTime
          ? next.startTime
          : subtitle.startTime + 5;
      }

      return {
        startTime: subtitle.startTime,
        endTime,
        text: subtitle.text,
      };
    });
  }

  private async getSubtitlesFromTranscriptPanel(): Promise<SimpleSubtitleEntry[]> {
    await this.ensureTranscriptPanelReady();
    const transcriptSegments = getTranscriptSegmentElements(document);
    const subtitles: SimpleSubtitleEntry[] = [];
    transcriptSegments.forEach((segment, index) => {
      const segmentData = extractTranscriptSegmentData(segment);
      let timestampText = segmentData?.timestampText || '';
      let text = segmentData?.bodyText || '';

      if (!timestampText || !text) {
        const divs = segment.querySelectorAll('div');
        if (divs.length >= 2) {
          timestampText = timestampText || (divs[0].textContent || '').trim();
          text = text || (divs[1].textContent || '').trim();
        }
      }

      if (timestampText && text) {
        const timestamp =
          extractTranscriptSegmentStartTime(segment) ?? parseTranscriptTimestamp(timestampText);
        if (text) {
          const nextSegment = transcriptSegments[index + 1];
          let endTime = timestamp + 5;
          if (nextSegment) {
            const nextSegmentData = extractTranscriptSegmentData(nextSegment);
            const nextTimestampText =
              nextSegmentData?.timestampText ||
              (nextSegment.querySelector('div')?.textContent || '').trim();
            if (nextTimestampText) {
              endTime =
                extractTranscriptSegmentStartTime(nextSegment) ??
                parseTranscriptTimestamp(nextTimestampText);
            }
          }

          subtitles.push({ startTime: timestamp, endTime, text });
        }
      }
    });

    return subtitles;
  }

  private async ensureTranscriptPanelReady(): Promise<void> {
    if (isTranscriptReady(getTranscriptPanelState(document))) {
      return;
    }

    const moreButton = document.querySelector('#expand') as HTMLElement | null;
    if (moreButton) {
      moreButton.click();
      await this.sleep(400);
    }

    let clickedTranscriptTrigger = false;
    const transcriptButton = findTranscriptTrigger(document);
    if (transcriptButton instanceof HTMLElement) {
      transcriptButton.click();
      clickedTranscriptTrigger = true;
      await this.sleep(400);
    }

    const transcriptPanel = getTranscriptPanel(document);
    if (shouldForceLegacyTranscriptOpen(clickedTranscriptTrigger, !!transcriptPanel)) {
      window.dispatchEvent(new CustomEvent('YTSP_OpenTranscript'));
    }

    const ready = await this.waitForTranscriptReady();
    if (!ready) {
      if (hasYouTubeLoginPrompt(document)) {
        throw new Error('YouTube 当前要求先登录以确认不是机器人，请登录后刷新页面再试。');
      }

      throw new Error('转写面板已打开，但字幕内容尚未加载完成，请稍后重试。');
    }
  }

  private async waitForTranscriptReady(maxRetries = 20, intervalMs = 500): Promise<boolean> {
    for (let retry = 0; retry < maxRetries; retry += 1) {
      const state = getTranscriptPanelState(document);
      if (isTranscriptReady(state)) {
        return true;
      }

      await this.sleep(intervalMs);
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private createOverlayElement(): void {
    this.overlayElement = document.createElement('div');
    this.overlayElement.id = 'youtube-local-subtitle-overlay';
    this.overlayElement.innerHTML = `
      <div class="subtitle-container">
        <div class="english-wrapper">
          <span class="english-subtitle" id="englishSubtitle"></span>
        </div>
        <div class="chinese-wrapper">
          <span class="chinese-subtitle" id="chineseSubtitle"></span>
        </div>
      </div>
    `;
    this.applyStyles();
  }

  private applyStyles(): void {
    if (!this.overlayElement) return;

    const mainStyles: Partial<CSSStyleDeclaration> = {
      position: 'absolute',
      zIndex: '40',
      display: 'none',
      left: '50%',
      transform: 'translateX(-50%)',
      bottom: '60px',
      pointerEvents: 'none',
      userSelect: 'none',
    };
    Object.assign(this.overlayElement.style, mainStyles);

    const container = this.overlayElement.querySelector('.subtitle-container') as HTMLElement;
    this.applyContainerFlexStyles(container);

    const englishWrapper = this.overlayElement.querySelector('.english-wrapper') as HTMLElement;
    const chineseWrapper = this.overlayElement.querySelector('.chinese-wrapper') as HTMLElement;

    this.applyWrapperStyles(englishWrapper);
    this.applyWrapperStyles(chineseWrapper);

    this.applyLanguageStyles('english');
    this.applyLanguageStyles('chinese');
  }

  private applyContainerFlexStyles(container: HTMLElement | null): void {
    if (container) {
      Object.assign(container.style, {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0px',
        width: '100%',
      });
    }
  }

  private applyWrapperStyles(wrapper: HTMLElement | null): void {
    if (wrapper) {
      Object.assign(wrapper.style, {
        display: 'block',
        textAlign: 'center',
        width: '100%',
        textWrap: 'balance',
      });
    }
  }

  private applyLanguageStyles(language: 'english' | 'chinese'): void {
    if (!this.overlayElement) return;

    const settings = language === 'english' ? this.englishSettings : this.chineseSettings;
    const elementId = language === 'english' ? '#englishSubtitle' : '#chineseSubtitle';
    const element = this.overlayElement.querySelector(elementId) as HTMLElement;

    if (element && settings) {
      const baseFontSize = settings.fontSize;
      const compensatedFontSize = this.enableDPRCompensation
        ? Math.round(baseFontSize * this.dprCompensationFactor)
        : baseFontSize;

      Object.assign(element.style, {
        fontSize: compensatedFontSize + 'px',
        color: settings.fontColor,
        WebkitTextFillColor: settings.fontColor,
        fontFamily: settings.fontFamily,
        fontWeight: settings.fontWeight,
        WebkitTextStroke: settings.textStroke || 'none',
        paintOrder: 'stroke fill',
        textShadow: settings.textShadow !== 'none' ? settings.textShadow : 'none',
        lineHeight: String(settings.lineHeight),
        padding: '0 6px',
        borderRadius: '3px',
        display: 'inline',
        textAlign: 'center',
        whiteSpace: 'pre-wrap',
        wordBreak: 'normal',
        textWrap: 'balance',
        boxDecorationBreak: 'clone',
        WebkitBoxDecorationBreak: 'clone',
        maxWidth: '100%',
        boxSizing: 'border-box',
        margin: '0',
      });
    }
  }

  private observeVideoChanges(): void {
    let currentUrl = location.href;

    // 如果已存在 observer，先断开
    if (this.urlChangeObserver) {
      this.urlChangeObserver.disconnect();
    }

    this.urlChangeObserver = new MutationObserver(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        setTimeout(() => this.onVideoChange(), 1000);
      }
    });

    this.urlChangeObserver.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => this.onVideoChange(), 1000);
  }

  private onVideoChange(): void {
    const video = document.querySelector('video') as HTMLVideoElement;
    const videoElementChanged = video && video !== this.currentVideo;
    const newVideoId = this.getVideoId();
    const videoIdChanged = newVideoId && newVideoId !== this.currentVideoId;

    if (videoElementChanged) {
      this.currentVideo = video;
      this.setupVideoListeners();
      this.insertOverlayToPage();
      this.setupResizeListener();
    }

    if (videoIdChanged || videoElementChanged) {
      this.hideSubtitle();
      this.subtitleData = [];
      this.englishSubtitles = [];
      this.chineseSubtitles = [];
      this.loadSubtitleData();

      setTimeout(() => {
        this.attemptAutoLoad();
      }, 500);
    }
  }

  private setupVideoListeners(): void {
    if (!this.currentVideo) return;

    this.stopSubtitleSyncLoop();

    if (this.onTimeUpdate) {
      this.currentVideo.removeEventListener('timeupdate', this.onTimeUpdate);
    }
    if (this.onEnded) {
      this.currentVideo.removeEventListener('ended', this.onEnded);
    }
    if (this.onPlay) {
      this.currentVideo.removeEventListener('play', this.onPlay);
    }
    if (this.onPause) {
      this.currentVideo.removeEventListener('pause', this.onPause);
    }
    if (this.onSeeking) {
      this.currentVideo.removeEventListener('seeking', this.onSeeking);
    }
    if (this.onSeeked) {
      this.currentVideo.removeEventListener('seeked', this.onSeeked);
    }
    if (this.onRateChange) {
      this.currentVideo.removeEventListener('ratechange', this.onRateChange);
    }

    this.onTimeUpdate = () => {
      if (this.isEnabled) {
        if (
          this.englishSubtitles.length > 0 ||
          this.chineseSubtitles.length > 0 ||
          this.subtitleData.length > 0
        ) {
          this.updateSubtitle();
        }
      }
    };

    this.onEnded = () => {
      this.stopSubtitleSyncLoop();
      this.hideSubtitle();
    };

    this.onPlay = () => {
      this.updateSubtitle();
      this.startSubtitleSyncLoop();
    };

    this.onPause = () => {
      this.stopSubtitleSyncLoop();
      this.updateSubtitle();
    };

    this.onSeeking = () => {
      this.updateSubtitle();
    };

    this.onSeeked = () => {
      this.updateSubtitle();
      this.startSubtitleSyncLoop();
    };

    this.onRateChange = () => {
      this.updateSubtitle();
      this.startSubtitleSyncLoop();
    };

    this.currentVideo.addEventListener('timeupdate', this.onTimeUpdate);
    this.currentVideo.addEventListener('ended', this.onEnded);
    this.currentVideo.addEventListener('play', this.onPlay);
    this.currentVideo.addEventListener('pause', this.onPause);
    this.currentVideo.addEventListener('seeking', this.onSeeking);
    this.currentVideo.addEventListener('seeked', this.onSeeked);
    this.currentVideo.addEventListener('ratechange', this.onRateChange);

    if (this.isEnabled) {
      this.updateSubtitle();
      this.startSubtitleSyncLoop();
    }
  }

  private startSubtitleSyncLoop(): void {
    const video = this.currentVideo;
    if (!video || !this.isEnabled || video.paused || video.ended) {
      this.stopSubtitleSyncLoop();
      return;
    }

    this.stopSubtitleSyncLoop();
    this.subtitleSyncVideo = video;

    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick = (): void => {
        this.subtitleVideoFrameRequestId = null;

        if (video !== this.currentVideo || !this.isEnabled) {
          return;
        }

        this.updateSubtitle();

        if (!video.paused && !video.ended) {
          this.subtitleVideoFrameRequestId = video.requestVideoFrameCallback(() => {
            tick();
          });
        }
      };

      this.subtitleVideoFrameRequestId = video.requestVideoFrameCallback(() => {
        tick();
      });
      return;
    }

    const tick = (): void => {
      this.subtitleAnimationFrameId = null;

      if (video !== this.currentVideo || !this.isEnabled) {
        return;
      }

      this.updateSubtitle();

      if (!video.paused && !video.ended) {
        this.subtitleAnimationFrameId = window.requestAnimationFrame(tick);
      }
    };

    this.subtitleAnimationFrameId = window.requestAnimationFrame(tick);
  }

  private stopSubtitleSyncLoop(): void {
    if (
      this.subtitleSyncVideo &&
      this.subtitleVideoFrameRequestId !== null &&
      typeof this.subtitleSyncVideo.cancelVideoFrameCallback === 'function'
    ) {
      this.subtitleSyncVideo.cancelVideoFrameCallback(this.subtitleVideoFrameRequestId);
    }

    if (this.subtitleAnimationFrameId !== null) {
      window.cancelAnimationFrame(this.subtitleAnimationFrameId);
    }

    this.subtitleSyncVideo = null;
    this.subtitleVideoFrameRequestId = null;
    this.subtitleAnimationFrameId = null;
  }

  private setupResizeListener(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.scrollListener) {
      window.removeEventListener('scroll', this.scrollListener);
    }
    if (this.fullscreenListener) {
      document.removeEventListener('fullscreenchange', this.fullscreenListener);
    }
    if (this.resizeWindowListener) {
      window.removeEventListener('resize', this.resizeWindowListener);
    }

    const debounceReposition = this.debounce(() => {
      if (this.overlayElement && this.isEnabled) {
        this.repositionSubtitle();
      }
    }, 100);

    this.resizeObserver = new ResizeObserver(() => {
      debounceReposition();
    });

    this.scrollListener = () => {
      debounceReposition();
    };

    this.fullscreenListener = () => {
      setTimeout(() => {
        if (this.overlayElement && this.isEnabled) {
          this.repositionSubtitle();
        }
      }, 100);
    };

    this.resizeWindowListener = () => {
      debounceReposition();
    };

    this.setupYouTubeStateListener();

    if (this.currentVideo) {
      this.resizeObserver.observe(this.currentVideo);
    }
    window.addEventListener('scroll', this.scrollListener, { passive: true });
    document.addEventListener('fullscreenchange', this.fullscreenListener);
    window.addEventListener('resize', this.resizeWindowListener, { passive: true });
  }

  private debounce<T extends (...args: unknown[]) => void>(func: T, wait: number): T {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return ((...args: unknown[]) => {
      const later = () => {
        timeout = null;
        func(...args);
      };
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    }) as T;
  }

  private setupYouTubeStateListener(): void {
    if (this.youtubeStateObserver) {
      this.youtubeStateObserver.disconnect();
    }

    this.youtubeStateObserver = new MutationObserver((mutations) => {
      let needsReposition = false;

      mutations.forEach((mutation) => {
        if (
          mutation.type === 'attributes' &&
          (mutation.attributeName === 'class' || mutation.attributeName === 'theater')
        ) {
          needsReposition = true;
        }

        if (mutation.type === 'childList') {
          needsReposition = true;
        }
      });

      if (needsReposition && this.overlayElement && this.isEnabled) {
        setTimeout(() => this.repositionSubtitle(), 200);
      }
    });

    const targets = [
      document.querySelector('#movie_player'),
      document.querySelector('#masthead-container'),
      document.querySelector('#page-manager'),
      document.body,
    ].filter((el): el is Element => el !== null);

    targets.forEach((target) => {
      this.youtubeStateObserver!.observe(target, {
        attributes: true,
        attributeFilter: ['class', 'theater', 'fullscreen'],
        childList: true,
        subtree: false,
      });
    });
  }

  private repositionSubtitle(): void {
    if (!this.overlayElement || !this.currentVideo) return;

    const container = this.overlayElement.querySelector('.subtitle-container') as HTMLElement;
    this.applyContainerFlexStyles(container);

    const englishWrapper = this.overlayElement.querySelector('.english-wrapper') as HTMLElement;
    const chineseWrapper = this.overlayElement.querySelector('.chinese-wrapper') as HTMLElement;

    this.applyWrapperStyles(englishWrapper);
    this.applyWrapperStyles(chineseWrapper);

    this.applyLanguageStyles('english');
    this.applyLanguageStyles('chinese');

    const englishEl = this.overlayElement.querySelector('#englishSubtitle') as HTMLElement;
    const chineseEl = this.overlayElement.querySelector('#chineseSubtitle') as HTMLElement;
    const hasText =
      (englishEl && englishEl.textContent?.trim()) ||
      (chineseEl && chineseEl.textContent?.trim());
    if (!hasText) {
      this.overlayElement.style.display = 'none';
    }

    const isFullscreen = document.fullscreenElement !== null;
    const isTheaterMode = document.querySelector('.ytp-size-large') !== null;
    const isMiniPlayer = document.querySelector('.ytp-miniplayer-active') !== null;
    const videoRect = this.currentVideo.getBoundingClientRect();

    const playerContainer = document.querySelector('#movie_player') as HTMLElement;

    if (isFullscreen) {
      this.overlayElement.style.position = 'fixed';
      this.overlayElement.style.left = '50%';
      this.overlayElement.style.transform = 'translateX(-50%)';
      this.overlayElement.style.bottom = '80px';
      this.overlayElement.style.width = '80%';
      this.overlayElement.style.maxWidth = 'none';
      this.overlayElement.style.zIndex = '9999';
    } else if (isMiniPlayer) {
      this.overlayElement.style.display = 'none';
      return;
    } else {
      this.overlayElement.style.display = 'block';
      this.overlayElement.style.position = 'absolute';
      this.overlayElement.style.zIndex = '40';

      if (playerContainer) {
        if (playerContainer.style.position !== 'relative') {
          playerContainer.style.position = 'relative';
        }

        this.overlayElement.style.left = '50%';
        this.overlayElement.style.transform = 'translateX(-50%)';
        this.overlayElement.style.bottom = isTheaterMode ? '70px' : '60px';
        this.overlayElement.style.width = '80%';
        this.overlayElement.style.maxWidth = 'none';

        if (!playerContainer.contains(this.overlayElement)) {
          playerContainer.appendChild(this.overlayElement);
        }
      } else {
        this.overlayElement.style.position = 'fixed';
        this.overlayElement.style.left = '50%';
        this.overlayElement.style.transform = 'translateX(-50%)';
        this.overlayElement.style.bottom = window.innerHeight - videoRect.bottom + 60 + 'px';
        this.overlayElement.style.width = Math.min(videoRect.width * 0.8, 800) + 'px';
        this.overlayElement.style.maxWidth = 'none';
      }
    }
  }

  private insertOverlayToPage(): void {
    const existingOverlay = document.getElementById('youtube-local-subtitle-overlay');
    if (existingOverlay) {
      existingOverlay.remove();
    }

    const moviePlayer = document.querySelector('#movie_player') as HTMLElement;

    if (moviePlayer) {
      if (moviePlayer.style.position !== 'relative') {
        moviePlayer.style.position = 'relative';
      }

      if (this.overlayElement) {
        moviePlayer.appendChild(this.overlayElement);
      }
    } else {
      if (this.overlayElement) {
        document.body.appendChild(this.overlayElement);
      }
    }

    this.repositionSubtitle();
  }

  private updateSubtitle(): void {
    if (!this.currentVideo || !this.isEnabled || !this.overlayElement) {
      return;
    }

    const currentTime = this.currentVideo.currentTime;

    let englishText = '';
    let chineseText = '';

    if (this.englishSubtitles.length > 0) {
      const englishSubtitle = this.findCurrentSubtitle(currentTime, this.englishSubtitles);
      if (englishSubtitle) {
        englishText = englishSubtitle.text;
      }
    }

    if (this.chineseSubtitles.length > 0) {
      const chineseSubtitle = this.findCurrentSubtitle(currentTime, this.chineseSubtitles);
      if (chineseSubtitle) {
        chineseText = chineseSubtitle.text;
      }
    }

    if (
      this.englishSubtitles.length === 0 &&
      this.chineseSubtitles.length === 0 &&
      this.subtitleData.length > 0
    ) {
      const currentSubtitle = this.findCurrentSubtitle(currentTime, this.subtitleData);
      if (currentSubtitle) {
        chineseText = currentSubtitle.text;
      }
    }

    if (englishText || chineseText) {
      this.showBilingualSubtitle(englishText, chineseText);
    } else {
      this.hideSubtitle();
    }
  }

  private showBilingualSubtitle(englishText: string, chineseText: string): void {
    if (!this.overlayElement) return;

    const englishSubtitle = this.overlayElement.querySelector('#englishSubtitle') as HTMLElement;
    const chineseSubtitle = this.overlayElement.querySelector('#chineseSubtitle') as HTMLElement;

    if (englishSubtitle) {
      englishSubtitle.textContent = englishText;
      englishSubtitle.style.display = englishText ? 'inline' : 'none';
    }

    if (chineseSubtitle) {
      chineseSubtitle.textContent = chineseText;
      chineseSubtitle.style.display = chineseText ? 'inline' : 'none';
    }

    this.overlayElement.style.display = 'block';
    this.overlayElement.style.position = 'absolute';
    this.overlayElement.style.zIndex = '40';
    this.overlayElement.style.visibility = 'visible';
    this.overlayElement.style.opacity = '1';

    this.repositionSubtitle();
  }

  private hideSubtitle(): void {
    if (!this.overlayElement) return;
    this.overlayElement.style.display = 'none';
    this.overlayElement.style.visibility = 'hidden';
    this.overlayElement.style.opacity = '0';

    const englishSubtitle = this.overlayElement.querySelector('#englishSubtitle') as HTMLElement;
    const chineseSubtitle = this.overlayElement.querySelector('#chineseSubtitle') as HTMLElement;
    if (englishSubtitle) {
      englishSubtitle.textContent = '';
      englishSubtitle.style.display = 'none';
    }
    if (chineseSubtitle) {
      chineseSubtitle.textContent = '';
      chineseSubtitle.style.display = 'none';
    }
  }

  private showErrorNotification(message: string): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      z-index: 10000;
      display: flex;
      justify-content: center;
      align-items: center;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background: #f44336;
      color: white;
      padding: 20px 30px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: bold;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    `;
    modal.textContent = message;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    setTimeout(() => overlay.remove(), 3000);
  }

  private findCurrentSubtitle(
    currentTime: number,
    subtitles: SimpleSubtitleEntry[]
  ): SimpleSubtitleEntry | undefined {
    for (let i = subtitles.length - 1; i >= 0; i--) {
      const subtitle = subtitles[i];
      if (currentTime >= subtitle.startTime && currentTime < subtitle.endTime) {
        return subtitle;
      }
    }

    return undefined;
  }

  private toggleSubtitle(enabled: boolean): void {
    this.isEnabled = enabled;

    if (!enabled) {
      this.stopSubtitleSyncLoop();
      this.hideSubtitle();
    } else {
      if (
        this.englishSubtitles.length > 0 ||
        this.chineseSubtitles.length > 0 ||
        this.subtitleData.length > 0
      ) {
        if (this.currentVideo) {
          this.updateSubtitle();
          this.startSubtitleSyncLoop();
        }
      }
    }
  }

  private loadBilingualSubtitles(
    englishSubtitles: SimpleSubtitleEntry[],
    chineseSubtitles: SimpleSubtitleEntry[]
  ): void {
    this.englishSubtitles = englishSubtitles || [];
    this.chineseSubtitles = chineseSubtitles || [];

    if (this.englishSubtitles.length > 0 || this.chineseSubtitles.length > 0) {
      this.isEnabled = true;

      if (!this.currentVideo) {
        this.currentVideo = document.querySelector('video');
      }

      if (!this.overlayElement) {
        this.createOverlayElement();
        this.insertOverlayToPage();
      }

      chrome.runtime.sendMessage({
        action: 'setSubtitleEnabled',
        enabled: true,
      });

      if (this.currentVideo && this.overlayElement) {
        this.setupVideoListeners();
        this.updateSubtitle();
      }
    }
  }

  private appendBilingualSubtitles(
    englishSubtitles: SimpleSubtitleEntry[],
    chineseSubtitles: SimpleSubtitleEntry[]
  ): void {
    // 追加字幕数据
    this.englishSubtitles.push(...(englishSubtitles || []));
    this.chineseSubtitles.push(...(chineseSubtitles || []));

    // 按时间排序确保顺序正确
    this.englishSubtitles.sort((a, b) => a.startTime - b.startTime);
    this.chineseSubtitles.sort((a, b) => a.startTime - b.startTime);

    // 如果是首次追加，需要初始化
    if (!this.isEnabled && (this.englishSubtitles.length > 0 || this.chineseSubtitles.length > 0)) {
      this.isEnabled = true;

      if (!this.currentVideo) {
        this.currentVideo = document.querySelector('video');
      }

      if (!this.overlayElement) {
        this.createOverlayElement();
        this.insertOverlayToPage();
      }

      chrome.runtime.sendMessage({
        action: 'setSubtitleEnabled',
        enabled: true,
      });

      if (this.currentVideo && this.overlayElement) {
        this.setupVideoListeners();
      }
    }

    // 更新当前显示的字幕
    if (this.currentVideo && this.overlayElement) {
      this.updateSubtitle();
    }
  }

  private loadNewSubtitle(subtitleData: SimpleSubtitleEntry[]): void {
    this.subtitleData = subtitleData;
  }

  private clearSubtitleData(): void {
    this.stopSubtitleSyncLoop();
    this.subtitleData = [];
    this.englishSubtitles = [];
    this.chineseSubtitles = [];
    this.hideSubtitle();
  }

  private forceReset(): void {
    this.stopSubtitleSyncLoop();
    this.subtitleData = [];
    this.englishSubtitles = [];
    this.chineseSubtitles = [];
    this.currentVideo = null;

    this.englishSettings = getDefaultEnglishSettings();
    this.chineseSettings = getDefaultChineseSettings();

    this.autoLoadEnabled = false;
    this.currentVideoId = null;

    this.isEnabled = false;
    this.hideSubtitle();

    this.applyStyles();
  }

  private updateLanguageSettings(
    language: 'english' | 'chinese',
    settings: Partial<SubtitleStyleSettings>
  ): void {
    if (language === 'english') {
      this.englishSettings = { ...this.englishSettings, ...settings };
    } else if (language === 'chinese') {
      this.chineseSettings = { ...this.chineseSettings, ...settings };
    }

    this.applyLanguageStyles(language);
  }

  private async loadSubtitleData(): Promise<void> {
    try {
      const currentVideoId = this.getVideoId();

      const result = await chrome.storage.local.get([
        'subtitleEnabled',
        'englishSettings',
        'chineseSettings',
        'autoLoadEnabled',
        `videoSubtitles_${currentVideoId}`,
      ]);

      this.subtitleData = [];
      this.englishSubtitles = [];
      this.chineseSubtitles = [];

      if (currentVideoId && result[`videoSubtitles_${currentVideoId}`]) {
        const videoSubtitles = result[`videoSubtitles_${currentVideoId}`] as VideoSubtitleData;

        if (videoSubtitles.englishSubtitles || videoSubtitles.chineseSubtitles) {
          this.englishSubtitles = videoSubtitles.englishSubtitles || [];
          this.chineseSubtitles = videoSubtitles.chineseSubtitles || [];
        } else if (videoSubtitles.subtitleData && videoSubtitles.subtitleData.length > 0) {
          this.subtitleData = videoSubtitles.subtitleData;
        }
      }

      if (result.subtitleEnabled !== undefined) {
        this.isEnabled = result.subtitleEnabled as boolean;
      }

      if (result.autoLoadEnabled !== undefined) {
        this.autoLoadEnabled = result.autoLoadEnabled as boolean;
      }

      if (result.englishSettings) {
        this.englishSettings = {
          ...this.englishSettings,
          ...(result.englishSettings as SubtitleStyleSettings),
        };
      }

      if (result.chineseSettings) {
        const filteredSettings: Partial<SubtitleStyleSettings> = {};
        for (const [key, value] of Object.entries(
          result.chineseSettings as SubtitleStyleSettings
        )) {
          if (value !== '' && value !== null && value !== undefined) {
            (filteredSettings as Record<string, unknown>)[key] = value;
          }
        }

        this.chineseSettings = { ...this.chineseSettings, ...filteredSettings };
      }

      if (this.overlayElement) {
        this.applyLanguageStyles('english');
        this.applyLanguageStyles('chinese');
      }

      const hasSubtitles =
        this.englishSubtitles.length > 0 ||
        this.chineseSubtitles.length > 0 ||
        this.subtitleData.length > 0;

      if (hasSubtitles && this.isEnabled) {
        if (!this.currentVideo) {
          this.currentVideo = document.querySelector('video');
        }
        if (this.currentVideo && this.overlayElement) {
          this.setupVideoListeners();
          this.updateSubtitle();
        }
      }
    } catch (error) {
      console.error('加载字幕数据失败:', error);
    }
  }

  private toggleAutoLoad(enabled: boolean): void {
    this.autoLoadEnabled = enabled;

    if (enabled) {
      this.attemptAutoLoad();
    }
  }

  private getVideoId(): string | null {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('v');
  }

  private async attemptAutoLoad(): Promise<void> {
    if (!this.autoLoadEnabled) return;

    const videoId = this.getVideoId();
    if (!videoId) return;

    const isNewVideo = videoId !== this.currentVideoId;
    const hasExistingSubtitles =
      this.englishSubtitles.length > 0 ||
      this.chineseSubtitles.length > 0 ||
      this.subtitleData.length > 0;

    if (!isNewVideo && hasExistingSubtitles) return;

    this.currentVideoId = videoId;

    await this.loadSubtitleData();
  }

  async processAutoLoadedSubtitle(
    content: string,
    info: { format: string; filename: string }
  ): Promise<void> {
    try {
      const format = info.format.toLowerCase();
      const currentVideoId = this.getVideoId();

      if (!currentVideoId) {
        console.error('❌ 无法获取视频ID，跳过字幕保存');
        return;
      }

      if (format === '.ass') {
        const assResult: ASSParseResult = SubtitleParser.parseASS(content);

        if (assResult.english.length > 0 || assResult.chinese.length > 0) {
          this.englishSubtitles = assResult.english;
          this.chineseSubtitles = assResult.chinese;

          await chrome.runtime.sendMessage({
            action: 'saveVideoSubtitles',
            videoId: currentVideoId,
            englishSubtitles: assResult.english,
            chineseSubtitles: assResult.chinese,
          });
        }
      } else if (format === '.srt') {
        const subtitleData = SubtitleParser.parseSRT(content);

        if (subtitleData.length > 0) {
          this.subtitleData = subtitleData;

          await chrome.runtime.sendMessage({
            action: 'saveVideoSubtitles',
            videoId: currentVideoId,
            subtitleData,
          });
        }
      }

      if (
        this.englishSubtitles.length > 0 ||
        this.chineseSubtitles.length > 0 ||
        this.subtitleData.length > 0
      ) {
        this.isEnabled = true;

        chrome.runtime.sendMessage({
          action: 'setSubtitleEnabled',
          enabled: true,
        });

        if (this.currentVideo) {
          this.updateSubtitle();
        }
      }
    } catch (error) {
      console.error('处理自动加载的字幕失败:', error);
    }
  }
}

// 初始化
let subtitleOverlayInstance: YouTubeSubtitleOverlay | null = null;

const initializeSubtitle = (): void => {
  if (!subtitleOverlayInstance) {
    subtitleOverlayInstance = new YouTubeSubtitleOverlay();
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSubtitle);
} else {
  initializeSubtitle();
}
