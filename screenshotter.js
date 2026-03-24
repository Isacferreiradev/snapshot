'use strict';

const fs   = require('fs');
const path = require('path');
const { renderProfessional, renderSocialExport, renderComparison } = require('./renderer');
const { getBrowserFromPool, releaseBrowserToPool, initBrowserPool } = require('./browser-pool');

// ── Viewport / UA ─────────────────────────────────────────────────────────────
const DESKTOP_VP = { width: 1440, height: 900, deviceScaleFactor: 2 };
const MOBILE_VP  = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false };
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

// ── Timeouts ──────────────────────────────────────────────────────────────────
const NAV_DCL_TIMEOUT  = 10000;
const SELECTOR_TIMEOUT = 6000;
const RACE_SLEEP       = 5000;
const POST_LOAD_WAIT   = 600;
const OVERLAY_TIMEOUT  = 2000;
const SHOT_TIMEOUT     = 10000;
const GLOBAL_PAGE_TIMEOUT = 45000;
const GLOBAL_JOB_TIMEOUT  = 300000;

// ── Concorrência ──────────────────────────────────────────────────────────────
const MAX_CONCURRENT = 3;

// ── Padrão de bloqueio de recursos ────────────────────────────────────────────
const BLOCK_SCRIPT_RE = /google-analytics|googletagmanager|facebook\.net|fbevents|hotjar|intercom|hubspot|drift\.com|crisp\.chat|tawk\.to|amplitude\.com|segment\.io|mixpanel|fullstory|clarity\.microsoft|adsbygoogle|doubleclick|googleadservices|newrelic|sentry\.io\/api|bat\.bing|snap\.licdn|twitter\.com\/i\/adsct/;
const BLOCK_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function applyStealthPatch(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver',           { get: () => undefined });
    Object.defineProperty(navigator, 'languages',           { get: () => ['pt-BR','pt','en-US','en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
    Object.defineProperty(navigator, 'platform',            { get: () => 'Win32' });
    if (!window.chrome) window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  });
}

async function enableResourceBlocking(page, pageHostname) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    const rt  = req.resourceType();
    // Block media (video/audio) entirely
    if (rt === 'media') { req.abort(); return; }
    // Block third-party fonts
    if (rt === 'font') {
      try {
        const host = new URL(url).hostname;
        if (BLOCK_FONT_HOSTS.has(host) || (pageHostname && host !== pageHostname)) { req.abort(); return; }
      } catch {}
    }
    // Block tracking scripts
    if (rt === 'script' && BLOCK_SCRIPT_RE.test(url)) { req.abort(); return; }
    req.continue();
  });
}

async function dismissOverlays(page) {
  try {
    await page.evaluate(() => {
      const btnSels = [
        'button[id*="accept"],button[class*="accept"]',
        'button[id*="agree"],button[class*="agree"]',
        'button[id*="close"],button[class*="close"]',
        'button[id*="dismiss"],button[class*="dismiss"]',
        'button[aria-label*="close" i],button[aria-label*="fechar" i]',
      ];
      for (const sel of btnSels) {
        try { const b = document.querySelector(sel); if (b) b.click(); } catch {}
      }
      document.querySelectorAll(
        '[id*="cookie"],[class*="cookie"],[id*="consent"],[class*="consent"],' +
        '[id*="gdpr"],[class*="gdpr"],[role="dialog"],[role="alertdialog"],' +
        '[class*="modal"],[class*="popup"],[class*="overlay"]'
      ).forEach(el => {
        try {
          const s = window.getComputedStyle(el);
          if ((s.position === 'fixed' || s.position === 'sticky') && parseInt(s.zIndex || 0) > 50) el.remove();
        } catch {}
      });
    });
  } catch {}
}

async function triggerLazyLoad(page) {
  try {
    const total  = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)).catch(() => 900);
    const target = Math.min(total, 900 * 5);
    for (let pos = 0; pos < target; pos += 400) {
      await page.evaluate(y => window.scrollTo(0, y), pos);
      await new Promise(r => setTimeout(r, 40));
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 100));
  } catch {}
}

