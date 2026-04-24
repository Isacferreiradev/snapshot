'use strict';

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { appendCrawlLog }                    = require('./jobs');
const { 
  getBrowserFromPool, 
  releaseBrowserToPool, 
  navigateFast, 
  navigateFallback,
  setupPage, 
  DESKTOP_UA 
} = require('./screenshotter');
const { validateUrl, installSsrfInterceptor } = require('./security');

const MAX_PAGES          = 50; // [FIX] Aumentado para 50 para suportar Agency em batch grande
const THUMB_TIMEOUT      = 10000; // goto cap
const PER_PAGE_HARDCAP   = 30000; // [FIX-CRITICAL] 30s para permitir cascade DCL+LOAD+SCREENSHOT
const CRAWL_TIMEOUT      = 120000; // 2 min total
const NEW_PAGE_TIMEOUT   = 5000;
const PAGE_CLOSE_TIMEOUT = 1500;
const OP_TIMEOUT         = 2000;  
const SCREENSHOT_TIMEOUT = 10000; // [FIX] Aumentado para 10s para sites ultra-pesados
const THUMB_CONCURRENCY  = 2;     // [STABLE] Reduzido para 2 para evitar picos de CPU/RAM
const THUMB_MIN_BYTES    = 1024;  // thumbnail mínimo aceitável (relaxado de 2048 — falsos negativos em páginas com fundo sólido)

// Race a promise against a timeout. On timeout, resolves with `fallback` (never throws).
function withTimeout(promise, ms, fallback) {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    Promise.resolve(promise).then(
      v => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      _ => { if (!done) { done = true; clearTimeout(t); resolve(fallback); } }
    );
  });
}

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

/** 
 * DISCOVERY ENGINE (LIGHT): 
 * Tenta extrair links via HTTP Request pura (Axios + Cheerio).
 * Muito mais rápido e consome 0% do Browser Pool.
 */
async function discoverLinksLight(url, origin) {
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': DESKTOP_UA },
      timeout: 8000,
      maxContentLength: 5 * 1024 * 1024, // 5MB limit
    });
    const $ = cheerio.load(data);
    const links = [];
    
    // Pegar links de navegação com prioridade
    $('nav a[href], header a[href], [class*="menu"] a[href], [class*="nav"] a[href]').each((_, el) => {
      const h = $(el).attr('href');
      if (h) links.push({ href: h, priority: 1 });
    });

    // Pegar todos os outros
    $('a[href]').each((_, el) => {
      const h = $(el).attr('href');
      if (h) links.push({ href: h, priority: 2 });
    });

    // Heurística de SPA: Se o body estiver vazio de texto, provavelmente precisa de JS
    const textLen = $('body').text().trim().length;
    return { links, isSPA: textLen < 100 };
  } catch (err) {
    return { links: [], isSPA: true, error: err.message };
  }
}

/** 
 * DISCOVERY ENGINE (HEAVY): 
 * Fallback via Puppeteer para extrair links de SPAs (React/Vue/etc).
 */
async function discoverLinksHeavy(browser, url, origin) {
  let pg;
  try {
    pg = await setupPage(browser, { width: 1280, height: 800 }, DESKTOP_UA, new URL(url).hostname);
    await navigateFast(pg, url, { timeout: 10000 });
    
    const data = await pg.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href'));
      const nav = [];
      document.querySelectorAll('nav,header,[class*="menu"],[class*="nav"]').forEach(c => {
        c.querySelectorAll('a[href]').forEach(a => nav.push(a.getAttribute('href')));
      });
      return { all, nav };
    });
    return { all: data.all, nav: data.nav };
  } catch {
    return { all: [], nav: [] };
  } finally {
    if (pg) await pg.close().catch(()=>{});
  }
}

/** CAPTURE ENGINE: Baseline + Fallback System */
async function captureThumbnail(browser, url, outputPath) {
  let pg;
  const hostname = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  
  try {
    pg = await setupPage(browser, { width: 800, height: 500, deviceScaleFactor: 1 }, DESKTOP_UA, hostname);
    
    // 1. Tentar Baseline
    await navigateFast(pg, url, { timeout: 12000, delay: 1000 });
    
    const shoot = async () => {
      await pg.screenshot({ path: outputPath, type: 'jpeg', quality: 50, clip: { x: 0, y: 0, width: 800, height: 500 } });
      return fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    };

    let size = await withTimeout(shoot(), 8000, 0);

    // 2. Fallback se imagem for 'lixo' (branca/vazia)
    if (size < THUMB_MIN_BYTES) {
      await navigateFallback(pg, url);
      size = await withTimeout(shoot(), 8000, 0);
    }

    if (size < THUMB_MIN_BYTES) {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    }
  } catch (err) {
    console.error(`[Thumb] Falha em ${url}:`, err.message);
  } finally {
    if (pg) await pg.close().catch(()=>{});
  }
}

