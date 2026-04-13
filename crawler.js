'use strict';

const fs   = require('fs');
const path = require('path');
const { appendCrawlLog }                    = require('./jobs');
const { getBrowserFromPool, releaseBrowserToPool } = require('./screenshotter');
const { validateUrl, installSsrfInterceptor } = require('./security');

const MAX_PAGES         = 12;
const THUMB_TIMEOUT     = 6000;  // [FIX-THUMB] 8s — 5s era muito curto para GitHub/SPAs
const CRAWL_TIMEOUT     = 90000; // 1.5 min (reduzido com pool)
const NEW_PAGE_TIMEOUT  = 5000;  // [FIX-A] timeout em browser.newPage() — sem isso, browser lento trava o slot
const PAGE_CLOSE_TIMEOUT = 2000; // [FIX-B] timeout em pg.close() — pode pendurar se requests interceptadas
const THUMB_CONCURRENCY = 4;     // [FIX-C] reduzido de 4 para 3 — menos pressão no browser por job de crawl

const FILE_EXT_RE = /\.(pdf|zip|jpg|jpeg|png|gif|webp|svg|css|js|ico|woff|woff2|ttf|eot|mp4|mp3|xml|json)(\?|$)/i;

// [FIX-12] Scripts de tracking bloqueados durante crawl — acelera descoberta de links
const CRAWL_BLOCK_RE = /google-analytics|googletagmanager|facebook\.net|fbevents|hotjar|intercom|hubspot|drift\.com|crisp\.chat|tawk\.to|amplitude\.com|segment\.io|mixpanel|fullstory|clarity\.microsoft|adsbygoogle|doubleclick|googleadservices|newrelic|sentry\.io\/api/;

