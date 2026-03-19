'use strict';

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');
const { renderProfessional, renderSocialExport, renderComparison } = require('./renderer');

// ── Viewport / UA ──────────────────────────────────────────────────────────────
const DESKTOP_VP = { width: 1440, height: 900, deviceScaleFactor: 2 };
const MOBILE_VP  = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false };
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

// ── Timeouts ──────────────────────────────────────────────────────────────────
const NAV_DCL_TIMEOUT     = 12000;  // domcontentloaded max wait
const NAV_RACE_TIMEOUT    = 8000;   // race: whichever wins first
const POST_LOAD_WAIT      = 800;    // fixed post-load wait (ms)
const OVERLAY_TIMEOUT     = 3000;
const SHOT_TIMEOUT        = 10000;
const GLOBAL_PAGE_TIMEOUT = 45000;
const GLOBAL_JOB_TIMEOUT  = 300000; // 5 min

// ── Concorrência ──────────────────────────────────────────────────────────────
const MAX_CONCURRENT = 2;

// ── Recursos a bloquear (tracking + fontes de terceiros) ──────────────────────
const BLOCK_PATTERN = /google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.net\/en_US|fbevents\.js|hotjar\.com|segment\.io|amplitude\.com|mixpanel\.com|newrelic\.js|sentry\.io\/api|clarity\.ms|ads\.twitter|snap\.licdn|bat\.bing\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/;

// ── Browser launch ────────────────────────────────────────────────────────────
function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-blink-features=AutomationControlled',
      '--disable-web-security', '--allow-running-insecure-content',
      '--disable-features=VizDisplayCompositor',
      '--window-size=1440,900', '--lang=pt-BR,pt,en-US',
    ],
  });
}

// ── Stealth patch ─────────────────────────────────────────────────────────────
async function applyStealthPatch(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver',          { get: () => undefined });
    Object.defineProperty(navigator, 'languages',          { get: () => ['pt-BR','pt','en-US','en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency',{ get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory',       { get: () => 8 });
    Object.defineProperty(navigator, 'platform',           { get: () => 'Win32' });
    if (!window.chrome) window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  });
}

// ── Bloqueio de recursos ───────────────────────────────────────────────────────
async function enableResourceBlocking(page) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    const rt  = req.resourceType();
    // Block tracking scripts and third-party font services
    if (BLOCK_PATTERN.test(url) && (rt === 'script' || rt === 'font' || rt === 'stylesheet')) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

// ── Dismiss overlays ──────────────────────────────────────────────────────────
async function dismissOverlays(page) {
  try {
    await page.evaluate(() => {
      const btnSels = [
        'button[id*="accept"],button[class*="accept"]',
        'button[id*="agree"],button[class*="agree"]',
        'button[id*="close"],button[class*="close"]',
        'button[id*="dismiss"],button[class*="dismiss"]',
        'button[aria-label*="close" i],button[aria-label*="fechar" i]',
        'a[id*="accept"],a[class*="accept"]',
      ];
      for (const sel of btnSels) {
        try { const b = document.querySelector(sel); if (b) b.click(); } catch {}
      }
      const rmSels = [
        '[id*="cookie"],[class*="cookie"]','[id*="consent"],[class*="consent"]',
        '[id*="gdpr"],[class*="gdpr"]','[role="dialog"],[role="alertdialog"]',
        '[class*="modal"],[class*="popup"],[class*="overlay"]',
      ];
      document.querySelectorAll(rmSels.join(',')).forEach(el => {
        try {
          const s = window.getComputedStyle(el);
          if ((s.position === 'fixed' || s.position === 'sticky') && parseInt(s.zIndex||0) > 50) el.remove();
        } catch {}
      });
    });
  } catch {}
}

// ── Scroll para lazy load ─────────────────────────────────────────────────────
async function triggerLazyLoad(page, maxH) {
  try {
    const total  = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)).catch(() => 900);
    const target = Math.min(total, maxH || 900 * 5);
    for (let pos = 0; pos < target; pos += 300) {
      await page.evaluate(y => window.scrollTo(0, y), pos);
      await new Promise(r => setTimeout(r, 50));
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 150));
  } catch {}
}

// ── Navegação agressiva: race entre domcontentloaded e timer de 8s ────────────
async function navigateFast(page, url) {
  let navError = null;
  await Promise.race([
    page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_DCL_TIMEOUT })
      .catch(err => { navError = err; }),
    new Promise(r => setTimeout(r, NAV_RACE_TIMEOUT)),
  ]);
  // Re-throw only for real network errors (not timeouts, which are expected)
  if (navError && !/timeout|TimeoutError/i.test(navError.message)) throw navError;
  // Fixed post-load wait for initial JS to run
  await new Promise(r => setTimeout(r, POST_LOAD_WAIT));
}

