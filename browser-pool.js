'use strict';

const puppeteer = require('puppeteer');

const POOL_SIZE = 3;

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
  const POLL_INTERVAL = 200;   // ms entre verificações
  const MAX_WAIT      = 60000; // 60s — se não liberou, algo travou
  const start = Date.now();

  while (true) {
    for (const entry of pool) {
      if (!entry.busy) { entry.busy = true; return entry; }
    }
    if (Date.now() - start > MAX_WAIT) {
      throw new Error('[pool] Timeout aguardando browser livre (60s)');
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

async function releaseBrowserToPool(entry) {
  if (!entry) return;
  const idx = pool.indexOf(entry);
  if (idx === -1) { await entry.browser.close().catch(() => {}); return; }
  try {
    if (entry.browser.connected === false) throw new Error('disconnected');
    entry.busy = false;
  } catch {
    console.log('[pool] browser crashou, substituindo…');
    pool.splice(idx, 1);
    try { await _spawnEntry(); } catch {}
  }
}

module.exports = { initBrowserPool, getBrowserFromPool, releaseBrowserToPool, launchBrowser };
