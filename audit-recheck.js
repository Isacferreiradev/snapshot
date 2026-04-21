'use strict';

const fs   = require('fs');
const path = require('path');
const { initBrowserPool } = require('./browser-pool');
const { renderTemplate } = require('./renderer');

const SITES = [
  { url: 'https://github.com',    slug: 'github'  },
  { url: 'https://stripe.com',    slug: 'stripe'  },
  { url: 'https://nubank.com.br', slug: 'nubank'  },
];

const FIX_TEMPLATES = ['whatsapp-share','instagram-post','instagram-story','tiktok-mockup'];
const OUT_DIR = path.join(__dirname, 'audit-outputs');
const SRC_DIR = path.join(OUT_DIR, '_sources');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

async function main() {
  process.env.MAX_BROWSERS = '3';
  await initBrowserPool();

  const tasks = [];
  for (const site of SITES) {
    for (const device of ['desktop','mobile']) {
      for (const tid of FIX_TEMPLATES) {
        tasks.push({ site, device, tid });
      }
    }
  }

  let fail = 0;
  for (const { site, device, tid } of tasks) {
    const srcPath = path.join(SRC_DIR, `${site.slug}-${device}.png`);
    const outPath = path.join(OUT_DIR, site.slug, device, `${tid}.png`);
    const t0 = Date.now();
    try {
      const buf = await renderTemplate(tid, srcPath, device, {
        applyWatermark: false, pageTitle: site.slug, pageUrl: site.url, jobId: 'recheck',
      });
      if (!buf.slice(0,8).equals(PNG_MAGIC)) throw new Error('PNG inválido');
      fs.writeFileSync(outPath, buf);
      console.log(`✓ ${site.slug}/${device}/${tid} ${(buf.length/1024).toFixed(0)}KB ${Date.now()-t0}ms`);
    } catch (e) {
      fail++;
      console.log(`✗ ${site.slug}/${device}/${tid} ${e.message}`);
    }
  }
  console.log(`\nDone. ${tasks.length - fail}/${tasks.length} OK`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
