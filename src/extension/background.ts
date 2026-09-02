/**
 * YouTube Subtitle Extension - Background Service Worker
 * 处理扩展的后台任务：消息通信、存储管理、翻译任务
 */

import {
  assertApiConfigUsesRemoteEndpoints,
  getDefaultEnglishSettings,
  getDefaultChineseSettings,
  migrateApiConfig,
} from './config';
import { formatSubtitleFetchLog } from './subtitle-fetch-log';
import {
  BrowserTranslationCoordinator,
  translationSessionAdapter,
  type BrowserTranslationJob,
  type ExtensionBilingualSubtitles,
} from './translator';
import type { CancellationSignal } from '../utils/cancellation';
import type { TranslationRunPublication } from './translation-run-gate';
import type {
  SimpleSubtitleEntry,
  SubtitleStyleSettings,
  VideoSubtitleData,
  TranslationProgress,
  ApiConfig,
  TranslationVideoInfo,
} from '../types';

// Chrome API 类型声明
declare const chrome: {
  runtime: {
    onInstalled: {
      addListener: (callback: (details: { reason: string }) => void) => void;
    };
    onMessage: {
      addListener: (
        callback: (
          request: ChromeMessage,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response: unknown) => void
        ) => boolean | void
      ) => void;
    };
    onStartup?: {
      addListener: (callback: () => void) => void;
    };
  };
  alarms?: {
    onAlarm: {
      addListener: (callback: (alarm: { name: string }) => void) => void;
    };
    create: (name: string, alarmInfo: { periodInMinutes: number }) => Promise<void> | void;
  };
  tabs: {
    query: (query: { active?: boolean; currentWindow?: boolean }) => Promise<chrome.tabs.Tab[]>;
    sendMessage: (tabId: number, message: unknown) => Promise<void>;
    get: (tabId: number) => Promise<chrome.tabs.Tab>;
  };
  storage: {
    local: {
      get: (keys: string | string[] | null) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
      clear: () => Promise<void>;
    };
  };
};

declare namespace chrome.runtime {
  interface MessageSender {
    tab?: chrome.tabs.Tab;
  }
}

declare namespace chrome.tabs {
  interface Tab {
    id?: number;
    url?: string;
  }
}

interface ChromeMessage {
  action: string;
  data?: unknown;
  enabled?: boolean;
  settings?: {
    language: 'english' | 'chinese';
    data: Partial<SubtitleStyleSettings>;
  };
  subtitles?: SimpleSubtitleEntry[];
  targetLanguage?: string;
  videoId?: string;
  apiConfig?: Partial<ApiConfig>;
  videoInfo?: TranslationVideoInfo;
  englishSubtitles?: SimpleSubtitleEntry[];
  chineseSubtitles?: SimpleSubtitleEntry[];
  subtitleData?: SimpleSubtitleEntry[];
  source?: string;
}

const TRANSLATION_JOB_STORAGE_KEY = 'translationJob';
const TRANSLATION_RESUME_ALARM = 'translation-session-resume';
const TRANSLATION_RESUME_PERIOD_MINUTES = 0.5;
const TRANSLATION_RESUME_AFTER_MS = 45_000;

class SubtitleExtensionBackground {
  private readonly translationCoordinator: BrowserTranslationCoordinator;

