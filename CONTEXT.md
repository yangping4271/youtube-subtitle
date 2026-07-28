# YouTube Subtitle Translation

This context covers acquiring YouTube subtitles, translating them, and presenting or exporting the resulting subtitle data.

## Language

**Subtitle acquisition（字幕获取）**:
Obtaining one ordered set of timed subtitle entries from the best available YouTube source, together with information about which source produced it.
_Avoid_: Subtitle fetch path, transcript scraping

**Subtitle output（字幕输出）**:
A user-facing representation derived from acquired subtitle entries, such as copied plain text or a downloaded SRT file.
_Avoid_: Subtitle acquisition

**Translation session（翻译会话）**:
One cancellable run that turns acquired subtitles into one complete, ordered bilingual result. Progress and partial results are observations of the run, not owners of its final state.
_Avoid_: Translator service, whole-run translation batch
