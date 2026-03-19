'use strict';

const puppeteer = require('puppeteer');
const fs        = require('fs');

// ── Helpers ───────────────────────────────────────────────────────────────────
function dateStr() {
  return new Date().toLocaleDateString('pt-BR', { year: 'numeric', month: 'short', day: 'numeric' });
}
function domain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url.slice(0, 40); }
}
function b64(screenshotPath) {
  return fs.readFileSync(screenshotPath).toString('base64');
}
function wrap(body, W, H, bg, extra) {
  const hStyle = H ? `height:${H}px;` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}body{width:${W}px;${hStyle}${bg}${extra||''}}</style></head><body>${body}</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIA 1 — DEVICE FRAMES
// ═══════════════════════════════════════════════════════════════════════════════

// 1. VOID — monitor ultra-fino, sombra branca difusa, preto absoluto
function buildVoid(b64img, deviceType, cfg, url, title) {
  const isD = deviceType === 'desktop';
  const W   = isD ? 2400 : 1600;
  const sw  = isD ? 1960 : 480;
  const sh  = isD ? 1102 : 1040;
  const metaHtml = (cfg.showUrl||cfg.showDate) ? `<div style="margin-top:32px;display:flex;gap:10px;font-family:'Courier New',monospace;font-size:19px;color:rgba(255,255,255,0.35);">${cfg.showUrl?`<span>${url}</span>`:''} ${cfg.showDate?`<span>· ${dateStr()}</span>`:''}</div>` : '';

  const frame = isD ? `
    <div style="filter:drop-shadow(0 40px 100px rgba(255,255,255,0.05)) drop-shadow(0 16px 60px rgba(0,0,0,0.98));">
      <div style="background:linear-gradient(160deg,#1e1e1e 0%,#141414 55%,#0c0c0c 100%);border-radius:22px;padding:16px 16px 36px;border:1px solid rgba(255,255,255,0.08);">
        <div style="height:26px;display:flex;align-items:center;justify-content:center;">
          <div style="width:7px;height:7px;border-radius:50%;background:#111;border:1px solid rgba(255,255,255,0.08);"></div>
        </div>
        <div style="background:#000;border-radius:5px;overflow:hidden;width:${sw}px;height:${sh}px;">
          <img src="data:image/png;base64,${b64img}" style="width:100%;height:100%;object-fit:cover;display:block;">
        </div>
      </div>
      <div style="width:300px;height:20px;background:linear-gradient(180deg,#181818,#101010);border-radius:0 0 8px 8px;border:1px solid rgba(255,255,255,0.05);border-top:none;margin:0 auto;"></div>
      <div style="width:160px;height:9px;background:#0e0e0e;border-radius:5px;margin:3px auto 0;border:1px solid rgba(255,255,255,0.04);"></div>
    </div>` : `
    <div style="filter:drop-shadow(0 28px 70px rgba(255,255,255,0.04)) drop-shadow(0 12px 40px rgba(0,0,0,0.97));position:relative;">
      <div style="background:linear-gradient(145deg,#1d1d1d 0%,#141414 50%,#0d0d0d 100%);border-radius:50px;padding:13px;border:1.5px solid rgba(255,255,255,0.09);position:relative;width:${sw}px;">
        <div style="position:absolute;left:-5px;top:100px;width:4px;height:42px;background:#161616;border-radius:2px;border:1px solid rgba(255,255,255,0.05);"></div>
        <div style="position:absolute;left:-5px;top:153px;width:4px;height:42px;background:#161616;border-radius:2px;border:1px solid rgba(255,255,255,0.05);"></div>
        <div style="position:absolute;right:-5px;top:128px;width:4px;height:62px;background:#161616;border-radius:2px;border:1px solid rgba(255,255,255,0.05);"></div>
        <div style="background:#000;border-radius:38px;overflow:hidden;position:relative;aspect-ratio:390/844;">
          <div style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:128px;height:32px;background:#0c0c0c;border-radius:0 0 18px 18px;z-index:2;"></div>
          <img src="data:image/png;base64,${b64img}" style="width:100%;height:100%;object-fit:cover;display:block;">
        </div>
      </div>
    </div>`;

  return wrap(`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:140px;min-height:${isD?1600:2000}px;">${frame}${metaHtml}</div>`, W, 0, 'background:#0a0a0a;', '');
}