  constructor() {
    this.translationCoordinator = new BrowserTranslationCoordinator(
      translationSessionAdapter,
      {
        getProgress: async () => {
          const result = await chrome.storage.local.get(['translationProgress']);
          return (result.translationProgress as TranslationProgress) || null;
        },
        saveProgress: async (progress) => {
          await chrome.storage.local.set({ translationProgress: progress });
        },
        clearProgress: async () => {
          await chrome.storage.local.remove('translationProgress');
        },
        getPendingJob: async () => {
          const result = await chrome.storage.local.get([TRANSLATION_JOB_STORAGE_KEY]);
          return (result[TRANSLATION_JOB_STORAGE_KEY] as BrowserTranslationJob) || null;
        },
        savePendingJob: async (job) => {
          const result = await chrome.storage.local.get([TRANSLATION_JOB_STORAGE_KEY]);
          const current = result[TRANSLATION_JOB_STORAGE_KEY] as BrowserTranslationJob | undefined;
          if (!current || current.id === job.id || current.updatedAt <= job.updatedAt) {
            await chrome.storage.local.set({ [TRANSLATION_JOB_STORAGE_KEY]: job });
          }
        },
        clearPendingJob: async (jobId) => {
          if (!jobId) {
            await chrome.storage.local.remove(TRANSLATION_JOB_STORAGE_KEY);
            return;
          }

          const result = await chrome.storage.local.get([TRANSLATION_JOB_STORAGE_KEY]);
          const current = result[TRANSLATION_JOB_STORAGE_KEY] as BrowserTranslationJob | undefined;
          if (!current || current.id === jobId) {
            await chrome.storage.local.remove(TRANSLATION_JOB_STORAGE_KEY);
          }
        },
        getVideoResult: async (videoId) => {
          const key = this.videoSubtitleKey(videoId);
          const result = await chrome.storage.local.get([key]);
          return (result[key] as VideoSubtitleData) || null;
        },
        saveVideoResult: async (videoId, result) => {
          const key = this.videoSubtitleKey(videoId);
          const stored = await chrome.storage.local.get(null);
          const staleKeys = Object.keys(stored).filter(
            (storedKey) => storedKey.startsWith('videoSubtitles_') && storedKey !== key
          );
          await chrome.storage.local.set({ [key]: result });
          if (staleKeys.length > 0) {
            await chrome.storage.local.remove(staleKeys);
          }
        },
        clearVideoResult: async (videoId) => {
          await chrome.storage.local.remove(this.videoSubtitleKey(videoId));
        },
      },
      {
        clear: async (tabId, event) => {
          await this.notifyContentScript('clearData', {
            ...(event ? { translationRunEvent: event } : {}),
          }, tabId);
        },
        publishPartial: async (tabId, partial, context) => {
          await this.publishTranslationResult('appendBilingualSubtitles', tabId, partial, context);
        },
        publishFinal: async (tabId, result, context) => {
          await this.publishTranslationResult('loadBilingualSubtitles', tabId, result, context);
        },
      }
    );
    this.init();
  }

  private videoSubtitleKey(videoId: string): string {
    return `videoSubtitles_${videoId}`;
  }

  private async publishTranslationResult(
    action: 'appendBilingualSubtitles' | 'loadBilingualSubtitles',
    tabId: number | undefined,
    result: ExtensionBilingualSubtitles,
    publication: TranslationRunPublication
  ): Promise<void> {
    await this.notifyContentScript(action, {
      englishSubtitles: result.english,
      chineseSubtitles: result.chinese,
      translationRunId: publication.runId,
    }, tabId, publication.signal);
  }

