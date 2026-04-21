'use strict';
/**
 * mobile-audit.js
 * Puppeteer harness that navigates the Snapdeck app at 390×844 (iPhone 12 Pro)
 * and captures every screen + modal state, producing PNG evidence in mobile-audit/.
 *
 * Usage:  node mobile-audit.js [label]   (label defaults to "after")
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const LABEL   = process.argv[2] || 'after';
const OUT_DIR = path.join(__dirname, 'mobile-audit', LABEL);
const URL     = 'http://localhost:3001/index.html';
const VP      = { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const UA      = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function shot(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  // fullPage:true mostra toda a página, útil para ver scroll. Full-viewport também é útil.
  await page.screenshot({ path: file, fullPage: true });
  const stat = fs.statSync(file);
  console.log(`  ✓ ${name.padEnd(28)} ${(stat.size/1024).toFixed(0).padStart(4)}KB`);
}

async function shotViewport(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const stat = fs.statSync(file);
  console.log(`  ✓ ${name.padEnd(28)} ${(stat.size/1024).toFixed(0).padStart(4)}KB (viewport)`);
}

async function scrollTop(page) { await page.evaluate(() => window.scrollTo(0, 0)); await delay(120); }

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Mobile audit → ${OUT_DIR}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--lang=pt-BR'],
  });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport(VP);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

  console.log('\n── Load /index.html ──');
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 20000 });
  await delay(400);

  // ═══ S1: HERO / URL entry ══════════════════════════════════════════════
  console.log('\n── Section S1: Hero ──');
  await scrollTop(page);
  await shotViewport(page, '01-s1-hero-viewport');
  await shotViewport(page,'01-s1-hero-fullpage');

  // Simula erro de URL: deixa input vazio e clica no botão
  console.log('\n── Section S1: Error state ──');
  await page.evaluate(() => {
    const err = document.getElementById('url-err');
    if (err) { err.textContent = 'URL inválida. Use o formato https://exemplo.com'; err.classList.add('on'); }
  });
  await shotViewport(page, '02-s1-url-error');

  // ═══ Header history dropdown ═════════════════════════════════════════════
  console.log('\n── Header: History dropdown ──');
  await page.evaluate(() => {
    const dd = document.getElementById('history-dropdown');
    if (dd) dd.classList.add('open');
    const list = document.getElementById('history-dropdown-list');
    if (list) list.innerHTML = `
      <div class="hist-job-row"><div class="hist-job-thumb"></div>
        <div class="hist-job-meta"><div class="hist-job-domain">github.com</div><div class="hist-job-sub">5 capturas · agora</div></div>
        <div class="hist-job-dl">↓</div></div>
      <div class="hist-job-row"><div class="hist-job-thumb"></div>
        <div class="hist-job-meta"><div class="hist-job-domain">stripe.com</div><div class="hist-job-sub">3 capturas · há 2min</div></div>
        <div class="hist-job-dl">↓</div></div>
      <div class="hist-job-row"><div class="hist-job-thumb"></div>
        <div class="hist-job-meta"><div class="hist-job-domain">nubank.com.br</div><div class="hist-job-sub">8 capturas · há 5min</div></div>
        <div class="hist-job-dl">↓</div></div>`;
  });
  await new Promise(r => setTimeout(r, 250));
  await shotViewport(page, '03-header-history-open');
  await page.evaluate(() => { const dd = document.getElementById('history-dropdown'); if (dd) dd.classList.remove('open'); });

  // ═══ Capture limit banner ════════════════════════════════════════════════
  console.log('\n── Capture limit banner (free exhausted) ──');
  await page.evaluate(() => {
    const el = document.getElementById('capture-limit-banner');
    if (el) el.classList.add('shown');
    const txt = document.getElementById('cap-limit-text');
    if (txt) txt.textContent = 'Suas 3 capturas gratuitas de hoje acabaram. Assine para continuar.';
  });
  await scrollTop(page);
  await shotViewport(page, '04-capture-limit-banner');
  await page.evaluate(() => { const el = document.getElementById('capture-limit-banner'); if (el) el.classList.remove('shown'); });

  // ═══ PIX pending banner ═════════════════════════════════════════════════
  await page.evaluate(() => { const el = document.getElementById('pix-pending-banner'); if (el) el.classList.add('show'); });
  await shotViewport(page, '05-pix-pending-banner');
  await page.evaluate(() => { const el = document.getElementById('pix-pending-banner'); if (el) el.classList.remove('show'); });

  // ═══ S2: CRAWLING ═══════════════════════════════════════════════════════
  console.log('\n── Section S2: Crawling progress ──');
  await page.evaluate(() => {
    document.querySelectorAll('.s').forEach(el => { el.classList.remove('in','vis'); });
    const s2 = document.getElementById('s2');
    if (s2) { s2.classList.add('in','vis'); }
    const phase = document.querySelector('.crawl-phase'); if (phase) phase.textContent = 'Explorando páginas…';
    const n = document.querySelector('.crawl-n'); if (n) n.textContent = '7';
    const log = document.querySelector('.crawl-log');
    if (log) {
      log.innerHTML = `
        <div class="log-entry in"><span class="log-ts">00:01</span> Iniciando crawl…</div>
        <div class="log-entry in"><span class="log-ts">00:03</span> Encontrada: /home</div>
        <div class="log-entry in"><span class="log-ts">00:05</span> Encontrada: /pricing</div>
        <div class="log-entry in"><span class="log-ts">00:07</span> Encontrada: /features</div>
        <div class="log-entry in"><span class="log-ts">00:09</span> Encontrada: /about</div>`;
    }
  });
  await scrollTop(page);
  await shotViewport(page,'06-s2-crawling');

  // ═══ S3: PAGE SELECTION ═════════════════════════════════════════════════
  console.log('\n── Section S3: Page selection ──');
  await page.evaluate(() => {
    document.querySelectorAll('.s').forEach(el => { el.classList.remove('in','vis'); });
    const s3 = document.getElementById('s3'); if (s3) { s3.classList.add('in','vis'); }
    const grid = document.querySelector('.pages-grid');
    if (grid) {
      grid.classList.remove('grouped');
      const sampleThumb = `<div class="pc-thumb"><div class="pc-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.2"><rect x="3" y="5" width="18" height="14" rx="2"/></svg></div></div>`;
      const pages = [
        ['Home', 'github.com/', 'homepage'],
        ['Pricing', 'github.com/pricing', 'pricing'],
        ['Features', 'github.com/features', 'product'],
        ['Enterprise', 'github.com/enterprise', 'product'],
        ['About us', 'github.com/about', 'about'],
        ['Security', 'github.com/security', 'service'],
        ['Blog post about DX engineering and developer productivity', 'github.com/blog/dx-engineering', 'article'],
        ['Careers', 'github.com/careers', 'other'],
      ];
      grid.innerHTML = pages.map(([title, url, type]) => `
        <div class="page-card">${sampleThumb}
          <div class="pc-body">
            <div class="pc-title">${title}</div>
            <div class="pc-url">${url}</div>
            <span class="pt-badge pt-${type}">${type}</span>
          </div>
        </div>`).join('');
    }
    const msg = document.getElementById('crawl-limit-msg');
    if (msg) { msg.classList.add('shown'); const t = document.getElementById('crawl-limit-text'); if (t) t.textContent = 'Seu plano permite até 4 páginas. Este site tem 78 páginas.'; }
    const nextText = document.getElementById('s3-next-text'); if (nextText) nextText.textContent = '3 páginas selecionadas · Continuar';
    const nextBtn = document.getElementById('s3-next-btn'); if (nextBtn) nextBtn.disabled = false;
  });
  await scrollTop(page);
  await shotViewport(page,'07-s3-page-selection');

  // ═══ S4: TEMPLATES ══════════════════════════════════════════════════════
  console.log('\n── Section S4: Template gallery ──');
  await page.evaluate(() => {
    document.querySelectorAll('.s').forEach(el => { el.classList.remove('in','vis'); });
    const s4 = document.getElementById('s4'); if (s4) { s4.classList.add('in','vis'); }
    const firstCard = document.querySelector('.tmpl-card'); if (firstCard) firstCard.classList.add('sel');
  });
  await scrollTop(page);
  await shotViewport(page,'08-s4-templates');

  // Template sheet (drawer lateral)
  console.log('\n── Section S4: Template sheet drawer ──');
  await page.evaluate(() => {
    const overlay = document.getElementById('tmpl-sheet-overlay');
    const sheet   = document.getElementById('tmpl-sheet');
    if (overlay) overlay.classList.add('open');
    if (sheet) {
      sheet.classList.add('open');
      sheet.innerHTML = `
        <div class="sheet-header">
          <div class="sheet-preview-wrap"><div class="sheet-preview"></div></div>
          <div class="sheet-header-info">
            <div class="sheet-tmpl-name">Browser Clean</div>
            <div class="sheet-subtitle">Minimalista · Fundo escuro</div>
          </div>
          <button class="sheet-close">×</button>
        </div>
        <div class="sheet-section-title">Modo</div>
        <div class="sheet-mode-cards">
          <div class="sheet-mode-card sel"><div class="smc-icon">◎</div><div><div class="smc-title">Desktop + Mobile</div><div class="smc-sub">2 arquivos por página</div></div><div class="smc-chk">✓</div></div>
          <div class="sheet-mode-card"><div class="smc-icon">◇</div><div><div class="smc-title">Apenas Desktop</div><div class="smc-sub">1 arquivo por página</div></div><div class="smc-chk">✓</div></div>
        </div>
        <div class="sheet-footer">
          <button class="sheet-btn-cancel">Cancelar</button>
          <button class="sheet-btn-apply">Aplicar template</button>
        </div>`;
    }
  });
  await new Promise(r => setTimeout(r, 500));
  await shotViewport(page, '09-s4-template-sheet');
  await page.evaluate(() => {
    const overlay = document.getElementById('tmpl-sheet-overlay');
    if (overlay) { overlay.classList.remove('open'); overlay.style.display = 'none'; }
    const sheet   = document.getElementById('tmpl-sheet');
    if (sheet) { sheet.classList.remove('open'); sheet.style.display = 'none'; }
  });
  await new Promise(r => setTimeout(r, 350));

  // ═══ S5: CAPTURE PROGRESS ═══════════════════════════════════════════════
  console.log('\n── Section S5: Capture progress ──');
  await page.evaluate(() => {
    document.querySelectorAll('.s').forEach(el => { el.classList.remove('in','vis'); });
    const s5 = document.getElementById('s5'); if (s5) { s5.classList.add('in','vis'); }
    const total = document.getElementById('prog-total'); if (total) total.textContent = '8';
    const done  = document.getElementById('prog-done');  if (done)  done.textContent  = '3';
    const fill  = document.getElementById('prog-fill');  if (fill)  fill.style.width  = '37%';
    const curr  = document.getElementById('prog-curr');  if (curr)  curr.textContent  = 'Capturando: /pricing · desktop';
    const gal   = document.getElementById('cap-gallery');
    if (gal) {
      gal.innerHTML = '';
      for (let i=0;i<3;i++) {
        const div = document.createElement('div');
        div.style.cssText = 'aspect-ratio:16/10;background:#1a1a1a;border-radius:8px;border:1px solid rgba(255,255,255,0.08);';
        gal.appendChild(div);
      }
    }
  });
  await scrollTop(page);
  await shotViewport(page,'10-s5-capture-progress');

  // ═══ S6: DOWNLOAD ═══════════════════════════════════════════════════════
  console.log('\n── Section S6: Download ──');
  await page.evaluate(() => {
    document.querySelectorAll('.s').forEach(el => { el.classList.remove('in','vis'); });
    const s6 = document.getElementById('s6'); if (s6) { s6.classList.add('in','vis'); }
    const notice = document.getElementById('s6-free-notice'); if (notice) notice.style.display = 'flex';
  });
  await scrollTop(page);
  await shotViewport(page,'11-s6-download');

  // ═══ MODALS: Subscription → plans → checkout → PIX ══════════════════════
  console.log('\n── Modal: Subscription (plans) ──');
  await page.evaluate(() => {
    const m = document.getElementById('pkg-modal'); if (m) m.classList.add('on');
    ['pm-screen-1','pm-screen-2','pm-screen-3','pm-screen-4'].forEach(id => {
      const el = document.getElementById(id); if (el) el.classList.remove('active');
    });
    const s1 = document.getElementById('pm-screen-1'); if (s1) s1.classList.add('active');
  });
  await shotViewport(page,'12-modal-plans');

  console.log('\n── Modal: Checkout form (screen 2) ──');
  await page.evaluate(() => {
    ['pm-screen-1','pm-screen-2','pm-screen-3','pm-screen-4'].forEach(id => {
      const el = document.getElementById(id); if (el) el.classList.remove('active');
    });
    const s2 = document.getElementById('pm-screen-2'); if (s2) s2.classList.add('active');
  });
  await shotViewport(page,'13-modal-checkout');

  console.log('\n── Modal: PIX QR Code (screen 3) ──');
  await page.evaluate(() => {
    ['pm-screen-1','pm-screen-2','pm-screen-3','pm-screen-4'].forEach(id => {
      const el = document.getElementById(id); if (el) el.classList.remove('active');
    });
    const s3 = document.getElementById('pm-screen-3'); if (s3) s3.classList.add('active');
    // Inject a fake QR and price
    const amountEl = document.querySelector('.pix-amount'); if (amountEl) amountEl.textContent = 'R$ 19,90';
    const planEl   = document.querySelector('.pix-plan-name'); if (planEl) planEl.textContent = 'Plano Starter · mensal';
    const wrap     = document.querySelector('.pix-qr-wrap');
    if (wrap) {
      wrap.innerHTML = `<img alt="QR" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAAXNSR0IArs4c6QAAAVdJREFUeF7t1zFuAzEMRNH4/pdOY6SwU0hMwSIg8VuDyS5XRP8Y+/Nxjh/+HAMJOZEAISEJn0OIqiA=">`;
    }
    const code = document.querySelector('.pix-code-text'); if (code) code.textContent = '00020126580014BR.GOV.BCB.PIX0136a629532e-7693-4846-b028-f142a1dd5c5d5204000053039865406 19.9058fake-code-for-testing63041D4E';
  });
  await shotViewport(page,'14-modal-pix-qr');

  console.log('\n── Modal: Success (screen 4) ──');
  await page.evaluate(() => {
    ['pm-screen-1','pm-screen-2','pm-screen-3','pm-screen-4'].forEach(id => {
      const el = document.getElementById(id); if (el) el.classList.remove('active');
    });
    const s4 = document.getElementById('pm-screen-4'); if (s4) s4.classList.add('active');
    const code = document.getElementById('success-code'); if (code) code.textContent = 'SD-A3F9-B2K7';
  });
  await shotViewport(page,'15-modal-success');

  // Close subscription modal
  await page.evaluate(() => { const m = document.getElementById('pkg-modal'); if (m) m.classList.remove('on'); });

  // ═══ Modal: Plano (info) ═════════════════════════════════════════════════
  console.log('\n── Modal: Plano info ──');
  await page.evaluate(() => {
    const ov = document.getElementById('modal-plano-overlay'); if (ov) ov.style.display = 'block';
    const mp = document.getElementById('modal-plano'); if (mp) mp.style.display = 'block';
  });
  await shotViewport(page,'16-modal-plano');

  console.log('\n── Done ──');
  await browser.close();
}

main().catch(err => { console.error('ERROR:', err); process.exit(1); });