// 2. SLATE — smartphone premium sobre cinza escuro
function buildSlate(b64img, deviceType, cfg, url, title) {
  const isD = deviceType === 'desktop';
  const W   = isD ? 2400 : 1600;
  const sw  = isD ? 1960 : 480;
  const sh  = isD ? 1102 : 1040;
  const metaHtml = (cfg.showUrl||cfg.showDate) ? `<div style="margin-top:28px;font-family:'Courier New',monospace;font-size:19px;color:rgba(255,255,255,0.3);">${cfg.showUrl?url:''} ${cfg.showDate?'· '+dateStr():''}</div>` : '';

  const phoneFrame = `
    <div style="filter:drop-shadow(0 32px 72px rgba(0,0,0,0.92)) drop-shadow(0 8px 32px rgba(0,0,0,0.7));position:relative;">
      <div style="background:linear-gradient(150deg,#2a2a2a 0%,#1e1e1e 40%,#141414 100%);border-radius:54px;padding:14px;border:2px solid rgba(255,255,255,0.12);position:relative;width:508px;">
        <div style="position:absolute;left:-7px;top:110px;width:6px;height:48px;background:#222;border-radius:3px;border:1px solid rgba(255,255,255,0.07);"></div>
        <div style="position:absolute;left:-7px;top:170px;width:6px;height:80px;background:#222;border-radius:3px;border:1px solid rgba(255,255,255,0.07);"></div>
        <div style="position:absolute;right:-7px;top:148px;width:6px;height:72px;background:#222;border-radius:3px;border:1px solid rgba(255,255,255,0.07);"></div>
        <div style="background:#111;border-radius:42px;overflow:hidden;position:relative;aspect-ratio:390/844;">
          <div style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:140px;height:36px;background:#141414;border-radius:0 0 22px 22px;z-index:2;"></div>
          <div style="position:absolute;top:10px;right:28px;width:12px;height:12px;border-radius:50%;background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);z-index:3;"></div>
          <img src="data:image/png;base64,${b64img}" style="width:100%;height:100%;object-fit:cover;display:block;">
        </div>
      </div>
    </div>`;

  const desktopFrame = `
    <div style="filter:drop-shadow(0 40px 80px rgba(0,0,0,0.92)) drop-shadow(0 16px 48px rgba(0,0,0,0.7));">
      <div style="background:linear-gradient(160deg,#2a2a2a 0%,#1e1e1e 55%,#141414 100%);border-radius:22px;padding:16px 16px 36px;border:1.5px solid rgba(255,255,255,0.1);">
        <div style="height:28px;display:flex;align-items:center;padding:0 12px;gap:8px;">
          <div style="width:8px;height:8px;border-radius:50%;background:#ff5f57;"></div>
          <div style="width:8px;height:8px;border-radius:50%;background:#ffbd2e;"></div>
          <div style="width:8px;height:8px;border-radius:50%;background:#27c93f;"></div>
        </div>
        <div style="background:#0a0a0a;border-radius:5px;overflow:hidden;width:${sw}px;height:${sh}px;">
          <img src="data:image/png;base64,${b64img}" style="width:100%;height:100%;object-fit:cover;display:block;">
        </div>
      </div>
      <div style="width:300px;height:20px;background:#1e1e1e;border-radius:0 0 8px 8px;margin:0 auto;"></div>
      <div style="width:160px;height:9px;background:#181818;border-radius:5px;margin:3px auto 0;"></div>
    </div>`;

  const frame = isD ? desktopFrame : phoneFrame;
  return wrap(`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:140px;min-height:${isD?1600:2000}px;">${frame}${metaHtml}</div>`, W, 0, 'background:radial-gradient(ellipse at center,#181818 0%,#0e0e0e 60%,#080808 100%);', '');
}

