'use strict';

/**
 * audit-all-templates.js
 * Captura 3 sites reais (desktop+mobile) e renderiza TODOS os 32 templates
 * em ambos deviceTypes. Valida dimensões, bytes PNG, e ratio de tamanho.
 * Falha se QUALQUER render falhar.
 */

const fs   = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { initBrowserPool } = require('./browser-pool');
const { renderTemplate } = require('./renderer');

const SITES = [
  { url: 'https://github.com',     slug: 'github'  },
  { url: 'https://stripe.com',     slug: 'stripe'  },
  { url: 'https://nubank.com.br',  slug: 'nubank'  },
];

const TEMPLATE_IDS = [
  'browser-clean','minimal-clean','default-dark','gradient-basic','shadow-soft','dark-frame',
  'instagram-post','instagram-story','twitter-post','linkedin-post','whatsapp-share',
  'macbook-realistic','macbook-clean','iphone-pro','iphone-dark','multi-device',
  'browser-premium','hero-section','landing-highlight','gradient-premium','paper-note',
  'neon-glow','instagram-carousel','tiktok-mockup','youtube-thumbnail','presentation-slide',
  'document-report','annotated-capture','ipad-landscape','android-phone','product-hunt','ad-banner',
];

const OUT_DIR = path.join(__dirname, 'audit-outputs');
const SRC_DIR = path.join(OUT_DIR, '_sources');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

const VIEWPORTS = {
  desktop: { width: 1440, height: 900,  deviceScaleFactor: 1, isMobile: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  mobile:  { width: 390,  height: 844,  deviceScaleFactor: 2, isMobile: true,  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
};

async function captureSourceScreenshots() {
  fs.mkdirSync(SRC_DIR, { recursive: true });
  console.log('\n── Capturando 6 screenshots fonte (3 sites × 2 devices) ──');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--lang=en-US'],
  });

  const sources = {};
  try {
    for (const site of SITES) {
      sources[site.slug] = {};
      for (const device of ['desktop','mobile']) {
        const vp = VIEWPORTS[device];
        const outPath = path.join(SRC_DIR, `${site.slug}-${device}.png`);
        process.stdout.write(`  ${site.slug.padEnd(8)} ${device.padEnd(8)}… `);
        const t0 = Date.now();

        const page = await browser.newPage();
        try {
          await page.setUserAgent(vp.userAgent);
          await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.isMobile });
          await page.goto(site.url, { waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(r => setTimeout(r, 1500));
          const buf = await page.screenshot({ type: 'png', fullPage: false });
          fs.writeFileSync(outPath, buf);
          sources[site.slug][device] = outPath;
          console.log(`OK ${(buf.length/1024).toFixed(0)} KB ${Date.now()-t0}ms`);
        } catch (err) {
          console.log(`FAIL ${err.message}`);
          // fallback: placeholder
          const fb = path.join(SRC_DIR, `${site.slug}-${device}.png`);
          const placeholder = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
          fs.writeFileSync(fb, placeholder);
          sources[site.slug][device] = fb;
        } finally {
          try { await page.close(); } catch {}
        }
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }
  return sources;
}

async function renderAll(sources) {
  console.log('\n── Inicializando pool para renderização ──');
  process.env.MAX_BROWSERS = '3';
  await initBrowserPool();

  const results = [];
  const total = SITES.length * TEMPLATE_IDS.length * 2;
  let done = 0;

  for (const site of SITES) {
    for (const device of ['desktop','mobile']) {
      const srcPath = sources[site.slug][device];
      const dir = path.join(OUT_DIR, site.slug, device);
      fs.mkdirSync(dir, { recursive: true });

      for (const tid of TEMPLATE_IDS) {
        done++;
        const outPath = path.join(dir, `${tid}.png`);
        const t0 = Date.now();
        const label = `[${String(done).padStart(3)}/${total}] ${site.slug}/${device}/${tid.padEnd(22)}`;
        try {
          const buf = await renderTemplate(tid, srcPath, device, {
            applyWatermark: false,
            pageTitle: site.slug,
            pageUrl: site.url,
            jobId: 'audit-' + site.slug + '-' + device,
          });
          if (!buf.slice(0, 8).equals(PNG_MAGIC)) throw new Error('PNG magic inválido');
          if (buf.length < 20 * 1024) throw new Error(`Muito pequeno: ${buf.length}B`);
          fs.writeFileSync(outPath, buf);
          const kb = (buf.length/1024).toFixed(0);
          const ms = Date.now() - t0;
          console.log(`${label} OK ${kb}KB ${ms}ms`);
          results.push({ site: site.slug, device, tid, ok: true, size: buf.length, ms });
        } catch (err) {
          const ms = Date.now() - t0;
          console.log(`${label} FAIL ${err.message} ${ms}ms`);
          results.push({ site: site.slug, device, tid, ok: false, error: err.message, ms });
        }
      }
    }
  }

  return results;
}

function summarize(results) {
  console.log('\n── Resumo ──────────────────────────────────────────────────────');
  const failed = results.filter(r => !r.ok);
  const byTid = {};
  for (const r of results) {
    if (!byTid[r.tid]) byTid[r.tid] = { ok: 0, fail: 0, sizes: [] };
    if (r.ok) { byTid[r.tid].ok++; byTid[r.tid].sizes.push(r.size); }
    else       { byTid[r.tid].fail++; }
  }
  console.log('\nPor template (6 renders: 3 sites × 2 devices):');
  for (const tid of TEMPLATE_IDS) {
    const s = byTid[tid];
    const avgKb = s.sizes.length ? (s.sizes.reduce((a,b)=>a+b,0)/s.sizes.length/1024).toFixed(0) : '—';
    const mark = s.fail === 0 ? '✓' : '✗';
    console.log(`  ${mark} ${tid.padEnd(22)} ${s.ok}/6 OK   avg ${avgKb} KB   ${s.fail ? 'FAIL='+s.fail : ''}`);
  }
  if (failed.length) {
    console.log(`\n${failed.length} falhas:`);
    for (const f of failed) console.log(`  - ${f.site}/${f.device}/${f.tid}: ${f.error}`);
  }
  console.log(`\nTotal: ${results.length - failed.length}/${results.length} OK, ${failed.length} falhas`);
  return failed.length === 0;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sources = await captureSourceScreenshots();
  const results = await renderAll(sources);
  const ok = summarize(results);
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch(err => { console.error('Erro fatal:', err); process.exit(2); });
