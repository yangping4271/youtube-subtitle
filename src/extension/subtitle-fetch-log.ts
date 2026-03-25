export type SubtitleFetchSource = 'caption-tracks' | 'transcript-panel' | 'unavailable';

export interface SubtitleFetchLogPayload {
  source: SubtitleFetchSource;
  subtitleCount: number;
  fallbackReason?: string;
  captionTrackError?: string;
  panelError?: string;
}

export function normalizeSubtitleFetchErrorMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

export function formatSubtitleFetchLog(
  payload: SubtitleFetchLogPayload,
  videoId: string,
  pageUrl: string
): string {
  const parts = [
    `[SubtitleFetch] source=${payload.source}`,
    `subtitles=${payload.subtitleCount}`,
    `videoId=${videoId}`,
    `url=${pageUrl}`,
  ];

  if (payload.fallbackReason) {
    parts.push(`fallbackReason=${payload.fallbackReason}`);
  }

  if (payload.captionTrackError) {
    parts.push(`captionTrackError=${payload.captionTrackError}`);
  }

  if (payload.panelError) {
    parts.push(`panelError=${payload.panelError}`);
  }

  return parts.join(' ');
}
