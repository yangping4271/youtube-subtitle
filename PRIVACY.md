# Privacy Policy

Last updated: March 24, 2026

This Privacy Policy applies to the `YouTube 字幕翻译` Chrome extension.

## What this extension does

This extension reads available subtitles or transcript content from the current YouTube video page, sends subtitle text to the translation API configured by the user, and displays bilingual subtitles on the YouTube page.

## Data we process

The extension may process the following data:

1. API credentials provided by the user
   - The user-configured OpenAI API key
   - The user-configured API base URL and model name
2. YouTube page content related to the current video
   - Available subtitles or transcript text
   - Basic current video information needed for subtitle processing
3. Local extension settings and cache
   - Target language
   - Subtitle style settings
   - Translation progress and cached subtitle results

## How data is used

We use the above data only to provide the extension's core functionality:

- identify the current YouTube video
- fetch available subtitles or transcript content
- submit subtitle text to the user-configured translation API
- display translated bilingual subtitles on the current page
- save local settings and cached results for the user

## Where data is stored

- API keys, settings, and subtitle cache are stored locally in the browser using Chrome extension storage.
- Subtitle text selected for translation is sent to the API endpoint configured by the user.

## Data sharing

We do not sell user data.

We do not use or transfer user data for purposes unrelated to the extension's single purpose.

When the user starts translation, subtitle text and the user-provided API credentials are transmitted to the translation service configured by the user, such as OpenAI, in order to generate translated subtitles.

## Data retention

Data is retained as follows:

- local settings remain in browser storage until changed or removed by the user
- cached subtitle results remain in browser storage until cleared, overwritten, or the extension is removed
- translation requests are only sent when triggered by the user

## User control

Users can control their data by:

- removing or updating the configured API key and model settings
- clearing cached subtitle data in the extension
- removing the extension from Chrome, which removes extension-managed local storage

## Security

We store extension data locally in Chrome storage and only send translation requests to the API endpoint configured by the user. However, users are responsible for choosing and trusting their own API provider and endpoint.

## Contact

For support or privacy questions, please use the project support page:

https://github.com/yangping4271/youtube-subtitle/issues
