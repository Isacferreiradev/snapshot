'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { appendCrawlLog } = require('./jobs');

const MAX_PAGES     = 12;
const NAV_TIMEOUT   = 15000;
const THUMB_TIMEOUT = 8000;
const CRAWL_TIMEOUT = 45000;

const FILE_EXT_RE = /\.(pdf|zip|jpg|jpeg|png|gif|webp|svg|css|js|ico|woff|woff2|ttf|eot|mp4|mp3|xml|json)(\?|$)/i;

function inferPageType(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p === '/' || p === '' || p === '/index' || p === '/index.html') return 'homepage';
    if (/\/(blog|post|article|news|story|update)/.test(p)) return 'article';
    if (/\/(shop|product|item|store|buy|cart|checkout|produto|loja)/.test(p)) return 'product';
    if (/\/(about|sobre|equipe|team|company|empresa|contato|contact|quem-somos)/.test(p)) return 'about';
    if (/\/(pricing|preco|planos|plans|price)/.test(p)) return 'pricing';
    if (/\/(service|servico|portfolio|work|projeto|project)/.test(p)) return 'service';
  } catch {}
  return 'other';
}

function normalizeUrl(raw, origin) {
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

async function captureThumbnail(browser, url, outputPath) {
  try {
    const pg = await browser.newPage();
    pg.setDefaultNavigationTimeout(THUMB_TIMEOUT);
    await pg.setViewport({ width: 1440, height: 900 });
    try { await pg.goto(url, { waitUntil: 'networkidle2', timeout: THUMB_TIMEOUT }); }
    catch { await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: THUMB_TIMEOUT }).catch(() => {}); }
    await pg.screenshot({ path: outputPath, type: 'jpeg', quality: 40, clip: { x: 0, y: 0, width: 1440, height: 900 } });
    await pg.close();
  } catch {
    try { fs.writeFileSync(outputPath, Buffer.alloc(0)); } catch {}
  }
}

async function _doCrawl(rawUrl, jobId) {
  let origin;
  try { origin = new URL(rawUrl).origin; }
  catch { return [{ url: rawUrl, title: rawUrl, thumbnailPath: '', thumbnailUrl: '', pageType: 'homepage' }]; }

  const thumbDir = path.join(__dirname, 'screenshots', jobId, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });

  const log = (msg) => { try { appendCrawlLog(jobId, msg); } catch {} };

  let browser;
  try {
    log('Abrindo navegador…');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
             '--disable-blink-features=AutomationControlled'],
    });

    // ── Seed page ─────────────────────────────────────────────────────────
    log(`Acessando ${rawUrl}…`);
    const seedPage = await browser.newPage();
    seedPage.setDefaultNavigationTimeout(NAV_TIMEOUT);
    await seedPage.setViewport({ width: 1440, height: 900 });
    try { await seedPage.goto(rawUrl, { waitUntil: 'networkidle2' }); }
    catch { await seedPage.goto(rawUrl, { waitUntil: 'domcontentloaded' }).catch(() => {}); }

    const seedUrl   = seedPage.url();
    const seedTitle = await seedPage.title().catch(() => origin);
    log(`Página raiz carregada: "${seedTitle}"`);

    const allHrefs  = await seedPage.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).filter(Boolean)
    ).catch(() => []);
    const navHrefs  = await seedPage.evaluate(() => {
      const containers = document.querySelectorAll('nav, header, [class*="menu"], [class*="nav"], [class*="navigation"]');
      const out = [];
      containers.forEach(c => c.querySelectorAll('a[href]').forEach(a => out.push(a.getAttribute('href'))));
      return out.filter(Boolean);
    }).catch(() => []);
    await seedPage.close().catch(() => {});

    // ── Dedup and prioritise ───────────────────────────────────────────────
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
    const toVisit = queue.slice(0, MAX_PAGES);
    log(`${toVisit.length} página(s) na fila para captura de miniaturas.`);

    // ── Seed thumbnail ─────────────────────────────────────────────────────
    const seedThumbPath = path.join(thumbDir, 'page-000.jpg');
    await captureThumbnail(browser, normalSeed, seedThumbPath);
    const results = [{
      url: normalSeed, title: seedTitle || origin,
      thumbnailPath: seedThumbPath, thumbnailUrl: `/screenshots/${jobId}/thumbs/page-000.jpg`,
      pageType: inferPageType(normalSeed),
    }];

    // ── Remaining pages — individual try-catch per page ────────────────────
    for (let i = 1; i < toVisit.length; i++) {
      const { url } = toVisit[i];
      if (url === normalSeed) continue;
      const fname     = `page-${String(i).padStart(3, '0')}.jpg`;
      const thumbPath = path.join(thumbDir, fname);
      const thumbUrl  = `/screenshots/${jobId}/thumbs/${fname}`;
      log(`Capturando miniatura ${i}/${toVisit.length - 1}: ${url}`);
      try {
        const pg = await browser.newPage();
        pg.setDefaultNavigationTimeout(THUMB_TIMEOUT);
        await pg.setViewport({ width: 1440, height: 900 });
        try { await pg.goto(url, { waitUntil: 'networkidle2', timeout: THUMB_TIMEOUT }); }
        catch { await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: THUMB_TIMEOUT }).catch(() => {}); }
        const pageTitle = await pg.title().catch(() => url);
        const finalUrl  = pg.url();
        await pg.screenshot({ path: thumbPath, type: 'jpeg', quality: 40, clip: { x: 0, y: 0, width: 1440, height: 900 } }).catch(() => {});
        await pg.close().catch(() => {});
        results.push({ url: finalUrl, title: pageTitle || finalUrl, thumbnailPath: thumbPath, thumbnailUrl: thumbUrl, pageType: inferPageType(finalUrl) });
      } catch { /* página falhou — continua para a próxima */ }
    }

    log(`Exploração finalizada — ${results.length} página(s) encontrada(s).`);

    // Sempre retorna pelo menos a homepage
    return results.length > 0
      ? results
      : [{ url: rawUrl, title: rawUrl, thumbnailPath: '', thumbnailUrl: '', pageType: 'homepage' }];

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function crawlSite(rawUrl, jobId) {
  return Promise.race([
    _doCrawl(rawUrl, jobId),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('O site demorou demais para responder. Tente com outro site.')), CRAWL_TIMEOUT)
    ),
  ]);
}

module.exports = { crawlSite };