  init(): void {
    chrome.runtime.onInstalled.addListener((details) => {
      if (details.reason === 'install') {
        this.onInstall();
      } else if (details.reason === 'update') {
        this.onUpdate();
      }
    });

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      this.handleMessage(request, sender, sendResponse);
      return true;
    });

    chrome.runtime.onStartup?.addListener(() => {
      void this.resumePendingTranslation();
    });

    if (chrome.alarms) {
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === TRANSLATION_RESUME_ALARM) {
          void this.resumePendingTranslation();
        }
      });
      void chrome.alarms.create(TRANSLATION_RESUME_ALARM, {
        periodInMinutes: TRANSLATION_RESUME_PERIOD_MINUTES,
      });
    }

    // Service worker 每次被重新唤醒时都主动检查一次；alarm 负责覆盖“运行中途被回收”的情况。
    void this.resumePendingTranslation();
  }

  onInstall(): void {
    chrome.storage.local.clear().then(() => {
      chrome.storage.local.set({
        subtitleEnabled: false,
        subtitleData: [],
        englishSubtitles: [],
        chineseSubtitles: [],
        englishSettings: getDefaultEnglishSettings(),
        chineseSettings: getDefaultChineseSettings(),
        autoLoadEnabled: false,
      });
    });
  }

  onUpdate(): void {
    void this.migrateConfigOnUpdate();
  }

  private async migrateConfigOnUpdate(): Promise<void> {
    try {
      const res = await chrome.storage.local.get(['apiConfig', 'englishSettings']);
      const migration = migrateApiConfig((res.apiConfig as Partial<ApiConfig>) || {});
      const english = (res.englishSettings as SubtitleStyleSettings) || {};
      const needsFix = !english.fontFamily || english.fontFamily === 'inherit';
      const updates: Record<string, unknown> = {};

      if (migration.changed) {
        updates.apiConfig = migration.config;
      }

      if (needsFix) {
        updates.englishSettings = {
          ...getDefaultEnglishSettings(),
          ...english,
          fontFamily: '"Noto Serif", Georgia, serif',
        };
      }

      if (Object.keys(updates).length === 0) return;
      await chrome.storage.local.set(updates);

      const fixed = updates.englishSettings as SubtitleStyleSettings | undefined;
      if (fixed) {
        try {
          await this.notifyContentScript('updateSettings', { language: 'english', settings: fixed });
        } catch {
          // 忽略通知错误
        }
      }
    } catch (error) {
      console.warn('更新扩展配置失败，保留现有配置:', error);
    }
  }

  async handleMessage(
    request: ChromeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ): Promise<void> {
    const sourceTabId = sender.tab?.id;
    try {
      switch (request.action) {
        case 'getSubtitleData': {
          const data = await this.getSubtitleData();
          sendResponse({ success: true, data });
          break;
        }

        case 'getBilingualSubtitleData': {
          const bilingualData = await this.getBilingualSubtitleData();
          sendResponse({ success: true, data: bilingualData });
          break;
        }

        case 'saveSubtitleData':
          await this.saveSubtitleData(request.data as SimpleSubtitleEntry[]);
          await this.notifyContentScript('loadSubtitle', { subtitleData: request.data }, sourceTabId);
          sendResponse({ success: true });
          break;

        case 'saveBilingualSubtitles':
          await this.saveBilingualSubtitles(
            request.englishSubtitles || [],
            request.chineseSubtitles || []
          );
          await this.notifyContentScript('loadBilingualSubtitles', {
            englishSubtitles: request.englishSubtitles,
            chineseSubtitles: request.chineseSubtitles,
          }, sourceTabId);
          sendResponse({ success: true });
          break;

        case 'saveVideoSubtitles':
          await this.saveVideoSubtitles(
            request.videoId || '',
            request.englishSubtitles,
            request.chineseSubtitles,
            request.subtitleData
          );
          sendResponse({ success: true });
          break;

        case 'toggleSubtitle':
          await this.toggleSubtitle(request.enabled || false, sourceTabId);
          sendResponse({ success: true });
          break;

        case 'updateSettings':
          if (request.settings) {
            await this.updateSettings(request.settings, sourceTabId);
          }
          sendResponse({ success: true });
          break;

        case 'clearSubtitleData':
          await this.clearSubtitleData(sourceTabId);
          sendResponse({ success: true });
          break;

        case 'forceReset':
          await this.forceReset(sourceTabId);
          sendResponse({ success: true });
          break;

        case 'setSubtitleEnabled':
          await this.setSubtitleEnabled(request.enabled || false);
          sendResponse({ success: true });
          break;

        case 'autoLoadSuccess':
        case 'autoLoadError':
          break;

        case 'logSubtitleFetchSource':
          this.logSubtitleFetchSource(request, sender);
          sendResponse({ success: true });
          break;

        case 'startTranslation':
          void this.startBackgroundTranslation(request, sourceTabId, sendResponse).catch((error) => {
            console.error('后台翻译启动失败:', error);
            sendResponse({ success: false, error: (error as Error).message });
          });
          break;

        case 'cancelTranslation':
          await this.cancelBackgroundTranslation(request, sourceTabId, sendResponse);
          break;

        case 'getTranslationStatus': {
          const status = await this.translationCoordinator.status({ videoId: request.videoId });
          sendResponse({
            success: true,
            status,
            progress: status.progress,
          });
          break;
        }

        default:
          sendResponse({ success: false, error: '未知操作' });
      }
    } catch (error) {
      console.error('处理消息时出错:', error);
      sendResponse({ success: false, error: (error as Error).message });
    }
  }

  async getBilingualSubtitleData(): Promise<{
    subtitleData: SimpleSubtitleEntry[];
    englishSubtitles: SimpleSubtitleEntry[];
    chineseSubtitles: SimpleSubtitleEntry[];
    subtitleEnabled: boolean;
    englishSettings: SubtitleStyleSettings;
    chineseSettings: SubtitleStyleSettings;
  }> {
    const result = await chrome.storage.local.get([
      'subtitleData',
      'englishSubtitles',
      'chineseSubtitles',
      'subtitleEnabled',
      'englishSettings',
      'chineseSettings',
    ]);
    return {
      subtitleData: (result.subtitleData as SimpleSubtitleEntry[]) || [],
      englishSubtitles: (result.englishSubtitles as SimpleSubtitleEntry[]) || [],
      chineseSubtitles: (result.chineseSubtitles as SimpleSubtitleEntry[]) || [],
      subtitleEnabled: (result.subtitleEnabled as boolean) || false,
      englishSettings: (result.englishSettings as SubtitleStyleSettings) || {},
      chineseSettings: (result.chineseSettings as SubtitleStyleSettings) || {},
    };
  }

  async getSubtitleData(): Promise<{
    subtitleData: SimpleSubtitleEntry[];
    subtitleEnabled: boolean;
    subtitleSettings: Record<string, unknown>;
  }> {
    const result = await chrome.storage.local.get([
      'subtitleData',
      'subtitleEnabled',
      'subtitleSettings',
    ]);
    return {
      subtitleData: (result.subtitleData as SimpleSubtitleEntry[]) || [],
      subtitleEnabled: (result.subtitleEnabled as boolean) || false,
      subtitleSettings: (result.subtitleSettings as Record<string, unknown>) || {},
    };
  }

  logSubtitleFetchSource(request: ChromeMessage, sender: chrome.runtime.MessageSender): void {
    const payload = typeof request.data === 'object' && request.data !== null
        ? request.data as {
          source?: 'caption-tracks' | 'transcript-panel' | 'unavailable';
          subtitleCount?: number;
          strategy?: string;
          trackLanguageCode?: string;
          trackKind?: string;
          fallbackReason?: string;
          captionTrackError?: string;
          panelError?: string;
        }
      : {};
    const pageUrl = sender.tab?.url || 'unknown-url';
    const videoId = request.videoId || 'unknown-video';

    console.info(formatSubtitleFetchLog({
      source: payload.source || 'unavailable',
      subtitleCount: payload.subtitleCount || 0,
      strategy: payload.strategy,
      trackLanguageCode: payload.trackLanguageCode,
      trackKind: payload.trackKind,
      fallbackReason: payload.fallbackReason,
      captionTrackError: payload.captionTrackError,
      panelError: payload.panelError,
    }, videoId, pageUrl));
  }

  async saveVideoSubtitles(
    videoId: string,
    englishSubtitles?: SimpleSubtitleEntry[],
    chineseSubtitles?: SimpleSubtitleEntry[],
    subtitleData?: SimpleSubtitleEntry[]
  ): Promise<void> {
    if (!videoId) {
      console.error('❌ 保存字幕失败: 缺少视频ID');
      return;
    }

    const subtitleKey = `videoSubtitles_${videoId}`;
    const videoSubtitleData: VideoSubtitleData = {
      videoId,
      timestamp: new Date().toISOString(),
    };

    if (englishSubtitles || chineseSubtitles) {
      videoSubtitleData.englishSubtitles = englishSubtitles || [];
      videoSubtitleData.chineseSubtitles = chineseSubtitles || [];
    }

    if (subtitleData) {
      videoSubtitleData.subtitleData = subtitleData;
    }

    await chrome.storage.local.set({ [subtitleKey]: videoSubtitleData });

    if (englishSubtitles || chineseSubtitles) {
      await this.notifyContentScript('loadBilingualSubtitles', {
        englishSubtitles: englishSubtitles || [],
        chineseSubtitles: chineseSubtitles || [],
      });
    }
  }

  async saveBilingualSubtitles(
    englishSubtitles: SimpleSubtitleEntry[],
    chineseSubtitles: SimpleSubtitleEntry[]
  ): Promise<void> {
    await chrome.storage.local.set({
      englishSubtitles: englishSubtitles || [],
      chineseSubtitles: chineseSubtitles || [],
    });
  }

  async saveSubtitleData(data: SimpleSubtitleEntry[]): Promise<void> {
    await chrome.storage.local.set({ subtitleData: data });
  }

  async toggleSubtitle(enabled: boolean, tabId?: number): Promise<void> {
    await chrome.storage.local.set({ subtitleEnabled: enabled });
    await this.notifyContentScript('toggleSubtitle', { enabled }, tabId);
  }

  async setSubtitleEnabled(enabled: boolean): Promise<void> {
    await chrome.storage.local.set({ subtitleEnabled: enabled });
  }

  async updateSettings(settings: {
    language: 'english' | 'chinese';
    data: Partial<SubtitleStyleSettings>;
  }, tabId?: number): Promise<void> {
    if (settings.language === 'english') {
      const currentSettings = await chrome.storage.local.get(['englishSettings']);
      const newSettings = {
        ...((currentSettings.englishSettings as SubtitleStyleSettings) || {}),
        ...settings.data,
      };

      await chrome.storage.local.set({ englishSettings: newSettings });
      await this.notifyContentScript('updateSettings', {
        language: 'english',
        settings: newSettings,
      }, tabId);
    } else if (settings.language === 'chinese') {
      const currentSettings = await chrome.storage.local.get(['chineseSettings']);
      const newSettings = {
        ...((currentSettings.chineseSettings as SubtitleStyleSettings) || {}),
        ...settings.data,
      };

      await chrome.storage.local.set({ chineseSettings: newSettings });
      await this.notifyContentScript('updateSettings', {
        language: 'chinese',
        settings: newSettings,
      }, tabId);
    }
  }

  async clearSubtitleData(tabId?: number): Promise<void> {
    const allData = await chrome.storage.local.get(null);
    const videoSubtitleKeys = Object.keys(allData).filter((key) =>
      key.startsWith('videoSubtitles_')
    );

    await chrome.storage.local.set({
      subtitleData: [],
      englishSubtitles: [],
      chineseSubtitles: [],
    });

    if (videoSubtitleKeys.length > 0) {
      await chrome.storage.local.remove(videoSubtitleKeys);
    }

    await this.notifyContentScript('clearData', {}, tabId);
  }

  async forceReset(tabId?: number): Promise<void> {
    await chrome.storage.local.clear();

    await chrome.storage.local.set({
      subtitleEnabled: false,
      subtitleData: [],
      englishSubtitles: [],
      chineseSubtitles: [],
      englishSettings: getDefaultEnglishSettings(),
      chineseSettings: getDefaultChineseSettings(),
      autoLoadEnabled: false,
    });

    await this.notifyContentScript('forceReset', {}, tabId);
  }

  async notifyContentScript(
    action: string,
    data: Record<string, unknown> = {},
    tabId?: number,
    signal?: CancellationSignal
  ): Promise<void> {
    try {
      if (signal?.aborted) return;

      let targetTabId = tabId;
      if (!targetTabId) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = tabs[0]?.id;
      }

      if (targetTabId) {
        if (signal?.aborted) return;
        const tab = await chrome.tabs.get(targetTabId).catch(() => null);
        if (tab && this.isYouTubePage(tab.url)) {
          if (signal?.aborted) return;
          await chrome.tabs.sendMessage(targetTabId, {
            action,
            ...data,
          });
        }
      }
    } catch (error) {
      console.warn('向content script发送消息失败，继续等待后续同步:', error);
    }
  }

  isYouTubePage(url?: string): boolean {
    return !!url && (url.includes('youtube.com/watch') || url.includes('youtu.be/'));
  }

  async startBackgroundTranslation(
    request: ChromeMessage,
    sourceTabId: number | undefined,
    sendResponse: (response: unknown) => void
  ): Promise<void> {
    const { subtitles, targetLanguage, videoId, apiConfig } = request;

    if (!subtitles || subtitles.length === 0) {
      sendResponse({ success: false, error: '没有字幕数据' });
      return;
    }

    const normalizedApiConfig = apiConfig
      ? (assertApiConfigUsesRemoteEndpoints(apiConfig), migrateApiConfig(apiConfig).config)
      : undefined;

    if (apiConfig) {
      await chrome.storage.local.set({ apiConfig: normalizedApiConfig });
    }

    const targetTabId = sourceTabId || (await chrome.tabs.query({
      active: true,
      currentWindow: true,
    }))[0]?.id;

    const startRequest = {
      subtitles,
      targetLanguage: targetLanguage || 'zh',
      videoId,
      tabId: targetTabId,
      apiConfig: normalizedApiConfig,
      videoInfo: request.videoInfo,
    };
    let responseSent = false;
    const sendStartedResponse = (): void => {
      if (responseSent) return;
      responseSent = true;
      sendResponse({ success: true, message: '翻译已在后台启动' });
    };

    // start 会先将可恢复任务写入 storage，再通过回调确认启动响应；
    // 长任务本身仍异步运行，但不会再出现“先回复、后持久化”的空窗期。
    void this.translationCoordinator.start(startRequest, undefined, sendStartedResponse).catch((error) => {
      console.error('后台 Translation session 运行失败:', error);
      if (!responseSent) {
        responseSent = true;
        sendResponse({ success: false, error: (error as Error).message });
      }
    });
  }

  private async resumePendingTranslation(): Promise<void> {
    const result = await chrome.storage.local.get([TRANSLATION_JOB_STORAGE_KEY]);
    const pendingJob = result[TRANSLATION_JOB_STORAGE_KEY] as BrowserTranslationJob | undefined;
    if (!pendingJob || !pendingJob.request?.subtitles?.length) {
      return;
    }

    const age = Date.now() - pendingJob.updatedAt;
    if (age < TRANSLATION_RESUME_AFTER_MS) {
      return;
    }

    if (age > 24 * 60 * 60 * 1000) {
      await chrome.storage.local.remove(TRANSLATION_JOB_STORAGE_KEY);
      return;
    }

    try {
      if (pendingJob.request.apiConfig) {
        assertApiConfigUsesRemoteEndpoints(pendingJob.request.apiConfig);
        const migration = migrateApiConfig(pendingJob.request.apiConfig);
        if (migration.changed) {
          await chrome.storage.local.set({
            [TRANSLATION_JOB_STORAGE_KEY]: {
              ...pendingJob,
              request: {
                ...pendingJob.request,
                apiConfig: migration.config,
              },
            },
          });
        }
      }
    } catch (error) {
      await chrome.storage.local.remove(TRANSLATION_JOB_STORAGE_KEY);
      await chrome.storage.local.set({
        translationProgress: {
          isTranslating: false,
          videoId: pendingJob.request.videoId,
          error: `已停止恢复无效 API 任务: ${(error as Error).message}`,
          timestamp: Date.now(),
        },
      });
      return;
    }

    try {
      const resumed = await this.translationCoordinator.resumePendingJob();
      if (resumed) {
        console.info(`恢复中断的 Translation session: ${pendingJob.id}`);
      }
    } catch (error) {
      console.error('恢复后台 Translation session 失败:', error);
    }
  }

  async cancelBackgroundTranslation(
    request: ChromeMessage,
    sourceTabId: number | undefined,
    sendResponse: (response: unknown) => void
  ): Promise<void> {
    const targetTabId = sourceTabId || (await chrome.tabs.query({
      active: true,
      currentWindow: true,
    }))[0]?.id;
    await this.translationCoordinator.cancel({
      videoId: request.videoId,
      tabId: targetTabId,
    });
    sendResponse({ success: true });
  }
}

// 初始化 background 服务
new SubtitleExtensionBackground();
