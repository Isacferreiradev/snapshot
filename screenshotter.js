'use strict';

const fs      = require('fs');
const path    = require('path');
const storage = require('./storage');
const { renderProfessional, renderSocialExport, renderComparison } = require('./renderer');
const { getBrowserFromPool, releaseBrowserToPool, initBrowserPool } = require('./browser-pool');
const { validateUrl, installSsrfInterceptor } = require('./security');
const { appendCrawlLog } = require('./jobs');

// ── Viewport / UA ─────────────────────────────────────────────────────────────
const DESKTOP_VP = { width: 1440, height: 900, deviceScaleFactor: 2 };
const MOBILE_VP  = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false };
// [FIX] UA realista Mac (mais aceito por anti-bot que Windows headless)
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

// ── Timeouts ──────────────────────────────────────────────────────────────────
const NAV_DCL_TIMEOUT  = 12000;
const SELECTOR_TIMEOUT = 6000;
const RACE_SLEEP       = 2000;
const POST_LOAD_WAIT   = 800;  // [FIX-SPEED] 800ms base — sites lentos precisam de mais tempo
const OVERLAY_TIMEOUT  = 1000;
const SHOT_TIMEOUT     = 12000;
const GLOBAL_PAGE_TIMEOUT = 90000;  // [FIX-5] 90s por página
const GLOBAL_JOB_TIMEOUT  = 120000; // 2 min por job

// ── Retry ─────────────────────────────────────────────────────────────────────
const RETRY_MAX   = 2;    // tentativas extras após 1ª falha (total = 3)
const RETRY_DELAY = 2000; // ms entre tentativas
const RETRY_RE    = /timeout|ECONNRESET|ECONNREFUSED|net::ERR_TIMED_OUT|net::ERR_CONNECTION/i;

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
  // SSRF interceptor wraps the original resource-blocking logic
  await installSsrfInterceptor(page, req => {
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

/** Navegação com cascade domcontentloaded → networkidle2 → load.
 *  [FIX-SPEED] Antes iniciava com networkidle0 (25s timeout) que nunca resolvia em sites como
 *  GitHub (conexões persistentes/WebSocket). Resultado: todo site "pesado" esperava 25s antes
 *  de tentar a próxima estratégia. Novo cascade começa por domcontentloaded (rápido e confiável)
 *  e usa content-check dinâmico em vez de setTimeout fixo.
 */
async function navigateFast(page, url, captureStrategy) {
  const strat = captureStrategy || {};

  // Se o caller especificou uma estratégia explícita (ex: per-page override), usá-la diretamente
  if (strat.waitUntil) {
    const timeout = strat.timeout || NAV_DCL_TIMEOUT;
    let navErr = null;
    await Promise.race([
      page.goto(url, { waitUntil: strat.waitUntil, timeout }).catch(e => { navErr = e; }),
      new Promise(r => setTimeout(r, timeout + 1000)),
    ]);
    if (navErr && !/timeout|TimeoutError/i.test(navErr.message)) throw navErr;
    await new Promise(r => setTimeout(r, strat.delay || POST_LOAD_WAIT));
    return;
  }

  // Cascade: domcontentloaded primeiro (rápido), depois load como fallback
  // NÃO usamos networkidle0 — sites como GitHub, Vercel e outros com
  // WebSocket/polling NUNCA atingem networkidle0 → travava 25s por página.
  const CASCADE = [
    { waitUntil: 'domcontentloaded', timeout: 12000 },
    { waitUntil: 'load',             timeout: 10000 },
  ];

  let lastErr = null;
  for (const s of CASCADE) {
    try {
      await page.goto(url, { waitUntil: s.waitUntil, timeout: s.timeout });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      // Erro real de rede (não timeout) → interromper cascade e relançar
      if (!/timeout|TimeoutError/i.test(err.message || '')) throw err;
    }
  }
  if (lastErr) {
    console.warn(`[navigateFast] todas as estratégias falharam para ${url} — continuando com estado atual`);
  }

  // Delay base pós-navegação (reduzido de 1000ms → 500ms)
  await new Promise(r => setTimeout(r, POST_LOAD_WAIT));

  // Content-check dinâmico: verifica se há conteúdo visível a cada 200ms (máx 1500ms total)
  // Substitui o setTimeout fixo de 2000ms — sites com conteúdo imediato terminam em ~200ms
  try {
    const contentDeadline = Date.now() + 1500;
    while (Date.now() < contentDeadline) {
      const hasContent = await page.evaluate(() =>
        !!(document.body && document.body.innerText && document.body.innerText.trim().length > 100)
      ).catch(() => false);
      if (hasContent) break;
      await new Promise(r => setTimeout(r, 200));
    }
  } catch {}
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
  await assertScreenshotSize(filePath, page, { w: DESKTOP_VP.width, h: Math.min(totalH, 900 * 5) });
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
  await assertScreenshotSize(filePath, page, { w: MOBILE_VP.width, h: Math.min(totalH, 844 * 5) });
}

/** Verifica se o screenshot tem tamanho mínimo razoável. Se for muito pequeno, aguarda e tenta uma vez mais. */
async function assertScreenshotSize(filePath, page, clip) {
  const MIN_BYTES = 8000;  // [FIX] baixado de 15000 para pegar arquivos vazios mas aceitar compactos
  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }  // arquivo não existe, já irá falhar acima
  if (stat.size === 0) {
    // Arquivo vazio é sempre problema — aguardar 2s e re-tentar
    console.warn(`[screenshotter] Screenshot VAZIO — aguardando 2s e retentando: ${filePath}`);
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: filePath, type: 'png', clip, timeout: SHOT_TIMEOUT });
  } else if (stat.size < MIN_BYTES) {
    console.warn(`[screenshotter] Screenshot suspeito (${stat.size} bytes) — aguardando 2s e retentando: ${filePath}`);
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: filePath, type: 'png', clip, timeout: SHOT_TIMEOUT });
    const stat2 = fs.statSync(filePath);
    if (stat2.size < MIN_BYTES) {
      console.warn(`[screenshotter] Screenshot ainda pequeno após retry (${stat2.size} bytes) — continuando mesmo assim`);
    }
  }
}

