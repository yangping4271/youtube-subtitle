/**
 * YouTube Subtitle Translator - Main World 注入脚本
 * 在页面上下文中运行，可访问 YouTube 的自定义元素属性
 */
interface YouTubeEngagementPanel extends HTMLElement {
  visibility?: string;
}

interface YouTubePageWindow extends Window {
  ytInitialPlayerResponse?: unknown;
  ytInitialData?: unknown;
  ytcfg?: {
    get?(key: string): unknown;
  };
}

interface YouTubePlayerElement extends HTMLElement {
  getPlayerResponse?: () => unknown;
}

interface YouTubeAppElement extends HTMLElement {
  resolveCommand?: (command: unknown) => unknown;
}

interface YouTubeDataElement extends HTMLElement {
  data?: {
    command?: {
      commandExecutorCommand?: {
        commands?: Array<{
          updateEngagementPanelContentCommand?: {
            contentSourcePanelIdentifier?: {
              tag?: string;
            };
            globalConfiguration?: {
              params?: string;
            };
          };
        }>;
      };
    };
  };
}

async function createYouTubeAuthorizationHeader(): Promise<string | null> {
  const sapisid = document.cookie.match(
    /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/
  )?.[1];
  if (!sapisid) {
    return null;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(`${timestamp} ${sapisid} https://www.youtube.com`)
  );
  const hash = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');

  return `SAPISIDHASH ${timestamp}_${hash}`;
}

interface TranscriptPanelRequest {
  panelId: string;
  params: string;
}

interface LegacyTranscriptRequest {
  getTranscriptEndpoint: {
    params: string;
  };
}

function readTranscriptPanelRequest(command: unknown): TranscriptPanelRequest | null {
  if (!command || typeof command !== 'object') {
    return null;
  }

  const panelCommand = (
    command as {
      updateEngagementPanelContentCommand?: {
        contentSourcePanelIdentifier?: {
          tag?: string;
        };
        globalConfiguration?: {
          params?: string;
        };
      };
    }
  ).updateEngagementPanelContentCommand;
  const panelId = panelCommand?.contentSourcePanelIdentifier?.tag;
  const params = panelCommand?.globalConfiguration?.params;

  return typeof panelId === 'string' && typeof params === 'string'
    ? { panelId, params }
    : null;
}

function findTranscriptPanelRequestInData(data: unknown): TranscriptPanelRequest | null {
  const pending: unknown[] = [data];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) {
      continue;
    }
    seen.add(value);

    const request = readTranscriptPanelRequest(value);
    if (request) {
      return request;
    }

    pending.push(...Object.values(value));
  }

  return null;
}

function findTranscriptPanelRequest(): TranscriptPanelRequest | null {
  const transcriptButton = Array.from(document.querySelectorAll('button')).find((button) => {
    const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`;
    return /show transcript|内容转文字|转写文稿|文字记录/i.test(label);
  });
  const commands = (
    transcriptButton?.closest('ytd-button-renderer') as YouTubeDataElement | null
  )?.data?.command?.commandExecutorCommand?.commands;
  for (const command of commands || []) {
    const request = readTranscriptPanelRequest(command);
    if (request) {
      return request;
    }
  }

  return findTranscriptPanelRequestInData(
    (window as YouTubePageWindow).ytInitialData
  );
}

function findLegacyTranscriptRequest(data: unknown): LegacyTranscriptRequest | null {
  const pending: unknown[] = [data];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) {
      continue;
    }
    seen.add(value);

    const endpoint = (value as LegacyTranscriptRequest).getTranscriptEndpoint;
    if (typeof endpoint?.params === 'string') {
      return value as LegacyTranscriptRequest;
    }

    pending.push(...Object.values(value));
  }

  return null;
}

window.addEventListener('YTSP_OpenTranscript', () => {
  const engagementPanel = document.querySelector(
    'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"], ' +
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
  ) as YouTubeEngagementPanel | null;

  if (engagementPanel) {
    engagementPanel.visibility = 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
  }
});

window.addEventListener('YTSP_StartTranslation', () => {
  window.postMessage({ type: 'YTSP_StartTranslation' }, '*');
});

window.addEventListener('YTSP_RequestTranscriptPanel', async () => {
  const pageWindow = window as YouTubePageWindow;
  const player = document.getElementById('movie_player') as YouTubePlayerElement | null;
  const playerResponse = (
    player?.getPlayerResponse?.() || pageWindow.ytInitialPlayerResponse
  ) as {
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{ languageCode?: string }>;
      };
    };
  } | null;
  const tracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (
    tracks.length > 0 &&
    !tracks.some((track) => /^en(?:-|$)/i.test(track.languageCode || ''))
  ) {
    window.postMessage({
      type: 'YTSP_TranscriptPanelResponse',
      payload: { status: 'english-unavailable' },
    }, '*');
    return;
  }

  const context = pageWindow.ytcfg?.get?.('INNERTUBE_CONTEXT');
  const request = findTranscriptPanelRequest();
  const legacyRequest = findLegacyTranscriptRequest(pageWindow.ytInitialData);
  const clientName = pageWindow.ytcfg?.get?.('INNERTUBE_CLIENT_NAME');
  const clientVersion = pageWindow.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION');

  if (!request && legacyRequest) {
    const app = document.querySelector('ytd-app') as YouTubeAppElement | null;
    if (typeof app?.resolveCommand === 'function') {
      try {
        app.resolveCommand(legacyRequest);
        window.postMessage({
          type: 'YTSP_TranscriptPanelResponse',
          payload: { status: 'dom-loading' },
        }, '*');
        return;
      } catch {
        // 继续返回 unavailable，让 content script 使用可视面板兜底。
      }
    }
  }

  if (!context || !request) {
    window.postMessage({
      type: 'YTSP_TranscriptPanelResponse',
      payload: { status: 'unavailable' },
    }, '*');
    return;
  }

  try {
    const authorization = await createYouTubeAuthorizationHeader();
    const response = await fetch('/youtubei/v1/get_panel?prettyPrint=false', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Origin': 'https://www.youtube.com',
        ...(authorization ? { Authorization: authorization } : {}),
        ...(typeof clientName === 'string' || typeof clientName === 'number'
          ? { 'X-Youtube-Client-Name': String(clientName) }
          : {}),
        ...(typeof clientVersion === 'string'
          ? { 'X-Youtube-Client-Version': clientVersion }
          : {}),
      },
      body: JSON.stringify({
        context,
        panelId: request.panelId,
        params: request.params,
      }),
    });
    window.postMessage({
      type: 'YTSP_TranscriptPanelResponse',
      payload: response.ok
        ? { status: 'ok', response: await response.json() }
        : { status: 'unavailable' },
    }, '*');
  } catch {
    window.postMessage({
      type: 'YTSP_TranscriptPanelResponse',
      payload: { status: 'unavailable' },
    }, '*');
  }
});
