export function getVideoDescription(): string {
  try {
    for (const selector of [
      '#description yt-attributed-string',
      '#description-inline-expander yt-attributed-string',
    ]) {
      const description = document.querySelector(selector)?.textContent?.trim();
      if (description) return description;
    }
  } catch {}
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
  } catch {}
  return null;
}