// 3. DUO — desktop + mobile lado a lado numa composição panorâmica
function buildDuo(b64img, deviceType, cfg, url, title) {
  const W = 2800;
  const H = 1600;
  const desktopW = 1680;
  const desktopH = 945;
  const mobileW  = 340;
  const mobileH  = 736;
  const metaTxt  = (cfg.showUrl||cfg.showDate) ? `${cfg.showUrl?domain(url):''}${cfg.showDate?' · '+dateStr():''}` : '';
  return wrap(`
    <div style="display:flex;align-items:center;justify-content:center;gap:40px;height:${H}px;background:#0a0a0a;">
      <div style="filter:drop-shadow(0 40px 80px rgba(0,0,0,0.95));position:relative;">
        <div style="background:linear-gradient(160deg,#1e1e1e,#111);border-radius:18px;padding:14px 14px 32px;border:1px solid rgba(255,255,255,0.08);">
          <div style="height:22px;display:flex;align-items:center;padding:0 10px;gap:6px;">
            <div style="width:7px;height:7px;border-radius:50%;background:#ff5f57;"></div>
            <div style="width:7px;height:7px;border-radius:50%;background:#ffbd2e;"></div>
            <div style="width:7px;height:7px;border-radius:50%;background:#27c93f;"></div>
          </div>
          <div style="background:#000;border-radius:4px;overflow:hidden;width:${desktopW}px;height:${desktopH}px;">
            <img src="data:image/png;base64,${b64img}" style="width:100%;height:100%;object-fit:cover;display:block;">
          </div>
        </div>
        <div style="width:240px;height:16px;background:#181818;border-radius:0 0 6px 6px;margin:0 auto;"></div>
        <div style="width:120px;height:7px;background:#141414;border-radius:4px;margin:2px auto 0;"></div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
        <div style="filter:drop-shadow(0 28px 60px rgba(0,0,0,0.95));position:relative;">
          <div style="background:linear-gradient(145deg,#1e1e1e,#111);border-radius:42px;padding:11px;border:1.5px solid rgba(255,255,255,0.09);position:relative;width:${mobileW+22}px;">
            <div style="position:absolute;left:-5px;top:80px;width:4px;height:36px;background:#161616;border-radius:2px;"></div>
            <div style="position:absolute;left:-5px;top:126px;width:4px;height:36px;background:#161616;border-radius:2px;"></div>
            <div style="position:absolute;right:-5px;top:105px;width:4px;height:52px;background:#161616;border-radius:2px;"></div>
            <div style="background:#000;border-radius:32px;overflow:hidden;position:relative;width:${mobileW}px;height:${mobileH}px;">
              <div style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:100px;height:26px;background:#0a0a0a;border-radius:0 0 14px 14px;z-index:2;"></div>
              <img src="data:image/png;base64,${b64img}" style="width:100%;height:100%;object-fit:cover;display:block;">
            </div>
          </div>
        </div>
        ${metaTxt ? `<div style="font-family:'Courier New',monospace;font-size:16px;color:rgba(255,255,255,0.25);letter-spacing:0.04em;">${metaTxt}</div>` : ''}
      </div>
    </div>`, W, H, 'background:#0a0a0a;overflow:hidden;', '');
}