/** Navegação rápida com suporte a captureStrategy por plataforma */
async function navigateFast(page, url, captureStrategy) {
  const strat = captureStrategy || {};
  let navErr = null;

  if (strat.waitUntil === 'networkidle2') {
    const timeout = strat.timeout || NAV_DCL_TIMEOUT;
    await Promise.race([
      page.goto(url, { waitUntil: 'networkidle2', timeout }).catch(e => { navErr = e; }),
      new Promise(r => setTimeout(r, timeout)),
    ]);
  } else {
    await Promise.race([
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_DCL_TIMEOUT }).catch(e => { navErr = e; }),
      page.waitForSelector('body, main, article', { timeout: SELECTOR_TIMEOUT }).catch(() => {}),
      new Promise(r => setTimeout(r, RACE_SLEEP)),
    ]);
  }
  if (navErr && !/timeout|TimeoutError/i.test(navErr.message)) throw navErr;

  const delay = strat.delay || POST_LOAD_WAIT;
  await new Promise(r => setTimeout(r, delay));
}

async function screenshotLimited(page, filePath) {
  const totalH = await page.evaluate(() =>
    Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight)
  ).catch(() => 900);
  await page.screenshot({
    path: filePath, type: 'png',
    clip: { x: 0, y: 0, width: DESKTOP_VP.width, height: Math.min(totalH, 900 * 5) },
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

async function setupPage(browser, vp, ua, hostname) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_DCL_TIMEOUT);
  await applyStealthPatch(page);
  await page.setUserAgent(ua);
  await page.setViewport(vp);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8' });
  await enableResourceBlocking(page, hostname);
  return page;
}

function validateUrl(url) {
  if (!url || typeof url !== 'string') throw new Error('URL válida é obrigatória.');
  const t = url.trim();
  if (!t.startsWith('http://') && !t.startsWith('https://')) throw new Error('URL deve começar com http:// ou https://');
  try { new URL(t); } catch { throw new Error('Formato de URL inválido.'); }
  return t;
}

// Templates que capturam apenas o viewport inicial (acima da dobra)
const DEVICE_FRAME_TEMPLATES = new Set([
  'void','chrome','paper','float','annotation','story',
  'macbook','iphone-pro','tablet','duo-split','device-glow','browser-dark',
  'ipad','slate','duo','arcade','watch',
]);

// ── Render com fallback — retorna true se renderizou com template, false se usou raw ──
async function safeRender(opts, rawFallback) {
  try {
    await renderProfessional(opts);
    return true;
  } catch (err) {
    console.error(`[render] FALHOU ${path.basename(opts.outputPath)}: ${err.message}`);
    try { fs.copyFileSync(rawFallback, opts.outputPath); } catch {}
    return false;
  }
}

// ── Semáforo ──────────────────────────────────────────────────────────────────
function makeSemaphore(limit) {
  let active = 0;
  return {
    async acquire() {
      while (active >= limit) await new Promise(r => setTimeout(r, 100));
      active++;
    },
    release() { active--; },
  };
}

