'use strict';

const fs   = require('fs');
const path = require('path');
const { appendCrawlLog }                    = require('./jobs');
const { getBrowserFromPool, releaseBrowserToPool } = require('./screenshotter');
const { validateUrl, installSsrfInterceptor } = require('./security');

const MAX_PAGES    = 12;
const THUMB_TIMEOUT = 5000;
const CRAWL_TIMEOUT = 90000; // 1.5 min (reduzido com pool)

const FILE_EXT_RE = /\.(pdf|zip|jpg|jpeg|png|gif|webp|svg|css|js|ico|woff|woff2|ttf|eot|mp4|mp3|xml|json)(\?|$)/i;

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
    return u.href;
  } catch { return null; }
}

/** Captura thumbnail leve: 800x500, jpeg q50, sem fullPage, timeout 5s */
async function captureThumbnail(browser, url, outputPath) {
  let pg;
  try {
    pg = await browser.newPage();
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
        new Promise(r => setTimeout(r, THUMB_TIMEOUT - 500)),
      ]);
    } catch {}
    await pg.screenshot({ path: outputPath, type: 'jpeg', quality: 50,
      clip: { x: 0, y: 0, width: 800, height: 500 }, timeout: 4000 });
    await pg.close().catch(() => {});
  } catch {
    if (pg) await pg.close().catch(() => {});
    // Escreve SVG placeholder
    try {
      const svgPath = outputPath.replace('.jpg', '.svg');
      fs.writeFileSync(svgPath, THUMB_PLACEHOLDER_SVG);
    } catch {}
    try { fs.writeFileSync(outputPath, Buffer.alloc(0)); } catch {}
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
    const seedPage = await browser.newPage();
    seedPage.setDefaultNavigationTimeout(THUMB_TIMEOUT * 2);
    await seedPage.setViewport({ width: 1280, height: 800 });
    try {
      await Promise.race([
        seedPage.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }),
        new Promise(r => setTimeout(r, 8000)),
      ]);
    } catch {}

    const seedUrl   = seedPage.url();
    const seedTitle = await seedPage.title().catch(() => origin);
    log(`Página raiz carregada: "${seedTitle}"`);

    const allHrefs = await seedPage.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).filter(Boolean)
    ).catch(() => []);
    const navHrefs = await seedPage.evaluate(() => {
      const containers = document.querySelectorAll('nav, header, [class*="menu"], [class*="nav"], [class*="navigation"]');
      const out = [];
      containers.forEach(c => c.querySelectorAll('a[href]').forEach(a => out.push(a.getAttribute('href'))));
      return out.filter(Boolean);
    }).catch(() => []);
    await seedPage.close().catch(() => {});

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
    const results = [{
      url: normalSeed, title: seedTitle || origin,
      thumbnailPath: seedThumbPath,
      thumbnailUrl:  `/screenshots/${jobId}/thumbs/page-000.jpg`,
      pageType: inferPageType(normalSeed),
    }];

    // ── Remaining pages ────────────────────────────────────────────────────
    for (let i = 1; i < toVisit.length; i++) {
      const { url } = toVisit[i];
      if (url === normalSeed) continue;
      const fname     = `page-${String(i).padStart(3, '0')}.jpg`;
      const thumbPath = path.join(thumbDir, fname);
      const thumbUrl  = `/screenshots/${jobId}/thumbs/${fname}`;
      log(`Miniatura ${i}/${toVisit.length - 1}: ${url}`);
      try {
        let pg;
        try {
          pg = await browser.newPage();
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
              new Promise(r => setTimeout(r, THUMB_TIMEOUT - 500)),
            ]);
          } catch {}
          const pageTitle = await pg.title().catch(() => url);
          const finalUrl  = pg.url();
          await pg.screenshot({ path: thumbPath, type: 'jpeg', quality: 50,
            clip: { x: 0, y: 0, width: 800, height: 500 }, timeout: 4000 }).catch(() => {});
          await pg.close().catch(() => {}); pg = null;
          results.push({ url: finalUrl, title: pageTitle || finalUrl, thumbnailPath: thumbPath, thumbnailUrl: thumbUrl, pageType: inferPageType(finalUrl) });
        } finally {
          if (pg) await pg.close().catch(() => {});
        }
      } catch { /* página falhou — continua */ }
    }

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

module.exports = { crawlSite, groupPages, rankPages };
