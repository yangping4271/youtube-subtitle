/**
 * YouTube Subtitle Translator - Main World 注入脚本
 * 在页面上下文中运行，可访问 YouTube 的自定义元素属性
 */
interface YouTubeEngagementPanel extends HTMLElement {
  visibility?: string;
}

interface YouTubePageWindow extends Window {
  ytInitialPlayerResponse?: unknown;
  ytcfg?: {
    get?(key: string): unknown;
  };
}

interface YouTubePlayerElement extends HTMLElement {
  getPlayerResponse?: () => unknown;
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

window.addEventListener('YTSP_OpenTranscript', () => {
  const engagementPanel = document.querySelector(
    'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"], ' +
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
  ) as YouTubeEngagementPanel | null;

  if (engagementPanel) {
    engagementPanel.visibility = 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
  } else {
    console.warn('YouTube SubtitlePlus: Engagement panel not found in Main World.');
  }
});

window.addEventListener('YTSP_StartTranslation', () => {
  window.postMessage({ type: 'YTSP_StartTranslation' }, '*');
});

window.addEventListener('YTSP_RequestCaptionTracks', () => {
  const pageWindow = window as YouTubePageWindow;
  const player = document.getElementById('movie_player') as YouTubePlayerElement | null;
  const playerResponse = player?.getPlayerResponse?.() || pageWindow.ytInitialPlayerResponse || null;

  window.postMessage({
    type: 'YTSP_PageCaptionTracks',
    payload: playerResponse,
  }, '*');
});

window.addEventListener('YTSP_RequestWebPlayerResponse', async (event) => {
  const videoId = (event as CustomEvent<{ videoId?: unknown }>).detail?.videoId;
  const pageWindow = window as YouTubePageWindow;
  const context = pageWindow.ytcfg?.get?.('INNERTUBE_CONTEXT');
  const apiKey = pageWindow.ytcfg?.get?.('INNERTUBE_API_KEY');
  const clientName = pageWindow.ytcfg?.get?.('INNERTUBE_CLIENT_NAME');
  const clientVersion = pageWindow.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION');

  if (typeof videoId !== 'string' || !context || typeof apiKey !== 'string') {
    window.postMessage({ type: 'YTSP_WebPlayerResponse', payload: null }, '*');
    return;
  }

  try {
    const authorization = await createYouTubeAuthorizationHeader();
    const response = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
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
      body: JSON.stringify({ context, videoId }),
    });
    window.postMessage({
      type: 'YTSP_WebPlayerResponse',
      payload: response.ok ? await response.json() : null,
    }, '*');
  } catch {
    window.postMessage({ type: 'YTSP_WebPlayerResponse', payload: null }, '*');
  }
});