async function _doCrawl(rawUrl, jobId, maxPages) {
  const urlCheck = await validateUrl(rawUrl);
  if (!urlCheck.valid) throw new Error(urlCheck.reason || 'URL não permitida.');
  rawUrl = urlCheck.url;

  const pageLimit = (maxPages && maxPages > 0) ? maxPages : MAX_PAGES;
  let origin;
  try { origin = new URL(rawUrl).origin; }
  catch { return { pages: [{ url: rawUrl, title: rawUrl, thumbnailPath: '', thumbnailUrl: '', pageType: 'homepage' }], totalFound: 1 }; }

  const thumbDir = path.join(__dirname, 'screenshots', jobId, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });

  const log = (msg) => { try { appendCrawlLog(jobId, msg); } catch {} };

  // 1. DISCOVERY PHASE (Light first, Heavy as fallback)
  log('Buscando estrutura do site…');
  let { links, isSPA } = await discoverLinksLight(rawUrl, origin);
  let allLinks = links;
  let seedTitle = '';

  let poolEntry;
  if (isSPA) {
    log('SPA detectada ou bloqueio simples. Usando motor de renderização para extração…');
    try {
      poolEntry = await getBrowserFromPool();
      const heavy = await discoverLinksHeavy(poolEntry.browser, rawUrl, origin);
      allLinks = [
        ...heavy.nav.map(h => ({ href: h, priority: 1 })),
        ...heavy.all.map(h => ({ href: h, priority: 2 }))
      ];
    } finally {
      if (poolEntry) await releaseBrowserToPool(poolEntry);
      poolEntry = null;
    }
  }

  // 2. DEDUPLICATE & RANK
  const seen  = new Set();
  const queue = [];
  const addUrl = (href, priority) => {
    const n = normalizeUrl(href, origin);
    if (n && !seen.has(n) && !FILE_EXT_RE.test(n)) { seen.add(n); queue.push({ url: n, priority }); }
  };

  const normalSeed = normalizeUrl(rawUrl, origin) || rawUrl;
  seen.add(normalSeed);
  queue.push({ url: normalSeed, priority: 0 });

  allLinks.forEach(l => addUrl(l.href, l.priority));
  queue.sort((a, b) => a.priority - b.priority);

  const totalFound = queue.length;
  const toVisit    = queue.slice(0, pageLimit);
  log(`${toVisit.length} página(s) na fila para captura.`);

  // 3. CAPTURE PHASE (Parallel capture with controlled concurrency)
  const results = new Array(toVisit.length).fill(null);
  let activeSlots = 0;
  const slotQueue = [];

  const acquireSlot = () => {
    if (activeSlots < THUMB_CONCURRENCY) { activeSlots++; return Promise.resolve(); }
    return new Promise(r => slotQueue.push(() => { activeSlots++; r(); }));
  };
  const releaseSlot = () => { activeSlots--; if (slotQueue.length > 0) slotQueue.shift()(); };

  await Promise.allSettled(toVisit.map(async (item, i) => {
    await acquireSlot();
    try {
      let workerPoolEntry;
      try {
        workerPoolEntry = await getBrowserFromPool();
        const fname = `page-${String(i).padStart(3, '0')}.jpg`;
        const thumbPath = path.join(thumbDir, fname);
        const thumbUrl = `/screenshots/${jobId}/thumbs/${fname}`;
        
        const startedAt = Date.now();
        // [CAPTURE] Executa o Baseline + Fallback
        await captureThumbnail(workerPoolEntry.browser, item.url, thumbPath);
        
        const exists = fs.existsSync(thumbPath);
        const elapsed = Date.now() - startedAt;
        log(`Miniatura ${i + 1}/${toVisit.length}: ${exists ? 'ok' : 'falhou'} (${elapsed}ms) — ${item.url}`);

        results[i] = {
          url: item.url,
          title: item.url, // Título será refinado via inferPageType p/ o crawler ser rápido
          thumbnailPath: exists ? thumbPath : null,
          thumbnailUrl:  exists ? thumbUrl  : null,
          pageType: inferPageType(item.url),
        };
      } finally {
        if (workerPoolEntry) await releaseBrowserToPool(workerPoolEntry);
      }
    } catch (err) {
      console.error(`[CrawlerTask] Erro crítico em ${item.url}:`, err.message);
    } finally {
      releaseSlot();
    }
  }));

  log(`Processo finalizado — ${results.filter(r => r && r.thumbnailPath).length} capturas realizadas.`);
  const finalPages = rankPages(results.filter(Boolean));
  return { pages: finalPages, totalFound };
}

async function crawlSite(rawUrl, jobId, maxPages) {
  return Promise.race([
    _doCrawl(rawUrl, jobId, maxPages),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('O site demorou demais ou houve erro no processamento.')), CRAWL_TIMEOUT)
    ),
  ]);
}

module.exports = { crawlSite, groupPages, rankPages, deduplicatePages };