// 4. FLOAT — sem frame, sombra dramática e realista
function buildFloat(b64img, deviceType, cfg, url, title) {
  const isD = deviceType === 'desktop';
  const W   = isD ? 2400 : 1600;
  const sw  = isD ? 1760 : 540;
  const metaHtml = (cfg.showUrl||cfg.showDate) ? `<div style="margin-top:32px;font-family:'Courier New',monospace;font-size:19px;color:rgba(255,255,255,0.3);">${cfg.showUrl?url:''} ${cfg.showDate?'· '+dateStr():''}</div>` : '';
  return wrap(`
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:160px;min-height:${isD?1600:2000}px;">
      <div style="filter:drop-shadow(0 60px 80px rgba(0,0,0,0.97)) drop-shadow(24px 48px 80px rgba(0,0,0,0.8)) drop-shadow(-8px 16px 40px rgba(0,0,0,0.6));border-radius:10px;overflow:hidden;width:${sw}px;">
        <img src="data:image/png;base64,${b64img}" style="width:100%;display:block;">
      </div>
      ${metaHtml}
    </div>`, W, 0, 'background:radial-gradient(ellipse at center,#1c1c1c 0%,#0a0a0a 55%,#000 100%);', '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIA 2 — CONTEXTO PROFISSIONAL
// ═══════════════════════════════════════════════════════════════════════════════

// 5. CHROME — frame de browser macOS com precisão
function buildChrome(b64img, deviceType, cfg, url, title) {
  const isD = deviceType === 'desktop';
  const W   = isD ? 2400 : 1600;
  const sw  = isD ? 1840 : 580;
  const metaHtml = cfg.showDate ? `<div style="margin-top:24px;font-family:'Courier New',monospace;font-size:18px;color:rgba(255,255,255,0.2);">${dateStr()}</div>` : '';
  return wrap(`
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:160px;min-height:${isD?1600:2000}px;">
      <div style="width:${sw}px;border-radius:12px;overflow:hidden;filter:drop-shadow(0 32px 80px rgba(0,0,0,0.95)) drop-shadow(0 0 40px rgba(255,255,255,0.02));border:1px solid rgba(255,255,255,0.1);">
        <div style="background:#1e1e1e;height:52px;display:flex;align-items:center;padding:0 18px;border-bottom:1px solid rgba(255,255,255,0.07);">
          <div style="display:flex;gap:8px;margin-right:18px;">
            <div style="width:14px;height:14px;border-radius:50%;background:#ff5f57;"></div>
            <div style="width:14px;height:14px;border-radius:50%;background:#ffbd2e;"></div>
            <div style="width:14px;height:14px;border-radius:50%;background:#27c93f;"></div>
          </div>
          <div style="flex:1;background:rgba(0,0,0,0.4);border-radius:7px;height:30px;display:flex;align-items:center;padding:0 14px;max-width:60%;margin:0 auto;">
            <div style="width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.15);margin-right:8px;flex-shrink:0;"></div>
            <span style="font-family:'Courier New',monospace;font-size:13px;color:rgba(255,255,255,0.5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${url}</span>
          </div>
          <div style="display:flex;gap:4px;margin-left:18px;">
            <div style="width:22px;height:22px;border-radius:4px;background:rgba(255,255,255,0.05);"></div>
            <div style="width:22px;height:22px;border-radius:4px;background:rgba(255,255,255,0.05);"></div>
          </div>
        </div>
        <div style="position:relative;overflow:hidden;">
          <img src="data:image/png;base64,${b64img}" style="width:100%;display:block;">
        </div>
      </div>
      ${metaHtml}
    </div>`, W, 0, 'background:#111;', '');
}

// 6. PAPER — fundo branco, sombra suave e realista
function buildPaper(b64img, deviceType, cfg, url, title) {
  const isD = deviceType === 'desktop';
  const W   = isD ? 2400 : 1600;
  const sw  = isD ? 1960 : 480;
  const sh  = isD ? 1102 : 1040;
  const frame = isD ? `
    <div style="filter:drop-shadow(0 24px 64px rgba(0,0,0,0.18)) drop-shadow(0 8px 24px rgba(0,0,0,0.12));">
      <div style="background:linear-gradient(165deg,#f0f0f0,#e4e4e4);border-radius:22px;padding:16px 16px 36px;border:1px solid rgba(0,0,0,0.06);">
        <div style="height:26px;display:flex;align-items:center;justify-content:center;">
          <div style="width:7px;height:7px;border-radius:50%;background:#c8c8c8;"></div>
        </div>
        <div style="background:#fff;border-radius:5px;overflow:hidden;width:${sw}px;height:${sh}px;border:1px solid rgba(0,0,0,0.04);">
          <img src="data:image/png;base64,${b64img}" style="width:100%;height:100%;object-fit:cover;display:block;">
        </div>
      </div>
      <div style="width:280px;height:18px;background:linear-gradient(180deg,#e4e4e4,#d8d8d8);border-radius:0 0 7px 7px;margin:0 auto;"></div>
      <div style="width:140px;height:8px;background:#d0d0d0;border-radius:4px;margin:2px auto 0;"></div>
    </div>` : `
    <div style="filter:drop-shadow(0 20px 50px rgba(0,0,0,0.15)) drop-shadow(0 8px 24px rgba(0,0,0,0.1));position:relative;">
      <div style="background:linear-gradient(145deg,#f0f0f0,#e4e4e4);border-radius:52px;padding:14px;border:1.5px solid rgba(0,0,0,0.07);position:relative;width:${sw}px;">
        <div style="position:absolute;left:-5px;top:100px;width:4px;height:42px;background:#d4d4d4;border-radius:2px;"></div>
        <div style="position:absolute;left:-5px;top:153px;width:4px;height:42px;background:#d4d4d4;border-radius:2px;"></div>
        <div style="position:absolute;right:-5px;top:128px;width:4px;height:62px;background:#d4d4d4;border-radius:2px;"></div>
        <div style="background:#fff;border-radius:40px;overflow:hidden;position:relative;aspect-ratio:390/844;">
          <div style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:128px;height:32px;background:#e4e4e4;border-radius:0 0 18px 18px;z-index:2;"></div>
          <img src="data:image/png;base64,${b64img}" style="width:100%;height:100%;object-fit:cover;display:block;">
        </div>
      </div>
    </div>`;
  const metaHtml = (cfg.showUrl||cfg.showDate) ? `<div style="margin-top:28px;font-family:'Courier New',monospace;font-size:19px;color:rgba(0,0,0,0.35);">${cfg.showUrl?url:''} ${cfg.showDate?'· '+dateStr():''}</div>` : '';
  return wrap(`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:140px;min-height:${isD?1600:2000}px;">${frame}${metaHtml}</div>`, W, 0, 'background:#f8f8f8;', '');
}

// 7. ANNOTATION — screenshot com rodapé técnico de metadata
function buildAnnotation(b64img, deviceType, cfg, url, title) {
  const isD = deviceType === 'desktop';
  const W   = isD ? 2400 : 1600;
  const sw  = isD ? 1760 : 540;
  const dims = isD ? '1440 × 900 px · @2x · DESKTOP' : '390 × 844 px · @3x · MOBILE';
  const gridSvg = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Cpath d='M 64 0 L 0 0 0 64' fill='none' stroke='rgba(255,255,255,0.035)' stroke-width='1'/%3E%3C/svg%3E")`;
  const meta = [dims, cfg.showUrl?url:'', cfg.showDate?dateStr():''].filter(Boolean).join('  ·  ');
  return wrap(`
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:140px;min-height:${isD?1600:2000}px;background-image:${gridSvg};background-size:64px 64px;">
      <div style="font-family:'Courier New',monospace;font-size:18px;color:rgba(255,255,255,0.3);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:18px;">${title||domain(url)}</div>
      <div style="border:1px solid rgba(255,255,255,0.2);border-radius:4px;overflow:hidden;position:relative;width:${sw}px;">
        <img src="data:image/png;base64,${b64img}" style="width:100%;display:block;">
        <div style="position:absolute;top:14px;left:14px;background:rgba(0,0,0,0.7);border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:7px 13px;font-family:'Courier New',monospace;font-size:17px;color:rgba(255,255,255,0.65);letter-spacing:0.05em;">${dims}</div>
      </div>
      <div style="width:${sw}px;background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.1);border-top:none;border-radius:0 0 4px 4px;padding:14px 18px;font-family:'Courier New',monospace;font-size:17px;color:rgba(255,255,255,0.4);letter-spacing:0.04em;">${meta}</div>
    </div>`, W, 0, 'background:#080d18;', '');
}

// 8. GRID — 4 quadrantes mostrando escalas diferentes da mesma página
function buildGrid(b64img, deviceType, cfg, url, title) {
  const isD = deviceType === 'desktop';
  const W   = isD ? 2400 : 1600;
  const H   = isD ? 2400 : 1600;
  const cellW = (W - 120) / 2;
  const cellH = (H - 160) / 2;
  const scales = ['100%','75%','50%','25%'];
  const label = (scale) => `<div style="position:absolute;bottom:12px;left:12px;font-family:'Courier New',monospace;font-size:16px;color:rgba(255,255,255,0.5);background:rgba(0,0,0,0.7);border:1px solid rgba(255,255,255,0.12);border-radius:4px;padding:5px 12px;letter-spacing:0.04em;">${scale}</div>`;
  const cell = (scale, i) => `
    <div style="position:relative;width:${cellW}px;height:${cellH}px;overflow:hidden;background:#111;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
      <img src="data:image/png;base64,${b64img}" style="width:${scale};display:block;transform-origin:top left;">
      ${label(scale)}
    </div>`;
  const metaHtml = (cfg.showUrl||cfg.showDate) ? `<div style="font-family:'Courier New',monospace;font-size:18px;color:rgba(255,255,255,0.25);margin-top:24px;">${cfg.showUrl?url:''} ${cfg.showDate?'· '+dateStr():''}</div>` : '';
  return wrap(`
    <div style="display:flex;flex-direction:column;align-items:center;padding:60px;gap:0;">
      <div style="font-family:'Courier New',monospace;font-size:18px;color:rgba(255,255,255,0.3);margin-bottom:24px;letter-spacing:0.06em;text-transform:uppercase;">${title||domain(url)} — Responsividade</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        ${scales.map((s,i) => cell(s,i)).join('')}
      </div>
      ${metaHtml}
    </div>`, W, H, 'background:#0a0a0a;overflow:hidden;', '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIA 3 — CRIATIVO E EDITORIAL
// ═══════════════════════════════════════════════════════════════════════════════

// 9. POSTER — inclinado, grain, tipografia editorial
function buildPoster(b64img, deviceType, cfg, url, title) {
  const isD  = deviceType === 'desktop';
  const W    = isD ? 2400 : 1600;
  const deg  = isD ? -2.5 : -3;
  const imgW = isD ? 1440 : 480;
  const grain = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E")`;
  return wrap(`
    <div style="display:flex;align-items:center;justify-content:center;gap:80px;padding:140px;min-height:${isD?1500:2000}px;background-image:${grain};background-size:200px 200px;font-family:Georgia,serif;">
      <div style="transform:rotate(${deg}deg);filter:drop-shadow(0 24px 48px rgba(0,0,0,0.8));border-radius:4px;overflow:hidden;flex-shrink:0;width:${imgW}px;">
        <img src="data:image/png;base64,${b64img}" style="width:100%;display:block;">
      </div>
      <div style="display:flex;flex-direction:column;gap:22px;max-width:420px;">
        <div style="font-size:13px;color:rgba(255,255,255,0.35);letter-spacing:0.12em;text-transform:uppercase;font-family:'Courier New',monospace;">${dateStr()}</div>
        <div style="font-size:50px;font-weight:700;color:rgba(255,255,255,0.92);line-height:1.1;letter-spacing:-0.02em;">${(title||url).slice(0,60)}</div>
        <div style="width:44px;height:3px;background:rgba(255,255,255,0.6);"></div>
        <div style="font-size:19px;color:rgba(255,255,255,0.4);font-family:'Courier New',monospace;word-break:break-all;">${url}</div>
        <div style="font-size:15px;color:rgba(255,255,255,0.2);letter-spacing:0.07em;font-family:'Courier New',monospace;margin-top:14px;">${isD?'DESKTOP EDITION':'MOBILE EDITION'}</div>
      </div>
    </div>`, W, 0, 'background:#181818;', '');
}

// 10. NEON — borda luminosa monocromática, preto absoluto
function buildNeon(b64img, deviceType, cfg, url, title) {
  const isD = deviceType === 'desktop';
  const W   = isD ? 2400 : 1600;
  const sw  = isD ? 1840 : 580;
  const metaHtml = (cfg.showUrl||cfg.showDate) ? `<div style="margin-top:24px;font-family:'Courier New',monospace;font-size:18px;color:rgba(255,255,255,0.2);letter-spacing:0.04em;">${cfg.showUrl?domain(url):''} ${cfg.showDate?'· '+dateStr():''}</div>` : '';
  return wrap(`
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:160px;min-height:${isD?1600:2000}px;">
      <div style="width:${sw}px;border-radius:10px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,0.12),0 0 40px rgba(255,255,255,0.04),0 0 80px rgba(255,255,255,0.02),0 40px 80px rgba(0,0,0,0.98);">
        <div style="background:#131313;height:46px;display:flex;align-items:center;padding:0 16px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;gap:7px;margin-right:16px;">
            <div style="width:12px;height:12px;border-radius:50%;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.06);"></div>
            <div style="width:12px;height:12px;border-radius:50%;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.06);"></div>
            <div style="width:12px;height:12px;border-radius:50%;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.06);"></div>
          </div>
          <div style="flex:1;background:rgba(255,255,255,0.04);border-radius:5px;height:26px;display:flex;align-items:center;padding:0 12px;max-width:55%;margin:0 auto;border:1px solid rgba(255,255,255,0.07);">
            <span style="font-family:'Courier New',monospace;font-size:12px;color:rgba(255,255,255,0.4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${url}</span>
          </div>
        </div>
        <img src="data:image/png;base64,${b64img}" style="width:100%;display:block;">
      </div>
      ${metaHtml}
    </div>`, W, 0, 'background:#000;', '');
}

// 11. CINEMATIC — ultrawide 21:9, sidebars com blur do próprio screenshot
function buildCinematic(b64img, deviceType, cfg, url, title) {
  const W       = 2520;
  const H       = 1080;
  const centerW = Math.round(H * 1440 / 900);
  const sideW   = Math.round((W - centerW) / 2);
  return wrap(`
    <div style="width:${W}px;height:${H}px;overflow:hidden;background:#000;display:flex;position:relative;">
      <div style="width:${sideW}px;height:${H}px;overflow:hidden;flex-shrink:0;">
        <img src="data:image/png;base64,${b64img}" style="width:${centerW}px;height:${H}px;object-fit:cover;filter:blur(32px) brightness(0.4);transform:translateX(-${centerW-sideW}px) scale(1.15);transform-origin:right center;">
      </div>
      <div style="width:${centerW}px;height:${H}px;flex-shrink:0;overflow:hidden;position:relative;z-index:2;">
        <img src="data:image/png;base64,${b64img}" style="width:100%;height:100%;object-fit:cover;display:block;">
        ${(cfg.showUrl||cfg.showDate)?`<div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.75));padding:28px 24px 18px;font-family:'Courier New',monospace;font-size:17px;color:rgba(255,255,255,0.65);">${cfg.showUrl?url:''} ${cfg.showDate?'· '+dateStr():''}</div>`:''}
      </div>
      <div style="width:${sideW}px;height:${H}px;overflow:hidden;flex-shrink:0;">
        <img src="data:image/png;base64,${b64img}" style="width:${centerW}px;height:${H}px;object-fit:cover;filter:blur(32px) brightness(0.4);transform:scale(1.15);transform-origin:left center;">
      </div>
    </div>`, W, H, 'background:#000;overflow:hidden;', '');
}

// 12. STORY — vertical 9:16 para Instagram/TikTok Stories
function buildStory(b64img, deviceType, cfg, url, title) {
  const W      = 1080;
  const H      = 1920;
  const imgW   = W - 80;
  const dmn    = domain(url);
  return wrap(`
    <div style="width:${W}px;height:${H}px;overflow:hidden;display:flex;flex-direction:column;justify-content:center;align-items:center;position:relative;">
      <div style="position:absolute;inset:0;">
        <img src="data:image/png;base64,${b64img}" style="width:100%;height:100%;object-fit:cover;filter:blur(42px) brightness(0.3);transform:scale(1.12);">
      </div>
      <div style="position:relative;z-index:2;width:${W}px;display:flex;flex-direction:column;align-items:center;padding:60px 40px;">
        <div style="font-family:'Courier New',monospace;font-size:28px;font-weight:700;color:rgba(255,255,255,0.85);letter-spacing:-0.01em;margin-bottom:32px;text-align:center;">${(title||dmn).slice(0,40)}</div>
        <div style="width:${imgW}px;border-radius:18px;overflow:hidden;box-shadow:0 32px 80px rgba(0,0,0,0.85);">
          <img src="data:image/png;base64,${b64img}" style="width:100%;display:block;">
        </div>
        <div style="margin-top:32px;font-family:'Courier New',monospace;font-size:20px;color:rgba(255,255,255,0.45);letter-spacing:0.04em;text-align:center;">${dmn}${cfg.showDate?' · '+dateStr():''}</div>
      </div>
    </div>`, W, H, 'background:#000;overflow:hidden;', '');
}

// ── Mapa de templates (+ aliases backward compat) ──────────────────────────────
const TEMPLATE_BUILDERS = {
  // Novos nomes canônicos
  void:       buildVoid,
  slate:      buildSlate,
  duo:        buildDuo,
  float:      buildFloat,
  chrome:     buildChrome,
  paper:      buildPaper,
  annotation: buildAnnotation,
  grid:       buildGrid,
  poster:     buildPoster,
  neon:       buildNeon,
  cinematic:  buildCinematic,
  story:      buildStory,
  // Aliases para backward compat
  obsidian:   buildVoid,
  studio:     buildFloat,
  terminal:   buildChrome,
  blueprint:  buildAnnotation,
  editorial:  buildPoster,
  ultrawide:  buildCinematic,
  polaroid:   buildPoster, // aproximação
};

// ── Dimensões de viewport por template ────────────────────────────────────────
function viewportFor(template, isDesktop) {
  if (template === 'cinematic' || template === 'ultrawide') return { w: 2520, h: 1080, full: false };
  if (template === 'story')       return { w: 1080, h: 1920, full: false };
  if (template === 'duo')         return { w: 2800, h: 1600, full: false };
  if (template === 'grid')        return { w: isDesktop ? 2400 : 1600, h: isDesktop ? 2400 : 1600, full: false };
  return { w: isDesktop ? 2400 : 1600, h: 1, full: true };
}

// ── Social export ─────────────────────────────────────────────────────────────
const SOCIAL_SIZES = {
  twitter:            { w: 1200, h: 628 },
  linkedin:           { w: 1200, h: 627 },
  'instagram-square': { w: 1080, h: 1080 },
  'instagram-story':  { w: 1080, h: 1920 },
  og:                 { w: 1200, h: 630 },
};

function buildSocialHtml(b64img, format, url, title) {
  const size   = SOCIAL_SIZES[format];
  if (!size) throw new Error(`Formato desconhecido: ${format}`);
  const { w, h } = size;
  const dmn    = domain(url);

  if (format === 'instagram-story') {
    return wrap(`
      <div style="width:${w}px;height:${h}px;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;">
        <div style="position:absolute;inset:0;"><img src="data:image/png;base64,${b64img}" style="width:100%;height:100%;object-fit:cover;filter:blur(40px) brightness(0.3);transform:scale(1.1);"></div>
        <div style="position:relative;z-index:2;width:${w-80}px;border-radius:16px;overflow:hidden;box-shadow:0 32px 80px rgba(0,0,0,0.8);">
          <img src="data:image/png;base64,${b64img}" style="width:100%;display:block;">
        </div>
        <div style="position:absolute;bottom:80px;left:0;right:0;text-align:center;z-index:3;font-family:'Courier New',monospace;font-size:22px;color:rgba(255,255,255,0.65);letter-spacing:0.06em;">${dmn}</div>
      </div>`, w, h, 'background:#000;overflow:hidden;', '');
  }

  const imgH = Math.round(w * 900 / 1440);
  const topBar = Math.max(h - imgH, 60);
  return wrap(`
    <div style="width:${w}px;height:${h}px;overflow:hidden;background:#080808;display:flex;flex-direction:column;">
      <div style="height:${topBar}px;display:flex;align-items:center;justify-content:space-between;padding:0 36px;">
        <div style="font-family:'Courier New',monospace;font-size:20px;font-weight:700;color:rgba(255,255,255,0.88);">${(title||dmn).slice(0,45)}</div>
        <div style="font-family:'Courier New',monospace;font-size:15px;color:rgba(255,255,255,0.3);">${dmn}</div>
      </div>
      <div style="overflow:hidden;flex-shrink:0;${format==='instagram-square'?`height:${h-topBar}px;`:''}">
        <img src="data:image/png;base64,${b64img}" style="width:100%;display:block;${format==='instagram-square'?`height:${h-topBar}px;object-fit:cover;`:''}">
      </div>
    </div>`, w, h, 'background:#080808;overflow:hidden;', '');
}

// ── Comparison ────────────────────────────────────────────────────────────────
function buildComparisonHtml(b64_1, b64_2, url1, url2) {
  const W    = 2880, H = 1620;
  const half = (W - 4) / 2;
  const lbl1 = domain(url1);
  const lbl2 = domain(url2);
  return wrap(`
    <div style="width:${W}px;height:${H}px;background:#080808;display:flex;overflow:hidden;position:relative;">
      <div style="width:${half}px;height:${H}px;overflow:hidden;flex-shrink:0;position:relative;">
        <img src="data:image/png;base64,${b64_1}" style="width:100%;height:100%;object-fit:cover;display:block;">
        <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.75));padding:22px 26px 18px;font-family:'Courier New',monospace;font-size:20px;color:rgba(255,255,255,0.85);">${lbl1}</div>
      </div>
      <div style="width:4px;height:${H}px;background:rgba(255,255,255,0.25);flex-shrink:0;position:relative;z-index:10;">
        <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#000;border:1.5px solid rgba(255,255,255,0.3);border-radius:4px;padding:10px 18px;font-family:'Courier New',monospace;font-size:24px;font-weight:900;color:rgba(255,255,255,0.8);white-space:nowrap;letter-spacing:0.05em;">VS</div>
      </div>
      <div style="width:${half}px;height:${H}px;overflow:hidden;flex-shrink:0;position:relative;">
        <img src="data:image/png;base64,${b64_2}" style="width:100%;height:100%;object-fit:cover;display:block;">
        <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.75));padding:22px 26px 18px;font-family:'Courier New',monospace;font-size:20px;color:rgba(255,255,255,0.85);">${lbl2}</div>
      </div>
    </div>`, W, H, 'background:#080808;overflow:hidden;', '');
}

// ── Puppeteer render ──────────────────────────────────────────────────────────
async function puppeteerRender(html, outputPath, viewportW, viewportH, dpr, fullPage) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: viewportW, height: viewportH || 1, deviceScaleFactor: dpr || 2 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: outputPath, fullPage: fullPage !== false });
    await page.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
async function renderProfessional({ screenshotPath, deviceType, renderConfig, outputPath, pageUrl, pageTitle, applyWatermark }) {
  const cfg    = Object.assign({ template: 'void', showUrl: true, showDate: true }, renderConfig || {});
  const build  = TEMPLATE_BUILDERS[cfg.template] || buildVoid;
  const b64img = b64(screenshotPath);
  let   html   = build(b64img, deviceType, cfg, pageUrl || '', pageTitle || '');
  if (applyWatermark) {
    const wmOverlay = `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:9999;"><span style="font-family:monospace;font-size:72px;font-weight:900;color:rgba(255,255,255,0.35);letter-spacing:0.15em;transform:rotate(-30deg);white-space:nowrap;text-transform:uppercase;">SNAPSHOT.PRO</span></div>`;
    html = html.replace('</body>', wmOverlay + '</body>');
  }
  const isD    = deviceType === 'desktop';
  const vp     = viewportFor(cfg.template, isD);
  await puppeteerRender(html, outputPath, vp.w, vp.h, 2, vp.full);
  return outputPath;
}

async function renderSocialExport({ screenshotPath, format, outputPath, pageUrl, pageTitle }) {
  const size = SOCIAL_SIZES[format];
  if (!size) throw new Error(`Formato desconhecido: ${format}`);
  const b64img = b64(screenshotPath);
  const html   = buildSocialHtml(b64img, format, pageUrl || '', pageTitle || '');
  await puppeteerRender(html, outputPath, size.w, size.h, 1, false);
  return outputPath;
}

async function renderComparison({ screenshot1Path, screenshot2Path, outputPath, url1, url2 }) {
  const b64_1 = b64(screenshot1Path);
  const b64_2 = b64(screenshot2Path);
  const html  = buildComparisonHtml(b64_1, b64_2, url1, url2);
  await puppeteerRender(html, outputPath, 2880, 1620, 1, false);
  return outputPath;
}

module.exports = { renderProfessional, renderSocialExport, renderComparison };
