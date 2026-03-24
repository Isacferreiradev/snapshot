'use strict';

/**
 * test-templates.js
 * Renders all 12 templates and validates output files.
 * Usage: node test-templates.js
 */

const fs   = require('fs');
const path = require('path');

const { renderTemplate }      = require('./renderer');
const { initBrowserPool }     = require('./browser-pool');

const TEMPLATE_IDS = [
  'void',
  'chrome',
  'float',
  'annotation',
  'macbook',
  'iphone-pro',
  'browser-dark',
  'terminal',
  'paper',
  'presentation-slide',
  'duo-split',
  'device-glow',
  'cinematic',
  'gradient-mesh',
  'noir',
  'neon',
];

const OUTPUT_DIR      = path.join(__dirname, 'test-outputs');
const PLACEHOLDER_PNG = path.join(__dirname, 'test-placeholder.png');

// PNG magic bytes
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// ── Create a placeholder screenshot PNG using Puppeteer ──────────────────────

async function createPlaceholder() {
  const { getBrowserFromPool, releaseBrowserToPool } = require('./browser-pool');
  let entry = null;
  let page  = null;
  try {
    entry = await getBrowserFromPool();
    page  = await entry.browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.setContent(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <style>*{margin:0;padding:0;}body{width:1440px;height:900px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);display:flex;align-items:center;justify-content:center;font-family:sans-serif;}</style>
      </head><body><div style="color:white;font-size:48px;font-weight:700;opacity:0.8;">Test Page — snapshot.pro</div></body></html>
    `, { waitUntil: 'networkidle0', timeout: 10000 });
    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1440, height: 900 } });
    fs.writeFileSync(PLACEHOLDER_PNG, buf);
    console.log(`✓ Placeholder PNG criado: ${PLACEHOLDER_PNG} (${buf.length} bytes)`);
  } finally {
    try { if (page)  await page.close();               } catch {}
    try { if (entry) await releaseBrowserToPool(entry); } catch {}
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Iniciando browser pool…');
  await initBrowserPool();

  console.log('\nCriando placeholder PNG…');
  await createPlaceholder();

  const options = {
    applyWatermark: true,
    pageTitle:      'Test Page',
    pageUrl:        'https://stripe.com',
    jobId:          'test-001',
  };

  const results = [];

  for (const id of TEMPLATE_IDS) {
    process.stdout.write(`Renderizando ${id.padEnd(20)} … `);
    const outputPath = path.join(OUTPUT_DIR, `${id}.png`);
    const t0 = Date.now();
    try {
      const buffer = await renderTemplate(id, PLACEHOLDER_PNG, 'desktop', options);

      // Validate PNG magic bytes
      const magic = buffer.slice(0, 8);
      if (!magic.equals(PNG_MAGIC)) throw new Error('Bytes iniciais não são PNG válido');

      // Validate minimum size (80 KB)
      if (buffer.length < 80 * 1024) throw new Error(`Arquivo muito pequeno: ${buffer.length} bytes (mín 80 KB)`);

      fs.writeFileSync(outputPath, buffer);
      const elapsed = Date.now() - t0;
      console.log(`OK  ${(buffer.length / 1024).toFixed(0)} KB  ${elapsed}ms`);
      results.push({ id, ok: true, size: buffer.length, elapsed });
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.log(`FAIL  ${err.message}  ${elapsed}ms`);
      results.push({ id, ok: false, error: err.message, elapsed });
    }
  }

  console.log('\n── Resumo ──────────────────────────────────────────────────────');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  for (const r of results) {
    const status = r.ok ? '✓' : '✗';
    const info   = r.ok ? `${(r.size / 1024).toFixed(0)} KB` : r.error;
    console.log(`  ${status} ${r.id.padEnd(22)} ${info}`);
  }
  console.log(`\n${passed}/${TEMPLATE_IDS.length} templates OK${failed > 0 ? `  —  ${failed} FALHARAM` : ''}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
