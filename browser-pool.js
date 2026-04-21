'use strict';

const puppeteer = require('puppeteer');

// [FIX-2] Pool size from env (default 3). Was hardcoded.
const POOL_SIZE = Math.max(1, parseInt(process.env.MAX_BROWSERS || '3', 10));

const pool = [];
let poolReady = false;

function launchArgs() {
  return {
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-blink-features=AutomationControlled',
      // REMOVIDO: --disable-web-security e --allow-running-insecure-content
      // Essas flags desabilitam CORS e permitiam SSRF via XHR dentro das páginas
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--no-first-run',
      '--disable-features=VizDisplayCompositor',
      '--window-size=1440,900', '--lang=pt-BR,pt,en-US',
    ],
  };
}

async function launchBrowser() {
  return puppeteer.launch(launchArgs());
}

async function _spawnEntry() {
  const browser = await launchBrowser();
  const entry = { browser, busy: false, temp: false };
  pool.push(entry);

  // [FIX-4] Detectar crash imediatamente via evento — não esperar o health check de 60s
  browser.on('disconnected', () => {
    const idx = pool.indexOf(entry);
    if (idx !== -1) {
      console.log('[pool] browser desconectou inesperadamente — removendo e substituindo…');
      pool.splice(idx, 1);
      _spawnEntry().catch(e => console.error('[pool] falha ao substituir browser crashado:', e.message));
    }
  });
  // [FIX] Warmup: create a blank page to ensure browser is fully functional before returning
  try {
    const pg = await browser.newPage();
    await pg.goto('about:blank');
    await pg.close();
  } catch (err) {
    console.warn('[pool] falha no warmup do browser, ele pode estar instável:', err.message);
  }

  return entry;
}

async function initBrowserPool() {
  console.log('[pool] iniciando browser pool…');
  for (let i = 0; i < POOL_SIZE; i++) {
    try { await _spawnEntry(); }
    catch (e) { console.error('[pool] erro ao iniciar browser:', e.message); }
  }
  poolReady = true;
  console.log(`[pool] ${pool.length} browser(s) prontos.`);

  // ── Health check a cada 60s — reinicia browsers que crasharam ────────────
  setInterval(async () => {
    for (let i = 0; i < pool.length; i++) {
      const entry = pool[i];
      if (entry.busy) continue; // não interromper capturas em andamento
      try {
        await entry.browser.pages(); // ping: lança se o browser morreu
      } catch (err) {
        console.log(`[pool] health check falhou para browser ${i} — reiniciando: ${err.message}`);
        pool.splice(i, 1);
        i--;
        try {
          await entry.browser.close().catch(() => {});
        } catch {}
        try { await _spawnEntry(); } catch (e2) { console.error('[pool] falha ao substituir browser:', e2.message); }
      }
    }
    // Garantir que o pool nunca fique vazio
    while (pool.length < POOL_SIZE) {
      try { await _spawnEntry(); } catch { break; }
    }
  }, 60 * 1000);
}

async function getBrowserFromPool() {
  let pollInterval = 200;      // ms inicial
  const MAX_POLL_INTERVAL = 2000; // ms máximo entre verificações
  const MAX_WAIT      = 90000; // [FIX] aumentado de 60s para 90s — se não liberou, algo travou
  const start = Date.now();

  while (true) {
    for (const entry of pool) {
      if (entry.busy) continue;
      // [FIX-3] Verificar saúde antes de entregar — browser.connected não existe no Puppeteer,
      // a API correta é isConnected(). Sem essa verificação, browsers crashados eram entregues.
      if (!entry.browser.isConnected()) {
        console.log('[pool] browser morto detectado no getBrowserFromPool — descartando…');
        const idx = pool.indexOf(entry);
        if (idx !== -1) pool.splice(idx, 1);
        try { await entry.browser.close().catch(() => {}); } catch {}
        _spawnEntry().catch(e => console.error('[pool] falha ao repor browser:', e.message));
        break; // re-iterar o array (tamanho mudou)
      }
      entry.busy = true;
      return entry;
    }
    if (Date.now() - start > MAX_WAIT) {
      throw new Error(`[pool] Timeout aguardando browser livre (${MAX_WAIT/1000}s)`);
    }
    await new Promise(r => setTimeout(r, pollInterval));
    // [FIX] Backoff exponencial na verificação para não estressar a CPU
    pollInterval = Math.min(pollInterval * 1.5, MAX_POLL_INTERVAL);
  }
}

async function releaseBrowserToPool(entry) {
  if (!entry) return;
  const idx = pool.indexOf(entry);
  if (idx === -1) { await entry.browser.close().catch(() => {}); return; }
  // [FIX-1] browser.connected não existe no Puppeteer — era sempre undefined, nunca detectava crash.
  // A API correta é isConnected() (método). Sem isso, browsers mortos voltavam ao pool.
  if (!entry.browser.isConnected()) {
    console.log('[pool] browser crashou no release — substituindo…');
    pool.splice(idx, 1);
    try { await _spawnEntry(); } catch {}
    return;
  }
  entry.busy = false;
}

module.exports = { initBrowserPool, getBrowserFromPool, releaseBrowserToPool, launchBrowser };