// SVG placeholder quando thumbnail falha
const THUMB_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="#141414"/><text x="400" y="260" font-family="monospace" font-size="16" fill="rgba(255,255,255,0.2)" text-anchor="middle">página não carregou</text></svg>`;

function inferPageType(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p === '/' || p === '' || p === '/index' || p === '/index.html') return 'homepage';
    if (/\/(blog|post|article|news|story|update|artigo|noticias|insights)/.test(p)) return 'article';
    if (/\/(shop|product|item|store|buy|cart|checkout|produto|loja|catalog|catalogo)/.test(p)) return 'product';
    if (/\/(about|sobre|equipe|team|company|empresa|contato|contact|quem-somos|historia|mission)/.test(p)) return 'about';
    if (/\/(pricing|preco|planos|plans|price|assinatura|subscription)/.test(p)) return 'pricing';
    if (/\/(service|servico|portfolio|work|projeto|project)/.test(p)) return 'service';
    if (/\/(support|suporte|help|ajuda|faq|docs|documentacao|documentation)/.test(p)) return 'support';
  } catch {}
  return 'other';
}

// ── Agrupar páginas por categoria ─────────────────────────────────────────────
function groupPages(pages) {
  const groups = {
    'Principal':     [],
    'Blog':          [],
    'Produtos':      [],
    'Institucional': [],
    'Preços':        [],
    'Suporte':       [],
    'Outras':        [],
  };
  for (const page of pages) {
    const p = (() => { try { return new URL(page.url).pathname.toLowerCase(); } catch { return ''; } })();
    if (p === '/' || p === '' || /\/(home|inicio|index)/.test(p)) {
      groups['Principal'].push(page);
    } else if (/\/(blog|artigo|post|news|noticias|insights)/.test(p)) {
      groups['Blog'].push(page);
    } else if (/\/(produto|product|shop|loja|store|item|catalog)/.test(p)) {
      groups['Produtos'].push(page);
    } else if (/\/(sobre|about|contato|contact|equipe|team|empresa|company|historia|mission|quem-somos)/.test(p)) {
      groups['Institucional'].push(page);
    } else if (/\/(preco|pricing|planos|plans|assinatura|price)/.test(p)) {
      groups['Preços'].push(page);
    } else if (/\/(suporte|support|ajuda|help|faq|docs|documentacao)/.test(p)) {
      groups['Suporte'].push(page);
    } else {
      groups['Outras'].push(page);
    }
  }
  return groups;
}

// ── Rankear páginas por relevância ─────────────────────────────────────────────
function rankPages(pages) {
  return pages.map(page => {
    const p = (() => { try { return new URL(page.url).pathname.toLowerCase(); } catch { return ''; } })();
    let recommended = false;
    if (p === '/' || p === '' || p === '/home') recommended = true;
    else if (/^\/(pricing|preco|planos|plans)$/.test(p)) recommended = true;
    else if (/^\/(sobre|about)$/.test(p)) recommended = true;
    else if (/^\/(contato|contact)$/.test(p)) recommended = true;
    return { ...page, recommended };
  });
}

function normalizeUrl(raw, origin) {
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin) return null;
    u.hash = '';
    // Strip tracking params
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_|^(fbclid|gclid|ref|source|mc_eid|_ga)$/.test(k)) u.searchParams.delete(k);
    }
    // Normalize trailing slash: treat /pricing and /pricing/ as the same
    let href = u.href;
    if (href.endsWith('/') && u.pathname !== '/') href = href.slice(0, -1);
    return href.toLowerCase();
  } catch { return null; }
}

/** Deduplica array de páginas por URL normalizada (chamado no server antes de enviar ao frontend) */
function deduplicatePages(pages) {
  const seen   = new Set();
  const unique = [];
  for (const p of pages) {
    const key = normalizeUrl(p.url, new URL(p.url).origin) || p.url.toLowerCase().trim();
    if (!seen.has(key)) { seen.add(key); unique.push(p); }
  }
  return unique;
}

/** Captura thumbnail leve: 800x500, jpeg q50, sem fullPage, timeout 8s */
async function captureThumbnail(browser, url, outputPath) {
  let pg;
  try {
    // [FIX-A] browser.newPage() com timeout — sem isso, browser sob carga bloqueia indefinidamente
    pg = await Promise.race([
      browser.newPage(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('newPage timeout')), NEW_PAGE_TIMEOUT)),
    ]);
    pg.setDefaultNavigationTimeout(THUMB_TIMEOUT);
    await pg.setViewport({ width: 800, height: 500, deviceScaleFactor: 1 });
    await installSsrfInterceptor(pg, req => {
      const rt = req.resourceType();
      if (rt === 'media' || rt === 'font') { req.abort(); return; }
      req.continue();
    });
    try {
      await Promise.race([
        pg.goto(url, { waitUntil: 'domcontentloaded', timeout: THUMB_TIMEOUT }),
        new Promise(r => setTimeout(r, THUMB_TIMEOUT - 1000)), // 7s cap
      ]);
    } catch {}
    // [FIX-VISUAL] Aguardar renderização visual: sites com JS pesado (GitHub, SPAs)
    // capturam spinners de loading se tiramos screenshot imediatamente após DCL.
    // Checar se há conteúdo visível; se não, esperar até 1s adicional.
    try {
      const hasContent = await pg.evaluate(() =>
        !!(document.body && document.body.innerText && document.body.innerText.trim().length > 50)
      ).catch(() => false);
      await new Promise(r => setTimeout(r, hasContent ? 200 : 500));
    } catch {}
    // [FIX-B] screenshot via Promise.race — garante que não pende mesmo se timeout ignorado
    let screenshotOk = false;
    await Promise.race([
      pg.screenshot({ path: outputPath, type: 'jpeg', quality: 50,
        clip: { x: 0, y: 0, width: 800, height: 500 } }).then(() => { screenshotOk = true; }),
      new Promise(r => setTimeout(r, 3000)),
    ]).catch(() => {});
    // Se screenshot não foi escrito, remover arquivo parcial (não queremos 0-byte JPEG)
    if (!screenshotOk) {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    }
  } catch {
    // Erro fatal (newPage timeout etc.) — remover qualquer arquivo parcial
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
  } finally {
    // [FIX-B] pg.close() com timeout — pode pendurar se page tem requests interceptadas pendentes
    if (pg) await Promise.race([pg.close(), new Promise(r => setTimeout(r, PAGE_CLOSE_TIMEOUT))]).catch(() => {});
  }
}

async function _doCrawl(rawUrl, jobId, maxPages) {
  // Validar URL antes de abrir qualquer browser (SSRF protection)
  const urlCheck = await validateUrl(rawUrl);
  if (!urlCheck.valid) throw new Error(urlCheck.reason || 'URL não permitida.');
  rawUrl = urlCheck.url; // URL normalizada e segura

  const pageLimit = (maxPages && maxPages > 0) ? maxPages : MAX_PAGES;
  let origin;
  try { origin = new URL(rawUrl).origin; }
  catch { return { pages: [{ url: rawUrl, title: rawUrl, thumbnailPath: '', thumbnailUrl: '', pageType: 'homepage' }], totalFound: 1 }; }

  const thumbDir = path.join(__dirname, 'screenshots', jobId, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });

  const log = (msg) => { try { appendCrawlLog(jobId, msg); } catch {} };

  let poolEntry;
  try {
    log('Conectando ao navegador…');
    poolEntry = await getBrowserFromPool();
    const browser = poolEntry.browser;

    // ── Seed page ─────────────────────────────────────────────────────────
    log(`Acessando ${rawUrl}…`);
    // [FIX-D] seedPage newPage() sem timeout — browser sob carga pode pender indefinidamente
    const seedPage = await Promise.race([
      browser.newPage(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('seedPage newPage timeout')), NEW_PAGE_TIMEOUT)),
    ]);
    seedPage.setDefaultNavigationTimeout(THUMB_TIMEOUT * 2);
    await seedPage.setViewport({ width: 1280, height: 800 });
    // [FIX-12] Bloquear tracking scripts e media durante o crawl (discovery de links não precisa deles)
    await installSsrfInterceptor(seedPage, req => {
      const rt  = req.resourceType();
      const url = req.url();
      if (rt === 'media' || rt === 'font') { req.abort(); return; }
      if (rt === 'script' && CRAWL_BLOCK_RE.test(url)) { req.abort(); return; }
      req.continue();
    });

    let seedUrl, seedTitle, allHrefs, navHrefs;
    // [FIX-11] try/finally garante que seedPage é sempre fechada, mesmo se evaluate() jogar
    try {
      try {
        await Promise.race([
          seedPage.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }),
          new Promise(r => setTimeout(r, 8000)),
        ]);
      } catch {}

      seedUrl   = seedPage.url();
      seedTitle = await seedPage.title().catch(() => origin);
      log(`Página raiz carregada: "${seedTitle}"`);

      allHrefs = await seedPage.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).filter(Boolean)
      ).catch(() => []);
      navHrefs = await seedPage.evaluate(() => {
        const containers = document.querySelectorAll('nav, header, [class*="menu"], [class*="nav"], [class*="navigation"]');
        const out = [];
        containers.forEach(c => c.querySelectorAll('a[href]').forEach(a => out.push(a.getAttribute('href'))));
        return out.filter(Boolean);
      }).catch(() => []);
    } finally {
      // [FIX-D] close() com timeout — pode pendurar se requests interceptadas pendentes
      await Promise.race([seedPage.close(), new Promise(r => setTimeout(r, PAGE_CLOSE_TIMEOUT))]).catch(() => {});
    }
    seedUrl   = seedUrl   || rawUrl;
    allHrefs  = allHrefs  || [];
    navHrefs  = navHrefs  || [];

    // ── Dedup e priorização ────────────────────────────────────────────────
    const seen  = new Set();
    const queue = [];
    const addUrl = (href, priority) => {
      const n = normalizeUrl(href, origin);
      if (n && !seen.has(n) && !FILE_EXT_RE.test(n)) { seen.add(n); queue.push({ url: n, priority }); }
    };
    const normalSeed = normalizeUrl(seedUrl, origin) || rawUrl;
    seen.add(normalSeed);
    queue.push({ url: normalSeed, priority: 0 });
    navHrefs.forEach(h => addUrl(h, 1));
    allHrefs.forEach(h => addUrl(h, 2));
    queue.sort((a, b) => a.priority - b.priority);
    const totalFound = queue.length; // total before plan limit
    const toVisit = queue.slice(0, pageLimit);
    log(`${toVisit.length} página(s) na fila${totalFound > toVisit.length ? ` (${totalFound} encontradas, limite do plano: ${pageLimit})` : ''}.`);

    // ── Seed thumbnail ─────────────────────────────────────────────────────
    const seedThumbPath = path.join(thumbDir, 'page-000.jpg');
    await captureThumbnail(browser, normalSeed, seedThumbPath);
    const seedThumbExists = fs.existsSync(seedThumbPath);
    const results = [{
      url: normalSeed, title: seedTitle || origin,
      thumbnailPath: seedThumbExists ? seedThumbPath : null,
      thumbnailUrl:  seedThumbExists ? `/screenshots/${jobId}/thumbs/page-000.jpg` : null,
      pageType: inferPageType(normalSeed),
    }];

    // ── Remaining pages (paralelo, até THUMB_CONCURRENCY thumbnails simultâneas) ──
    let thumbActive = 0;
    const thumbQueue = [];
    const thumbAcquire = () => {
      if (thumbActive < THUMB_CONCURRENCY) { thumbActive++; return Promise.resolve(); }
      return new Promise(resolve => thumbQueue.push(() => { thumbActive++; resolve(); }));
    };
    const thumbRelease = () => { thumbActive--; if (thumbQueue.length > 0) thumbQueue.shift()(); };

    await Promise.allSettled(toVisit.slice(1).map(async ({ url }, idx) => {
      const i = idx + 1;
      if (url === normalSeed) return;
      const fname     = `page-${String(i).padStart(3, '0')}.jpg`;
      const thumbPath = path.join(thumbDir, fname);
      const thumbUrl  = `/screenshots/${jobId}/thumbs/${fname}`;
      await thumbAcquire();
      try {
        log(`Miniatura ${i}/${toVisit.length - 1}: ${url}`);
        let pg;
        let pageTitle = url;
        let finalUrl  = url;
        try {
          // [FIX-A] browser.newPage() com timeout explícito.
          // Sem isso: browser sob carga nunca responde → slot jamais liberado → páginas 5+ bloqueadas.
          pg = await Promise.race([
            browser.newPage(),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`[thumb] newPage timeout: ${url}`)), NEW_PAGE_TIMEOUT)),
          ]);
          pg.setDefaultNavigationTimeout(THUMB_TIMEOUT);
          await pg.setViewport({ width: 800, height: 500, deviceScaleFactor: 1 });
          await installSsrfInterceptor(pg, req => {
            const rt = req.resourceType();
            if (rt === 'media' || rt === 'font') { req.abort(); return; }
            req.continue();
          });
          try {
            await Promise.race([
              pg.goto(url, { waitUntil: 'domcontentloaded', timeout: THUMB_TIMEOUT }),
              new Promise(r => setTimeout(r, THUMB_TIMEOUT - 1000)), // 7s cap
            ]);
          } catch {}
          pageTitle = await pg.title().catch(() => url);
          finalUrl  = pg.url();
          // [FIX-VISUAL] Aguardar renderização visual antes do screenshot
          try {
            const hasContent = await pg.evaluate(() =>
              !!(document.body && document.body.innerText && document.body.innerText.trim().length > 50)
            ).catch(() => false);
            await new Promise(r => setTimeout(r, hasContent ? 200 : 500));
          } catch {}
          // [FIX-B] screenshot via Promise.race — garante que não pende mesmo se opção timeout ignorada
          let _shotOk = false;
          await Promise.race([
            pg.screenshot({ path: thumbPath, type: 'jpeg', quality: 50,
              clip: { x: 0, y: 0, width: 800, height: 500 } }).then(() => { _shotOk = true; }),
            new Promise(r => setTimeout(r, 4000)),
          ]).catch(() => {});
          // Se screenshot falhou silenciosamente, remover arquivo parcial → frontend usa placeholder
          if (!_shotOk) {
            try { if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath); } catch {}
          }
        } catch (e) {
          // newPage timeout, erro de navegação, etc. — logar e continuar com placeholder
          if (e && e.message) log(`[thumb] erro p.${i}: ${e.message.slice(0, 100)}`);
        } finally {
          // [FIX-B] pg.close() com timeout — .catch() sozinho não protege contra hang
          if (pg) await Promise.race([pg.close(), new Promise(r => setTimeout(r, PAGE_CLOSE_TIMEOUT))]).catch(() => {});
        }
        // Adiciona a página ao resultado — só inclui thumbnail se arquivo existe
        const thumbExists = fs.existsSync(thumbPath);
        results.push({
          url: finalUrl,
          title: pageTitle || finalUrl,
          thumbnailPath: thumbExists ? thumbPath : null,
          thumbnailUrl:  thumbExists ? thumbUrl  : null,
          pageType: inferPageType(finalUrl),
        });
      } catch { /* erro fatal inesperado — página ignorada */ }
      finally { thumbRelease(); }  // slot liberado — sempre executa
    }));

    log(`Exploração finalizada — ${results.length} página(s) dentro do limite, ${totalFound} descobertas no total.`);
    const rawPages = results.length > 0
      ? results
      : [{ url: rawUrl, title: rawUrl, thumbnailPath: '', thumbnailUrl: '', pageType: 'homepage' }];
    const pages = rankPages(rawPages);
    return { pages, totalFound: Math.max(totalFound, pages.length) };

  } finally {
    if (poolEntry) await releaseBrowserToPool(poolEntry);
  }
}

async function crawlSite(rawUrl, jobId, maxPages) {
  return Promise.race([
    _doCrawl(rawUrl, jobId, maxPages),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('O site demorou demais. Tente com outro site.')), CRAWL_TIMEOUT)
    ),
  ]);
}

module.exports = { crawlSite, groupPages, rankPages, deduplicatePages };