async function setupPage(browser, vp, ua, hostname) {
  // [FIX-B] newPage() sem timeout → hang silencioso de até 90s; 10s é suficiente
  const page = await Promise.race([
    browser.newPage(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('setupPage: newPage timeout')), 10000)),
  ]);
  page.setDefaultNavigationTimeout(NAV_DCL_TIMEOUT);
  await applyStealthPatch(page);
  await page.setUserAgent(ua);
  await page.setViewport(vp);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8' });
  // [FIX-STABLE] enableResourceBlocking pode falhar em alguns contextos; não deve matar a página
  try { await enableResourceBlocking(page, hostname); } catch (err) {
    console.warn(`[screenshotter] enableResourceBlocking falhou (${hostname}): ${err.message} — continuando sem bloqueio`);
  }
  return page;
}

function assertHttpUrl(url) {
  if (!url || typeof url !== 'string') throw new Error('URL válida é obrigatória.');
  const t = url.trim();
  if (!t.startsWith('http://') && !t.startsWith('https://')) throw new Error('URL deve começar com http:// ou https://');
  try { new URL(t); } catch { throw new Error('Formato de URL inválido.'); }
  return t;
}

// Templates que capturam apenas o viewport inicial (acima da dobra)
const DEVICE_FRAME_TEMPLATES = new Set([
  'macbook-realistic', 'macbook-clean', 'iphone-pro', 'iphone-dark', 'multi-device',
]);

// ── Render com fallback — retorna true se renderizou com template, false se usou raw ──
async function safeRender(opts, rawFallback) {
  try {
    await renderProfessional(opts);
    return true;
  } catch (err) {
    console.error(`[render] FALHOU ${path.basename(opts.outputPath)}: ${err.message}`);
    // If watermark is required, don't fall back to raw (would strip watermark).
    // Try again with the default-dark template as a safe fallback.
    if (opts.applyWatermark) {
      try {
        await renderProfessional({ ...opts, templateId: 'default-dark', renderConfig: { ...(opts.renderConfig || {}), template: 'default-dark' } });
        return true;
      } catch (err2) {
        console.error(`[render] fallback watermark FALHOU: ${err2.message}`);
        // Both renders failed with watermark required — do NOT deliver the raw file without watermark.
        // Return false so the page shows as failed rather than unwatermarked.
        return false;
      }
    }
    try { fs.copyFileSync(rawFallback, opts.outputPath); } catch {}
    return false;
  }
}

