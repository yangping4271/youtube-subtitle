/**
 * YouTube Subtitle Translator - Main World 注入脚本
 * 在页面上下文中运行，可访问 YouTube 的自定义元素属性
 */
interface YouTubeEngagementPanel extends HTMLElement {
  visibility?: string;
}

window.addEventListener('YTSP_OpenTranscript', () => {
  const engagementPanel = document.querySelector(
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
