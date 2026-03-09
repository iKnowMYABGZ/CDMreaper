# DMCA Evidence Capture Tool

## One-Time Setup
npm install
npx playwright install chromium

## Single URL
node index.js --url "https://site.com/video/123"

## Batch from file (one URL per line in urls.txt)
node index.js --file urls.txt

## Custom output folder
node index.js --url "https://..." --out ./cases/client-smith

## Skip media download (faster)
node index.js --url "https://..." --no-media

## Slow sites — increase wait time (ms)
node index.js --url "https://..." --wait 10000

## What gets saved per URL
- REPORT.txt              human-readable summary
- screenshot_fullpage.png full scrollable page
- screenshot_viewport.png above the fold
- video_thumbnail_0.png   actual video frame
- og_image.jpg            site preview image
- metadata.json           title, URL, OG tags, timestamp
- media_urls.json         all intercepted stream URLs
- media.mp4               downloaded media (if not encrypted)
- evidence_log.json       full activity log

## HLS/DASH streams
Install ffmpeg and add to PATH: https://ffmpeg.org/download.html
The tool will use it automatically for .m3u8 and .mpd streams.