// ── Semáforo (promise-queue, sem busy-wait) ───────────────────────────────────
function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return {
    acquire() {
      if (active < limit) { active++; return Promise.resolve(); }
      return new Promise(resolve => queue.push(() => { active++; resolve(); }));
    },
    release() {
      active--;
      if (queue.length > 0) queue.shift()();
    },
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
  // [FIX-7] Fallback de 'void' para 'browser-clean' — 'void' era passado ao renderer sem tratamento
  const pageTemplate    = (cfg.pageTemplates && cfg.pageTemplates[validated]) || cfg.template || 'browser-clean';
  const pageCfg         = { ...cfg, template: pageTemplate };
  const viewportOnly    = aboveFoldOnly || DEVICE_FRAME_TEMPLATES.has(pageTemplate);

  let dp, mp;
  try {
    // Desktop + Mobile em paralelo
    [dp, mp] = await Promise.all([
      setupPage(browser, desktopVp, DESKTOP_UA, hostname),
      includeMobile ? setupPage(browser, mobileVp, MOBILE_UA, hostname) : Promise.resolve(null),
    ]);
    await Promise.all([
      navigateFast(dp, validated, captureStrategy),
      mp ? navigateFast(mp, validated, captureStrategy) : Promise.resolve(),
    ]);
    await Promise.all([
      Promise.race([dismissOverlays(dp), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]),
      mp ? Promise.race([dismissOverlays(mp), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]) : Promise.resolve(),
    ]);
    if (!viewportOnly) await triggerLazyLoad(dp);
    const pageTitle = await dp.title().catch(() => validated);

    // Screenshots em paralelo
    await Promise.all([
      viewportOnly
        ? dp.screenshot({ path: desktopRaw, type: 'png', clip: { x: 0, y: 0, width: desktopVp.width, height: 900 }, timeout: SHOT_TIMEOUT })
        : screenshotLimited(dp, desktopRaw),
      mp
        ? (viewportOnly
            ? mp.screenshot({ path: mobileRaw, type: 'png', clip: { x: 0, y: 0, width: mobileVp.width, height: 844 }, timeout: SHOT_TIMEOUT })
            : screenshotMobileLimited(mp, mobileRaw))
        : Promise.resolve(),
    ]);
    // [FIX-C] close() sem timeout pode pendurar com requests interceptadas pendentes
    const closeWithTimeout = p => Promise.race([p.close(), new Promise(r => setTimeout(r, 2000))]).catch(() => {});
    await Promise.all([closeWithTimeout(dp), mp ? closeWithTimeout(mp) : Promise.resolve()]);
    dp = null; mp = null;

    // Retornar metadados — render será feito FORA desta função, após liberar o browser do pool.
    // Isso evita deadlock: com 3 browsers no pool e 3 capturas simultâneas, se render
    // precisar de browser (renderTemplate usa getBrowserFromPool), não há browser disponível.
    return {
      desktopRaw, mobileRaw, desktopOut, mobileOut, previewOut,
      pageCfg, validated, pageTitle, includeMobile,
      applyWatermark: !!applyWatermark,
      socialExport: !!(cfg && cfg.socialExport),
      dir,
    };
  } finally {
    // [FIX-C] timeout no finally também — .catch() sozinho não protege contra hang
    if (dp) await Promise.race([dp.close(), new Promise(r => setTimeout(r, 2000))]).catch(() => {});
    if (mp) await Promise.race([mp.close(), new Promise(r => setTimeout(r, 2000))]).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// captureJobPages — browser pool, paralelo com semáforo de 3
// ═══════════════════════════════════════════════════════════════════════════════
// pageOptions: array of { captureStrategy, aboveFoldOnly } indexed by position
async function captureJobPages(urls, jobId, cfg, onProgress, applyWatermark, pageOptions) {
  const results = new Array(urls.length).fill(null);
  const sem     = makeSemaphore(MAX_CONCURRENT);

  // Timeout dinâmico: ~40s por página ÷ concorrência + 60s buffer. Mín 120s, máx 600s.
  const dynamicTimeout = Math.min(
    Math.max(Math.ceil(urls.length / MAX_CONCURRENT) * 40000 + 60000, GLOBAL_JOB_TIMEOUT),
    600000
  );

  return Promise.race([
    (async () => {
      await Promise.allSettled(urls.map(async (url, i) => {
        const validated = (() => { try { return assertHttpUrl(url); } catch { return null; } })();
        if (!validated) {
          if (onProgress) onProgress(i, null, new Error('URL inválida'));
          return;
        }

        const dir = storage.getPageDir(jobId, i);

        const opts = (pageOptions && pageOptions[i]) || {};
        const captureStrategy = opts.captureStrategy || null;
        const aboveFoldOnly   = !!opts.aboveFoldOnly;

        await sem.acquire();
        try {
          let poolEntry;
          let lastErr;
          let captured = false;
          for (let attempt = 1; attempt <= RETRY_MAX + 1; attempt++) {
            try {
              if (attempt > 1) appendCrawlLog(jobId, `[Worker] Retry ${attempt - 1}/${RETRY_MAX}: ${url}`);
              poolEntry = await getBrowserFromPool();
              const captureResult = await Promise.race([
                _capturePageWithBrowser(poolEntry.browser, validated, dir, cfg || {}, applyWatermark, captureStrategy, aboveFoldOnly),
                new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout por página')), GLOBAL_PAGE_TIMEOUT)),
              ]);
              // Liberar browser ANTES do render — evita deadlock quando renderer também precisa de browser
              await releaseBrowserToPool(poolEntry); poolEntry = null;

              // Render: aplicar template nos screenshots capturados (usa browser do pool internamente)
              const cr = captureResult;
              const [deskOk, mobOk] = await Promise.all([
                safeRender({ screenshotPath: cr.desktopRaw, deviceType: 'desktop', renderConfig: cr.pageCfg, outputPath: cr.desktopOut, pageUrl: cr.validated, pageTitle: cr.pageTitle, applyWatermark: cr.applyWatermark }, cr.desktopRaw),
                cr.includeMobile
                  ? safeRender({ screenshotPath: cr.mobileRaw, deviceType: 'mobile', renderConfig: cr.pageCfg, outputPath: cr.mobileOut, pageUrl: cr.validated, pageTitle: cr.pageTitle, applyWatermark: cr.applyWatermark }, cr.mobileRaw)
                  : Promise.resolve(false),
                safeRender({ screenshotPath: cr.desktopRaw, deviceType: 'desktop', renderConfig: cr.pageCfg, outputPath: cr.previewOut, pageUrl: cr.validated, pageTitle: cr.pageTitle, applyWatermark: cr.applyWatermark }, cr.desktopRaw),
              ]);
              if (cr.socialExport) {
                const socialDir = path.join(cr.dir, 'social');
                fs.mkdirSync(socialDir, { recursive: true });
                for (const fmt of ['twitter','linkedin','instagram-square','instagram-story','og']) {
                  await renderSocialExport({ screenshotPath: cr.desktopRaw, format: fmt, outputPath: path.join(socialDir, `${fmt}.png`), pageUrl: cr.validated, pageTitle: cr.pageTitle }).catch(() => {});
                }
              }

              const result = { desktopPath: cr.desktopOut, mobilePath: cr.mobileOut, previewPath: cr.previewOut, pageTitle: cr.pageTitle, url: cr.validated };
              results[i] = result;
              if (onProgress) onProgress(i, result, null);
              captured = true;
              break;
            } catch (err) {
              lastErr = err;
              if (poolEntry) { await releaseBrowserToPool(poolEntry); poolEntry = null; }
              const isRetriable = RETRY_RE.test(err.message || '');
              appendCrawlLog(jobId, `[Worker] Falha tentativa ${attempt}: ${err.message ? err.message.slice(0,80) : 'erro desconhecido'}`);
              if (!isRetriable || attempt > RETRY_MAX) break;
              await new Promise(r => setTimeout(r, RETRY_DELAY));
            }
          }
          if (!captured) {
            results[i] = null;
            if (onProgress) onProgress(i, null, lastErr);
          }
        } finally {
          sem.release(); // [FIX-A] garante liberação mesmo se exceção inesperada escapar do for-loop
        }
      }));
      return results;
    })(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Tempo limite total do job atingido.')), dynamicTimeout)),
  ]);
}

// ── capturePageProfessional (compat — compare e single) ───────────────────────
async function capturePageProfessional(url, jobId, pageIndex, renderConfig, applyWatermark) {
  const validated = assertHttpUrl(url);
  const dir = storage.getPageDir(jobId, pageIndex);

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
  const v1  = assertHttpUrl(url1);
  const v2  = assertHttpUrl(url2);
  const jobBase = storage.getJobDir(jobId);
  const dir     = path.join(jobBase, 'compare');
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

        // [FIX-E] p1/p2 em try/finally — screenshotLimited() pode jogar, orphaning a page
        const [r1, r2] = await Promise.all([
          (async () => {
            const h1 = (() => { try { return new URL(v1).hostname; } catch { return ''; } })();
            let p1;
            try {
              p1 = await setupPage(entry1.browser, DESKTOP_VP, DESKTOP_UA, h1);
              await navigateFast(p1, v1);
              await Promise.race([dismissOverlays(p1), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
              await triggerLazyLoad(p1);
              const t1 = await p1.title().catch(() => v1);
              await screenshotLimited(p1, raw1);
              return t1;
            } finally {
              if (p1) await Promise.race([p1.close(), new Promise(r => setTimeout(r, 2000))]).catch(() => {});
            }
          })(),
          (async () => {
            const h2 = (() => { try { return new URL(v2).hostname; } catch { return ''; } })();
            let p2;
            try {
              p2 = await setupPage(entry2.browser, DESKTOP_VP, DESKTOP_UA, h2);
              await navigateFast(p2, v2);
              await Promise.race([dismissOverlays(p2), new Promise(r => setTimeout(r, OVERLAY_TIMEOUT))]);
              await triggerLazyLoad(p2);
              const t2 = await p2.title().catch(() => v2);
              await screenshotLimited(p2, raw2);
              return t2;
            } finally {
              if (p2) await Promise.race([p2.close(), new Promise(r => setTimeout(r, 2000))]).catch(() => {});
            }
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

