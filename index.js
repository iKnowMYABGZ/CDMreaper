#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  } else {
    positional.push(args[i]);
  }
}

const urlArg   = flags.url   || positional[0];
const fileArg  = flags.file  || flags.f;
const outDir   = flags.out   || flags.o || './evidence';
const waitMs   = parseInt(flags.wait || '5000', 10);
const noMedia  = flags['no-media'] === true;

// ── Help ────────────────────────────────────────────────────────────────────
if (flags.help || flags.h || (!urlArg && !fileArg)) {
  console.log(`
  DMCA Evidence Capture Tool
  ──────────────────────────
  Usage:
    node index.js --url <url>              Capture a single URL
    node index.js --file <urls.txt>        Capture all URLs in a text file (one per line)

  Options:
    --out, -o   <dir>    Output directory (default: ./evidence)
    --wait      <ms>     Wait time for page load in ms (default: 5000)
    --no-media           Skip media file download (faster)
    --help, -h           Show this help

  Examples:
    node index.js --url "https://site.com/video/123"
    node index.js --file urls.txt --out ./cases/client-smith
  `);
  process.exit(0);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function sanitize(str) {
  return str.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 60);
}

function makeEvidenceDir(baseDir, url) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = sanitize(new URL(url).hostname + '_' + new URL(url).pathname);
  const dir = path.join(baseDir, `${ts}_${slug}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    const req = proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.abort(); reject(new Error('Download timeout')); });
  });
}

// ── Core capture function ────────────────────────────────────────────────────
async function captureEvidence(url, browser, baseDir) {
  const dir = makeEvidenceDir(baseDir, url);
  const log = [];
  const capturedMedia = [];

  function note(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log('  ' + line);
    log.push(line);
  }

  note(`Starting capture: ${url}`);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    recordVideo: undefined,
  });

  // ── Intercept all network requests ────────────────────────────────────────
  const mediaExtensions = ['.mp4', '.webm', '.mkv', '.mov', '.avi', '.m3u8', '.mpd', '.ts'];
  const mediaPatterns = ['video', 'media', 'stream', 'hls', 'dash', 'cdn', '.mp4', '.webm', '.m3u8', '.mpd'];

  context.on('request', (request) => {
    const reqUrl = request.url();
    const isMedia = mediaExtensions.some(e => reqUrl.includes(e)) ||
                    mediaPatterns.some(p => reqUrl.toLowerCase().includes(p));
    if (isMedia) {
      capturedMedia.push({
        url: reqUrl,
        method: request.method(),
        headers: request.headers(),
        resourceType: request.resourceType(),
      });
      note(`Media URL intercepted [${request.resourceType()}]: ${reqUrl.slice(0, 120)}`);
    }
  });

  const page = await context.newPage();

  try {
    // ── Navigate ─────────────────────────────────────────────────────────
    note('Navigating to page...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {
      note('Warning: networkidle timeout, continuing anyway');
    });

    // Extra wait for lazy-loaded players
    await page.waitForTimeout(waitMs);

    // ── Metadata ─────────────────────────────────────────────────────────
    note('Collecting page metadata...');
    const metadata = await page.evaluate(() => {
      const getMeta = (name) =>
        document.querySelector(`meta[name="${name}"]`)?.content ||
        document.querySelector(`meta[property="${name}"]`)?.content || null;
      const getOG = (prop) =>
        document.querySelector(`meta[property="og:${prop}"]`)?.content || null;

      return {
        url: window.location.href,
        title: document.title,
        capturedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        description: getMeta('description') || getOG('description'),
        ogTitle: getOG('title'),
        ogImage: getOG('image'),
        ogVideo: getOG('video') || getMeta('og:video'),
        ogSiteName: getOG('site_name'),
        canonicalUrl: document.querySelector('link[rel="canonical"]')?.href,
        videoElements: Array.from(document.querySelectorAll('video')).map(v => ({
          src: v.src || v.currentSrc,
          poster: v.poster,
          duration: v.duration,
          width: v.videoWidth,
          height: v.videoHeight,
          sources: Array.from(v.querySelectorAll('source')).map(s => ({ src: s.src, type: s.type })),
        })),
        iframes: Array.from(document.querySelectorAll('iframe')).map(f => f.src).filter(Boolean),
      };
    });

    fs.writeFileSync(
      path.join(dir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );
    note('Metadata saved → metadata.json');

    // ── Full page screenshot ─────────────────────────────────────────────
    note('Taking full-page screenshot...');
    await page.screenshot({
      path: path.join(dir, 'screenshot_fullpage.png'),
      fullPage: true,
    });
    note('Screenshot saved → screenshot_fullpage.png');

    // ── Viewport screenshot (above the fold) ─────────────────────────────
    await page.screenshot({
      path: path.join(dir, 'screenshot_viewport.png'),
      fullPage: false,
    });
    note('Viewport screenshot saved → screenshot_viewport.png');

    // ── Video element screenshots ─────────────────────────────────────────
    const videoEls = await page.$$('video');
    for (let i = 0; i < videoEls.length; i++) {
      try {
        // Try to play briefly to get a real frame
        await page.evaluate((el) => {
          el.muted = true;
          el.currentTime = 2;
          return el.play().catch(() => {});
        }, videoEls[i]);
        await page.waitForTimeout(1500);

        await videoEls[i].screenshot({
          path: path.join(dir, `video_thumbnail_${i}.png`),
        });
        note(`Video thumbnail ${i} saved → video_thumbnail_${i}.png`);
      } catch (e) {
        note(`Could not screenshot video element ${i}: ${e.message}`);
      }
    }

    // ── Poster/OG image download ─────────────────────────────────────────
    if (metadata.ogImage) {
      try {
        note(`Downloading OG image: ${metadata.ogImage}`);
        await downloadFile(metadata.ogImage, path.join(dir, 'og_image.jpg'));
        note('OG image saved → og_image.jpg');
      } catch (e) {
        note(`OG image download failed: ${e.message}`);
      }
    }

    // ── Save intercepted media URLs ───────────────────────────────────────
    if (capturedMedia.length > 0) {
      fs.writeFileSync(
        path.join(dir, 'media_urls.json'),
        JSON.stringify(capturedMedia, null, 2)
      );
      note(`${capturedMedia.length} media URL(s) saved → media_urls.json`);

      // ── Attempt media download ─────────────────────────────────────────
      if (!noMedia) {
        // Prefer direct mp4 over HLS
        const direct = capturedMedia.find(m =>
          ['.mp4', '.webm', '.mov'].some(e => m.url.includes(e))
        );
        const hls = capturedMedia.find(m => m.url.includes('.m3u8'));
        const mpd = capturedMedia.find(m => m.url.includes('.mpd'));

        if (direct) {
          note(`Downloading direct media: ${direct.url.slice(0, 100)}`);
          try {
            const ext = direct.url.includes('.webm') ? '.webm' : '.mp4';
            await downloadFile(direct.url, path.join(dir, `media${ext}`));
            note(`Media saved → media${ext}`);
          } catch (e) {
            note(`Direct media download failed: ${e.message}`);
          }
        } else if (hls || mpd) {
          // Try ffmpeg if available
          const streamUrl = (hls || mpd).url;
          note(`Stream URL found (${hls ? 'HLS' : 'DASH'}): ${streamUrl.slice(0, 100)}`);
          try {
            execSync('ffmpeg -version', { stdio: 'ignore' });
            note('ffmpeg found — downloading stream...');
            const outFile = path.join(dir, 'media.mp4');
            execSync(
              `ffmpeg -i "${streamUrl}" -c copy -bsf:a aac_adtstoasc "${outFile}" -y`,
              { stdio: 'pipe', timeout: 300000 }
            );
            note('Stream saved → media.mp4');
          } catch (e) {
            if (e.message.includes('ffmpeg')) {
              note('ffmpeg not found — stream URL saved to media_urls.json (install ffmpeg to auto-download)');
            } else {
              note(`Stream download failed: ${e.message.slice(0, 100)}`);
            }
          }
        } else {
          note('No downloadable media URL found on this page');
        }
      }
    } else {
      note('No media URLs intercepted — player may use MSE/EME (encrypted stream)');
    }

    // ── Write evidence log ────────────────────────────────────────────────
    const summary = {
      capturedUrl: url,
      capturedAt: new Date().toISOString(),
      evidenceDir: dir,
      filesCreated: fs.readdirSync(dir),
      mediaUrlsFound: capturedMedia.length,
      log,
    };
    fs.writeFileSync(path.join(dir, 'evidence_log.json'), JSON.stringify(summary, null, 2));

    // ── Human-readable report ─────────────────────────────────────────────
    const report = [
      '═══════════════════════════════════════════',
      '  DMCA EVIDENCE CAPTURE REPORT',
      '═══════════════════════════════════════════',
      `  URL:          ${url}`,
      `  Captured At:  ${summary.capturedAt}`,
      `  Page Title:   ${metadata.title || 'N/A'}`,
      `  OG Title:     ${metadata.ogTitle || 'N/A'}`,
      `  Canonical:    ${metadata.canonicalUrl || 'N/A'}`,
      `  Media URLs:   ${capturedMedia.length} intercepted`,
      '',
      '  Files:',
      ...summary.filesCreated.map(f => `    - ${f}`),
      '═══════════════════════════════════════════',
    ].join('\n');

    fs.writeFileSync(path.join(dir, 'REPORT.txt'), report);
    console.log('\n' + report);
    note('Done.');

    return summary;

  } catch (err) {
    note(`ERROR: ${err.message}`);
    fs.writeFileSync(path.join(dir, 'evidence_log.json'), JSON.stringify({ error: err.message, log }, null, 2));
    throw err;
  } finally {
    await context.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  let urls = [];

  if (fileArg) {
    if (!fs.existsSync(fileArg)) {
      console.error(`File not found: ${fileArg}`);
      process.exit(1);
    }
    urls = fs.readFileSync(fileArg, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && l.startsWith('http'));
    console.log(`Loaded ${urls.length} URL(s) from ${fileArg}`);
  }

  if (urlArg) {
    urls.unshift(urlArg);
  }

  if (urls.length === 0) {
    console.error('No valid URLs found.');
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\nLaunching browser...`);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins',
      '--disable-site-isolation-trials',
    ],
  });

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n[${i + 1}/${urls.length}] Processing: ${url}`);
    try {
      const result = await captureEvidence(url, browser, outDir);
      results.push({ url, status: 'ok', dir: result.evidenceDir });
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      results.push({ url, status: 'error', error: e.message });
    }
  }

  await browser.close();

  if (urls.length > 1) {
    console.log('\n══════════════ BATCH SUMMARY ══════════════');
    results.forEach(r => {
      const icon = r.status === 'ok' ? '✓' : '✗';
      console.log(`  ${icon} ${r.url.slice(0, 70)}`);
      if (r.dir)   console.log(`      → ${r.dir}`);
      if (r.error) console.log(`      Error: ${r.error}`);
    });
    console.log('═══════════════════════════════════════════\n');
    fs.writeFileSync(
      path.join(outDir, 'batch_summary.json'),
      JSON.stringify(results, null, 2)
    );
  }

  console.log(`\nAll evidence saved to: ${path.resolve(outDir)}\n`);
})();