// ── Screenshot com limite de altura ──────────────────────────────────────────
async function screenshotLimited(page, filePath, maxH) {
  const totalH = await page.evaluate(() =>
    Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight)
  ).catch(() => 900);
  await page.screenshot({
    path: filePath, type: 'png',
    clip: { x: 0, y: 0, width: DESKTOP_VP.width, height: Math.min(totalH, maxH || 900 * 5) },
    timeout: SHOT_TIMEOUT,
  });
}

async function screenshotMobileLimited(page, filePath) {
  const totalH = await page.evaluate(() =>
    Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight)
  ).catch(() => 844);
  await page.screenshot({
    path: filePath, type: 'png',
    clip: { x: 0, y: 0, width: MOBILE_VP.width, height: Math.min(totalH, 844 * 5) },
    timeout: SHOT_TIMEOUT,
  });
}

// ── Setup page ────────────────────────────────────────────────────────────────
async function setupPage(browser, vp, ua) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_DCL_TIMEOUT);
  await applyStealthPatch(page);
  await page.setUserAgent(ua);
  await page.setViewport(vp);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8' });
  await enableResourceBlocking(page);
  return page;
}

// ── URL validation ────────────────────────────────────────────────────────────
function validateUrl(url) {
  if (!url || typeof url !== 'string') throw new Error('URL válida é obrigatória.');
  const t = url.trim();
  if (!t.startsWith('http://') && !t.startsWith('https://')) throw new Error('URL deve começar com http:// ou https://');
  try { new URL(t); } catch { throw new Error('Formato de URL inválido.'); }
  return t;
}