// ── Captura de página usando browser do pool ──────────────────────────────────
async function _capturePageWithBrowser(browser, validated, dir, cfg, applyWatermark, captureStrategy, aboveFoldOnly) {
  const hostname   = (() => { try { return new URL(validated).hostname; } catch { return ''; } })();
  const desktopRaw = path.join(dir, 'desktop-raw.png');
  const mobileRaw  = path.join(dir, 'mobile-raw.png');
  const desktopOut = path.join(dir, 'desktop-professional.png');
  const mobileOut  = path.join(dir, 'mobile-professional.png');
  const previewOut = path.join(dir, 'preview.png');

  // Parâmetros dinâmicos do plano
  const planDSF      = cfg.deviceScaleFactor || 2;
  const includeMobile = cfg.includeMobile !== false;
  const desktopVp    = { ...DESKTOP_VP, deviceScaleFactor: planDSF };
  const mobileVp     = { ...MOBILE_VP,  deviceScaleFactor: Math.max(planDSF, 2) };

  // Device-frame templates benefit from viewport-only capture (show top of page in frame)
  const pageTemplate    = (cfg.pageTemplates && cfg.pageTemplates[validated]) || cfg.template || 'void';
  const pageCfg         = { ...cfg, template: pageTemplate };
  const viewportOnly    = aboveFoldOnly || DEVICE_FRAME_TEMPLATES.has(pageTemplate);

  let dp, mp;
  try {
    // Desktop
    dp = await setupPage(browser, desktopVp, DESKTOP_UA, hostname);
    await navigateFast(dp, validated, captureStrategy);
    await Promise.race([dismissOverlays(dp), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
    if (!viewportOnly) await triggerLazyLoad(dp);
    const pageTitle = await dp.title().catch(() => validated);
    if (viewportOnly) {
      await dp.screenshot({ path: desktopRaw, type: 'png',
        clip: { x: 0, y: 0, width: desktopVp.width, height: 900 }, timeout: SHOT_TIMEOUT });
    } else {
      await screenshotLimited(dp, desktopRaw);
    }
    await dp.close().catch(() => {}); dp = null;

    // Mobile (skip se plano não permite)
    if (includeMobile) {
      mp = await setupPage(browser, mobileVp, MOBILE_UA, hostname);
      await navigateFast(mp, validated, captureStrategy);
      await Promise.race([dismissOverlays(mp), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
      if (viewportOnly) {
        await mp.screenshot({ path: mobileRaw, type: 'png',
          clip: { x: 0, y: 0, width: mobileVp.width, height: 844 }, timeout: SHOT_TIMEOUT });
      } else {
        await screenshotMobileLimited(mp, mobileRaw);
      }
      await mp.close().catch(() => {}); mp = null;
    }

    // Render templates
    const deskOk = await safeRender({ screenshotPath: desktopRaw, deviceType: 'desktop', renderConfig: pageCfg, outputPath: desktopOut, pageUrl: validated, pageTitle, applyWatermark: !!applyWatermark }, desktopRaw);
    const mobOk  = includeMobile
      ? await safeRender({ screenshotPath: mobileRaw, deviceType: 'mobile', renderConfig: pageCfg, outputPath: mobileOut, pageUrl: validated, pageTitle, applyWatermark: !!applyWatermark }, mobileRaw)
      : false;
    await safeRender({ screenshotPath: desktopRaw, deviceType: 'desktop', renderConfig: pageCfg, outputPath: previewOut, pageUrl: validated, pageTitle, applyWatermark: !!applyWatermark }, desktopRaw);

    if (cfg && cfg.socialExport) {
      const socialDir = path.join(dir, 'social');
      fs.mkdirSync(socialDir, { recursive: true });
      for (const fmt of ['twitter','linkedin','instagram-square','instagram-story','og']) {
        await renderSocialExport({ screenshotPath: desktopRaw, format: fmt, outputPath: path.join(socialDir, `${fmt}.png`), pageUrl: validated, pageTitle }).catch(() => {});
      }
    }

    // Raw files are kept on disk for possible re-render (e.g., user removes watermark after purchase)
    // They are deleted when the job folder is cleaned up after download.

    return { desktopPath: desktopOut, mobilePath: mobileOut, previewPath: previewOut, pageTitle, url: validated };
  } finally {
    if (dp) await dp.close().catch(() => {});
    if (mp) await mp.close().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// captureJobPages — browser pool, paralelo com semáforo de 3
// ═══════════════════════════════════════════════════════════════════════════════
// pageOptions: array of { captureStrategy, aboveFoldOnly } indexed by position
async function captureJobPages(urls, jobId, cfg, onProgress, applyWatermark, pageOptions) {
  const results = new Array(urls.length).fill(null);
  const sem     = makeSemaphore(MAX_CONCURRENT);

  return Promise.race([
    (async () => {
      await Promise.allSettled(urls.map(async (url, i) => {
        const validated = (() => { try { return validateUrl(url); } catch { return null; } })();
        if (!validated) {
          if (onProgress) onProgress(i, null, new Error('URL inválida'));
          return;
        }

        const dir = path.join(__dirname, 'screenshots', jobId, `page-${String(i).padStart(2, '0')}`);
        fs.mkdirSync(dir, { recursive: true });

        const opts = (pageOptions && pageOptions[i]) || {};
        const captureStrategy = opts.captureStrategy || null;
        const aboveFoldOnly   = !!opts.aboveFoldOnly;

        await sem.acquire();
        let poolEntry;
        try {
          poolEntry = await getBrowserFromPool();
          const result = await Promise.race([
            _capturePageWithBrowser(poolEntry.browser, validated, dir, cfg || {}, applyWatermark, captureStrategy, aboveFoldOnly),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout por página')), GLOBAL_PAGE_TIMEOUT)),
          ]);
          results[i] = result;
          if (onProgress) onProgress(i, result, null);
        } catch (err) {
          results[i] = null;
          if (onProgress) onProgress(i, null, err);
        } finally {
          sem.release();
          if (poolEntry) await releaseBrowserToPool(poolEntry);
        }
      }));
      return results;
    })(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Tempo limite total do job atingido.')), GLOBAL_JOB_TIMEOUT)),
  ]);
}

// ── capturePageProfessional (compat — compare e single) ───────────────────────
async function capturePageProfessional(url, jobId, pageIndex, renderConfig, applyWatermark) {
  const validated = validateUrl(url);
  const dir = path.join(__dirname, 'screenshots', jobId, `page-${String(pageIndex).padStart(2, '0')}`);
  fs.mkdirSync(dir, { recursive: true });

  let poolEntry;
  try {
    return await Promise.race([
      (async () => {
        poolEntry = await getBrowserFromPool();
        return await _capturePageWithBrowser(poolEntry.browser, validated, dir, renderConfig || {}, applyWatermark);
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Tempo limite de captura atingido.')), GLOBAL_PAGE_TIMEOUT)),
    ]);
  } catch (err) {
    const m = err.message || '';
    if (m.includes('net::ERR') || m.includes('ERR_NAME_NOT_RESOLVED') || m.includes('Navigation timeout'))
      throw new Error(`Não foi possível acessar ${url}. Verifique o endereço e tente novamente.`);
    throw new Error(`Falha na captura de ${url}: ${m}`);
  } finally {
    if (poolEntry) await releaseBrowserToPool(poolEntry);
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

  let entry1, entry2;
  try {
    return await Promise.race([
      (async () => {
        [entry1, entry2] = await Promise.all([getBrowserFromPool(), getBrowserFromPool()]);

        const [r1, r2] = await Promise.all([
          (async () => {
            const h1 = (() => { try { return new URL(v1).hostname; } catch { return ''; } })();
            const p1 = await setupPage(entry1.browser, DESKTOP_VP, DESKTOP_UA, h1);
            await navigateFast(p1, v1);
            await Promise.race([dismissOverlays(p1), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
            await triggerLazyLoad(p1);
            const t1 = await p1.title().catch(() => v1);
            await screenshotLimited(p1, raw1);
            await p1.close().catch(() => {});
            return t1;
          })(),
          (async () => {
            const h2 = (() => { try { return new URL(v2).hostname; } catch { return ''; } })();
            const p2 = await setupPage(entry2.browser, DESKTOP_VP, DESKTOP_UA, h2);
            await navigateFast(p2, v2);
            await Promise.race([dismissOverlays(p2), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
            await triggerLazyLoad(p2);
            const t2 = await p2.title().catch(() => v2);
            await screenshotLimited(p2, raw2);
            await p2.close().catch(() => {});
            return t2;
          })(),
        ]);

        await Promise.all([
          renderProfessional({ screenshotPath: raw1, deviceType: 'desktop', renderConfig, outputPath: out1, pageUrl: v1, pageTitle: r1 }),
          renderProfessional({ screenshotPath: raw2, deviceType: 'desktop', renderConfig, outputPath: out2, pageUrl: v2, pageTitle: r2 }),
        ]);
        await renderComparison({ screenshot1Path: raw1, screenshot2Path: raw2, outputPath: outC, url1: v1, url2: v2 });

        try { fs.unlinkSync(raw1); } catch {}
        try { fs.unlinkSync(raw2); } catch {}

        return { out1, out2, comparison: outC, title1: r1, title2: r2 };
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Tempo limite de comparação atingido.')), GLOBAL_PAGE_TIMEOUT * 2)),
    ]);
  } catch (err) {
    throw new Error(`Falha na comparação: ${err.message}`);
  } finally {
    if (entry1) await releaseBrowserToPool(entry1);
    if (entry2) await releaseBrowserToPool(entry2);
  }
}

module.exports = {
  captureJobPages,
  capturePageProfessional,
  captureComparison,
  initBrowserPool,
  getBrowserFromPool,
  releaseBrowserToPool,
};