// ── Captura de página usando browser existente ────────────────────────────────
async function _capturePageWithBrowser(browser, validated, dir, cfg, applyWatermark) {
  const desktopRaw = path.join(dir, 'desktop-raw.png');
  const mobileRaw  = path.join(dir, 'mobile-raw.png');
  const desktopOut = path.join(dir, 'desktop-professional.png');
  const mobileOut  = path.join(dir, 'mobile-professional.png');
  const previewOut = path.join(dir, 'preview.png');

  let dp, mp;
  try {
    // Desktop capture
    dp = await setupPage(browser, DESKTOP_VP, DESKTOP_UA);
    await navigateFast(dp, validated);
    await Promise.race([dismissOverlays(dp), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
    await triggerLazyLoad(dp);
    const pageTitle = await dp.title().catch(() => validated);
    await screenshotLimited(dp, desktopRaw);
    await dp.close().catch(() => {}); dp = null;

    // Mobile capture
    mp = await setupPage(browser, MOBILE_VP, MOBILE_UA);
    await navigateFast(mp, validated);
    await Promise.race([dismissOverlays(mp), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
    await screenshotMobileLimited(mp, mobileRaw);
    await mp.close().catch(() => {}); mp = null;

    // Render templates (safeRender copia o raw como fallback se Puppeteer falhar)
    await safeRender({ screenshotPath: desktopRaw, deviceType: 'desktop', renderConfig: cfg, outputPath: desktopOut, pageUrl: validated, pageTitle, applyWatermark: !!applyWatermark }, desktopRaw);
    await safeRender({ screenshotPath: mobileRaw,  deviceType: 'mobile',  renderConfig: cfg, outputPath: mobileOut,  pageUrl: validated, pageTitle, applyWatermark: !!applyWatermark }, mobileRaw);
    await safeRender({ screenshotPath: desktopRaw, deviceType: 'desktop', renderConfig: { ...cfg, template: cfg.template || 'void' }, outputPath: previewOut, pageUrl: validated, pageTitle, applyWatermark: !!applyWatermark }, desktopRaw);

    if (cfg && cfg.socialExport) {
      const socialDir = path.join(dir, 'social');
      fs.mkdirSync(socialDir, { recursive: true });
      for (const fmt of ['twitter','linkedin','instagram-square','instagram-story','og']) {
        await renderSocialExport({ screenshotPath: desktopRaw, format: fmt, outputPath: path.join(socialDir, `${fmt}.png`), pageUrl: validated, pageTitle }).catch(() => {});
      }
    }

    try { fs.unlinkSync(desktopRaw); } catch {}
    try { fs.unlinkSync(mobileRaw);  } catch {}

    return { desktopPath: desktopOut, mobilePath: mobileOut, previewPath: previewOut, pageTitle, url: validated };
  } finally {
    if (dp) await dp.close().catch(() => {});
    if (mp) await mp.close().catch(() => {});
  }
}

// ── Render com fallback ───────────────────────────────────────────────────────
// Se renderProfessional falhar (Puppeteer OOM, base64 muito grande, etc.),
// copia o raw screenshot para o outputPath para que o ZIP não fique vazio.
async function safeRender(opts, rawFallback) {
  try {
    return await renderProfessional(opts);
  } catch (err) {
    console.error(`[render] FALHOU ${path.basename(opts.outputPath)}: ${err.message}`);
    try { fs.copyFileSync(rawFallback, opts.outputPath); } catch {}
    return opts.outputPath;
  }
}

// ── Semáforo ──────────────────────────────────────────────────────────────────
function makeSemaphore(limit) {
  let active = 0;
  return {
    async acquire() {
      while (active >= limit) await new Promise(r => setTimeout(r, 200));
      active++;
    },
    release() { active--; },
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// captureJobPages — browser único por job, paralelo com semáforo de 2
// ════════════════════════════════════════════════════════════════════════════════
/**
 * @param {string[]} urls
 * @param {string} jobId
 * @param {object} cfg - renderConfig
 * @param {function} onProgress - callback(index, result, error)
 * @param {boolean} applyWatermark - se true, queima marca d'água na imagem
 * @returns {Array} resultados (null onde falhou)
 */
async function captureJobPages(urls, jobId, cfg, onProgress, applyWatermark) {
  const results = new Array(urls.length).fill(null);
  const sem     = makeSemaphore(MAX_CONCURRENT);

  let browser;
  try {
    return await Promise.race([
      (async () => {
        // Browser abre UMA vez para todo o job
        browser = await launchBrowser();

        await Promise.allSettled(urls.map(async (url, i) => {
          const validated = (() => { try { return validateUrl(url); } catch { return null; } })();
          if (!validated) {
            if (onProgress) onProgress(i, null, new Error('URL inválida'));
            return;
          }

          const dir = path.join(__dirname, 'screenshots', jobId, `page-${String(i).padStart(2, '0')}`);
          fs.mkdirSync(dir, { recursive: true });

          await sem.acquire();
          try {
            const result = await Promise.race([
              _capturePageWithBrowser(browser, validated, dir, cfg || {}, applyWatermark),
              new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout por página')), GLOBAL_PAGE_TIMEOUT)),
            ]);
            results[i] = result;
            if (onProgress) onProgress(i, result, null);
          } catch (err) {
            results[i] = null;
            if (onProgress) onProgress(i, null, err);
          } finally {
            sem.release();
          }
        }));

        return results;
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Tempo limite total do job atingido.')), GLOBAL_JOB_TIMEOUT)),
    ]);
  } finally {
    // Browser fecha UMA vez ao final do job
    if (browser) await browser.close().catch(() => {});
  }
}

// ── capturePageProfessional (compat — usado por compare e single) ──────────────
async function capturePageProfessional(url, jobId, pageIndex, renderConfig, applyWatermark) {
  const validated = validateUrl(url);
  const dir = path.join(__dirname, 'screenshots', jobId, `page-${String(pageIndex).padStart(2, '0')}`);
  fs.mkdirSync(dir, { recursive: true });

  let browser;
  try {
    return await Promise.race([
      (async () => {
        browser = await launchBrowser();
        return await _capturePageWithBrowser(browser, validated, dir, renderConfig || {}, applyWatermark);
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Tempo limite de captura atingido.')), GLOBAL_PAGE_TIMEOUT)),
    ]);
  } catch (err) {
    const m = err.message || '';
    if (m.includes('net::ERR') || m.includes('ERR_NAME_NOT_RESOLVED') || m.includes('Navigation timeout'))
      throw new Error(`Não foi possível acessar ${url}. Verifique o endereço e tente novamente.`);
    throw new Error(`Falha na captura de ${url}: ${m}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── captureComparison ─────────────────────────────────────────────────────────
async function captureComparison(url1, url2, jobId, renderConfig) {
  const v1  = validateUrl(url1);
  const v2  = validateUrl(url2);
  const dir = path.join(__dirname, 'screenshots', jobId, 'compare');
  fs.mkdirSync(dir, { recursive: true });

  const raw1 = path.join(dir, 'screenshot-1.png');
  const raw2 = path.join(dir, 'screenshot-2.png');
  const out1 = path.join(dir, 'desktop-1-professional.png');
  const out2 = path.join(dir, 'desktop-2-professional.png');
  const outC = path.join(dir, 'comparison.png');

  let browser;
  try {
    return await Promise.race([
      (async () => {
        browser = await launchBrowser();

        const p1 = await setupPage(browser, DESKTOP_VP, DESKTOP_UA);
        await navigateFast(p1, v1);
        await Promise.race([dismissOverlays(p1), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
        await triggerLazyLoad(p1);
        const t1 = await p1.title().catch(() => v1);
        await screenshotLimited(p1, raw1);
        await p1.close().catch(() => {});

        const p2 = await setupPage(browser, DESKTOP_VP, DESKTOP_UA);
        await navigateFast(p2, v2);
        await Promise.race([dismissOverlays(p2), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
        await triggerLazyLoad(p2);
        const t2 = await p2.title().catch(() => v2);
        await screenshotLimited(p2, raw2);
        await p2.close().catch(() => {});

        await browser.close(); browser = null;

        await renderProfessional({ screenshotPath: raw1, deviceType: 'desktop', renderConfig, outputPath: out1, pageUrl: v1, pageTitle: t1 });
        await renderProfessional({ screenshotPath: raw2, deviceType: 'desktop', renderConfig, outputPath: out2, pageUrl: v2, pageTitle: t2 });
        await renderComparison({ screenshot1Path: raw1, screenshot2Path: raw2, outputPath: outC, url1: v1, url2: v2 });

        try { fs.unlinkSync(raw1); } catch {}
        try { fs.unlinkSync(raw2); } catch {}

        return { out1, out2, comparison: outC, title1: t1, title2: t2 };
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Tempo limite de comparação atingido.')), GLOBAL_PAGE_TIMEOUT * 2)),
    ]);
  } catch (err) {
    throw new Error(`Falha na comparação: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── captureScreenshots (legacy) ───────────────────────────────────────────────
async function captureScreenshots(rawUrl, jobId) {
  const url = validateUrl(rawUrl);
  const dir = path.join(__dirname, 'screenshots', jobId);
  fs.mkdirSync(dir, { recursive: true });

  const desktopPath = path.join(dir, 'desktop.png');
  const mobilePath  = path.join(dir, 'mobile.png');
  const previewPath = path.join(dir, 'preview.png');

  let browser;
  try {
    return await Promise.race([
      (async () => {
        browser = await launchBrowser();

        const dp = await setupPage(browser, DESKTOP_VP, DESKTOP_UA);
        await navigateFast(dp, url);
        await Promise.race([dismissOverlays(dp), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
        await triggerLazyLoad(dp);
        await screenshotLimited(dp, desktopPath);
        await dp.close().catch(() => {});

        const mp = await setupPage(browser, MOBILE_VP, MOBILE_UA);
        await navigateFast(mp, url);
        await Promise.race([dismissOverlays(mp), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
        await screenshotMobileLimited(mp, mobilePath);
        await mp.close().catch(() => {});

        const b64  = fs.readFileSync(desktopPath).toString('base64');
        const html = `<!DOCTYPE html><html><head><style>*{margin:0;padding:0;box-sizing:border-box;}body{width:800px;height:500px;overflow:hidden;background:#080808;position:relative;}.w{width:100%;height:100%;overflow:hidden;position:relative;}img{width:100%;filter:blur(6px);transform:scale(1.04);display:block;}.o{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(8,8,8,.5);}.wm{font-family:monospace;font-size:26px;font-weight:900;letter-spacing:.18em;color:rgba(255,255,255,.5);text-transform:uppercase;transform:rotate(-18deg);}</style></head><body><div class="w"><img src="data:image/png;base64,${b64}"><div class="o"><span class="wm">SNAPSHOT.PRO</span></div></div></body></html>`;
        const pp   = await browser.newPage();
        await pp.setViewport({ width: 800, height: 500, deviceScaleFactor: 2 });
        await pp.setContent(html, { waitUntil: 'domcontentloaded' });
        await pp.screenshot({ path: previewPath, fullPage: false });
        await pp.close().catch(() => {});

        await browser.close(); browser = null;
        return { desktopPath, mobilePath, previewPath };
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Tempo limite atingido.')), GLOBAL_PAGE_TIMEOUT)),
    ]);
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    const m = err.message || '';
    if (m.includes('net::ERR') || m.includes('ERR_NAME_NOT_RESOLVED') || m.includes('Navigation timeout'))
      throw new Error('Esta URL não está acessível. Verifique o endereço e tente novamente.');
    throw new Error(`Falha na captura: ${m}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { captureScreenshots, capturePageProfessional, captureJobPages, captureComparison };
