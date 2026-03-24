'use strict';

const fs   = require('fs');
const path = require('path');
const { getBrowserFromPool, releaseBrowserToPool } = require('./browser-pool');

// ── Section 1: Utilities ──────────────────────────────────────────────────────

function screenshotToBase64(filePath) {
  try {
    return 'data:image/png;base64,' + fs.readFileSync(filePath).toString('base64');
  } catch {
    // 1×1 transparent PNG fallback
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  }
}

function getWatermarkHtml(options) {
  if (!options || !options.applyWatermark) return '';
  // Enhanced "burned-in" watermark with multiple layers
  return `
<div style="position:absolute;inset:0;z-index:99999;pointer-events:none;overflow:hidden;user-select:none;display:flex;align-items:center;justify-content:center;">
  <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;opacity:0.04;">
    <defs>
      <pattern id="wmPattern" x="0" y="0" width="400" height="200" patternUnits="userSpaceOnUse">
        <text x="50%" y="50%" font-size="24" font-family="sans-serif" fill="white" transform="rotate(-25 200 100)" text-anchor="middle">SNAPSHOT.PRO</text>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#wmPattern)" />
  </svg>
  <div style="font-family:sans-serif;font-size:120px;font-weight:900;color:rgba(255,255,255,0.07);letter-spacing:0.1em;transform:rotate(-15deg);text-shadow:0 0 40px rgba(0,0,0,0.1);">SNAPSHOT.PRO</div>
  <div style="position:absolute;bottom:24px;right:28px;font-family:sans-serif;font-size:14px;font-weight:700;color:rgba(255,255,255,0.7);background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);">snapshot.pro</div>
</div>`;
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url || '').slice(0, 40); }
}

function getFormattedDate() {
  return new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── Section 2: 12 Template Renderers ─────────────────────────────────────────

const templateRenderers = {

  'void': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const cfg = options.renderConfig || {};
    const showMockup = cfg.showMockup !== false;
    const style = showMockup
      ? 'border-radius:6px;box-shadow:0 0 80px rgba(255,255,255,0.05),0 40px 120px rgba(0,0,0,0.98),0 8px 32px rgba(0,0,0,0.9);'
      : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#000000;position:relative;}</style></head><body>
<img src="${img}" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:1840px;height:1150px;object-fit:cover;object-position:top center;display:block;${style}">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  'chrome': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    const cfg = options.renderConfig || {};
    const showMockup = cfg.showMockup !== false;
    const shadow = showMockup ? 'box-shadow:0 32px 100px rgba(0,0,0,0.8),0 8px 24px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.06);' : '';
    const radius = showMockup ? 'border-radius:14px;' : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1720px;overflow:hidden;background:#0a0a0a;position:relative;}</style></head><body>
<div style="position:absolute;top:70px;left:100px;right:100px;bottom:70px;background:#0d0d0d;${radius}display:flex;flex-direction:column;overflow:hidden;${shadow}">
  <div style="height:48px;background:#1c1c1e;display:flex;align-items:center;padding:0 20px;flex-shrink:0;">
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="width:13px;height:13px;border-radius:50%;background:#ff5f57;"></div>
      <div style="width:13px;height:13px;border-radius:50%;background:#febc2e;"></div>
      <div style="width:13px;height:13px;border-radius:50%;background:#28c840;"></div>
    </div>
    <div style="flex:1;display:flex;align-items:center;justify-content:center;">
      <div style="background:#2c2c2e;width:340px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:rgba(255,255,255,0.45);">${dom}</div>
    </div>
    <div style="width:100px;"></div>
  </div>
  <div style="flex:1;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1720, deviceScaleFactor: 2 } };
  },

  'float': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const cfg = options.renderConfig || {};
    const showMockup = cfg.showMockup !== false;
    const radius = showMockup ? 'border-radius:10px;' : '';
    const shadow = showMockup ? 'box-shadow:0 4px 8px rgba(0,0,0,0.3),0 16px 40px rgba(0,0,0,0.55),0 40px 100px rgba(0,0,0,0.7),0 80px 160px rgba(0,0,0,0.45);' : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:linear-gradient(160deg,#1a1a2e 0%,#0e0e1a 40%,#0a0a14 100%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:1880px;height:1175px;object-fit:cover;object-position:top center;${radius}${shadow}display:block;">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  'macbook': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const cfg = options.renderConfig || {};
    const showMockup = cfg.showMockup !== false;
    const shadow = showMockup ? 'box-shadow:inset 0 0 0 2px #333,0 0 0 1px #111,0 40px 120px rgba(0,0,0,0.9);' : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1700px;overflow:hidden;background:#0a0a0a;position:relative;}</style></head><body>
<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;">
  <div style="width:1760px;background:#1e1e1e;border-radius:20px 20px 0 0;border:10px solid #2a2a2a;${shadow}">
    <div style="height:28px;background:#1e1e1e;display:flex;align-items:center;justify-content:center;">
      <div style="width:8px;height:8px;border-radius:50%;background:#3a3a3a;"></div>
    </div>
    <div style="height:1040px;overflow:hidden;">
      <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
    </div>
  </div>
  <div style="width:1920px;height:22px;background:linear-gradient(180deg,#2c2c2c,#1e1e1e);border-radius:0 0 6px 6px;"></div>
  <div style="width:380px;height:18px;background:linear-gradient(180deg,#262626,#1a1a1a);border-radius:0 0 16px 16px;"></div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1700, deviceScaleFactor: 2 } };
  },

  'iphone-pro': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const cfg = options.renderConfig || {};
    const showMockup = cfg.showMockup !== false;
    const shadow = showMockup ? 'box-shadow:0 0 0 1px #111,0 40px 100px rgba(0,0,0,0.95),inset 0 0 0 1px rgba(255,255,255,0.06);' : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1900px;overflow:hidden;background:#050505;position:relative;}</style></head><body>
<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:680px;height:1480px;background:linear-gradient(145deg,#2c2c2e,#1c1c1e,#161618);border-radius:56px;border:10px solid #3a3a3a;${shadow}">
  <div style="position:absolute;inset:0;border-radius:46px;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
  <div style="position:absolute;top:14px;left:50%;transform:translateX(-50%);width:144px;height:38px;background:#000;border-radius:22px;z-index:10;"></div>
  <div style="position:absolute;left:-14px;top:180px;width:4px;height:72px;background:#3a3a3a;border-radius:2px;"></div>
  <div style="position:absolute;left:-14px;top:270px;width:4px;height:72px;background:#3a3a3a;border-radius:2px;"></div>
  <div style="position:absolute;right:-14px;top:220px;width:4px;height:96px;background:#3a3a3a;border-radius:2px;"></div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 900, height: 1900, deviceScaleFactor: 2 } };
  },

  'browser-dark': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    const cfg = options.renderConfig || {};
    const showMockup = cfg.showMockup !== false;
    const radius = showMockup ? 'border-radius:14px;' : '';
    const shadow = showMockup ? 'box-shadow:0 32px 100px rgba(0,0,0,0.9),0 8px 24px rgba(0,0,0,0.7),0 0 0 1px rgba(255,255,255,0.04),0 0 80px rgba(99,102,241,0.04);' : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1720px;overflow:hidden;background:#060606;position:relative;}</style></head><body>
<div style="position:absolute;top:70px;left:100px;right:100px;bottom:70px;background:#111111;${radius}display:flex;flex-direction:column;overflow:hidden;${shadow}">
  <div style="height:48px;background:#111111;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;padding:0 20px;flex-shrink:0;">
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="width:13px;height:13px;border-radius:50%;background:rgba(255,255,255,0.18);"></div>
      <div style="width:13px;height:13px;border-radius:50%;background:rgba(255,255,255,0.18);"></div>
      <div style="width:13px;height:13px;border-radius:50%;background:rgba(255,255,255,0.18);"></div>
    </div>
    <div style="flex:1;display:flex;align-items:center;justify-content:center;">
      <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.07);width:340px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:rgba(255,255,255,0.3);">${dom}</div>
    </div>
    <div style="width:100px;"></div>
  </div>
  <div style="flex:1;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1720, deviceScaleFactor: 2 } };
  },

  'terminal': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    const cfg = options.renderConfig || {};
    const showMockup = cfg.showMockup !== false;
    const radius = showMockup ? 'border-radius:12px;' : '';
    const shadow = showMockup ? 'box-shadow:0 32px 100px rgba(0,0,0,0.95),0 0 0 1px rgba(255,255,255,0.05);' : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1720px;overflow:hidden;background:#000000;position:relative;}</style></head><body>
<div style="position:absolute;top:100px;left:100px;right:100px;bottom:80px;background:#1c1c1e;${radius}display:flex;flex-direction:column;overflow:hidden;${shadow}">
  <div style="height:44px;background:#2a2a2c;display:flex;align-items:center;padding:0 20px;flex-shrink:0;">
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="width:13px;height:13px;border-radius:50%;background:#ff5f57;"></div>
      <div style="width:13px;height:13px;border-radius:50%;background:#febc2e;"></div>
      <div style="width:13px;height:13px;border-radius:50%;background:#28c840;"></div>
    </div>
    <div style="flex:1;display:flex;align-items:center;justify-content:center;font-family:'Courier New',Courier,monospace;font-size:14px;color:rgba(255,255,255,0.4);">zsh</div>
    <div style="width:80px;"></div>
  </div>
  <div style="padding:14px 24px;font-family:'Courier New',Courier,monospace;font-size:14px;color:#00ff41;flex-shrink:0;">$ snapshot capture --url=${dom}</div>
  <div style="flex:1;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
  <div style="width:10px;height:20px;background:rgba(0,255,65,0.8);margin:12px 24px;flex-shrink:0;"></div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1720, deviceScaleFactor: 2 } };
  },

  'paper': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const cfg = options.renderConfig || {};
    const showMockup = cfg.showMockup !== false;
    const radius = showMockup ? 'border-radius:6px;' : '';
    const shadow = showMockup ? 'box-shadow:0 2px 4px rgba(0,0,0,0.03),0 8px 24px rgba(0,0,0,0.07),0 24px 64px rgba(0,0,0,0.09),0 48px 120px rgba(0,0,0,0.05);' : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1800px;overflow:hidden;background:#ede8e0;position:relative;}</style></head><body>
<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:1960px;height:1480px;background:#ffffff;${radius}overflow:hidden;${shadow}">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1800, deviceScaleFactor: 2 } };
  },

  // ── 9. PRESENTATION-SLIDE ────────────────────────────────────────────────────
  'presentation-slide': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    const url = (options && options.pageUrl) || '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1920px;height:1080px;overflow:hidden;background:#ffffff;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;}</style></head><body>
<img src="${img}" style="position:absolute;right:0;top:0;width:960px;height:1080px;object-fit:cover;object-position:top center;display:block;">
<div style="position:absolute;left:960px;top:0;width:3px;height:100%;background:#1a1a1a;"></div>
<div style="position:absolute;top:36px;left:60px;font-weight:900;font-size:180px;color:rgba(0,0,0,0.035);line-height:1;">01</div>
<div style="position:absolute;left:60px;top:50%;transform:translateY(-50%);width:820px;">
  <div style="font-size:52px;font-weight:800;color:#1a1a1a;line-height:1.1;word-break:break-word;">${dom}</div>
  <div style="font-size:16px;color:#888888;margin-top:16px;word-break:break-all;">${url}</div>
</div>
<div style="position:absolute;bottom:40px;left:80px;font-size:15px;color:#cccccc;">01 / 01</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1920, height: 1080, deviceScaleFactor: 2 } };
  },

  // ── 10. CINEMATIC ────────────────────────────────────────────────────────────
  'cinematic': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2520px;height:1080px;overflow:hidden;background:#000000;position:relative;}</style></head><body>
<img src="${img}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
<div style="position:absolute;top:0;left:0;width:100%;height:136px;background:#000000;z-index:2;"></div>
<div style="position:absolute;bottom:0;left:0;width:100%;height:136px;background:#000000;z-index:2;display:flex;align-items:center;justify-content:center;">
  <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;font-size:16px;font-weight:300;letter-spacing:0.45em;text-transform:uppercase;color:rgba(255,255,255,0.5);">${dom}</span>
</div>
<div style="position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,0.6) 100%);z-index:1;pointer-events:none;"></div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2520, height: 1080, deviceScaleFactor: 2 } };
  },

  // ── 11. GRADIENT-MESH ────────────────────────────────────────────────────────
  'gradient-mesh': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#0a0a0a;background-image:radial-gradient(ellipse at 0% 0%,rgba(26,5,51,0.92) 0%,transparent 55%),radial-gradient(ellipse at 100% 0%,rgba(0,26,51,0.92) 0%,transparent 55%),radial-gradient(ellipse at 0% 100%,rgba(26,51,0,0.85) 0%,transparent 55%),radial-gradient(ellipse at 100% 100%,rgba(51,0,21,0.85) 0%,transparent 55%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:1920px;height:1200px;object-fit:cover;object-position:top center;border-radius:16px;box-shadow:0 32px 100px rgba(0,0,0,0.6),0 8px 24px rgba(0,0,0,0.4),0 0 0 1px rgba(255,255,255,0.04);display:block;">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // ── 13. ANNOTATION ───────────────────────────────────────────────────────────
  'annotation': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#0a0a0a;position:relative;}</style></head><body>
<img src="${img}" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:1920px;height:1280px;object-fit:cover;object-position:top center;border-radius:8px;box-shadow:0 24px 80px rgba(0,0,0,0.7),0 0 0 1px rgba(255,255,255,0.06);display:block;">
<!-- Annotation 1: top-left area -->
<svg style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;" xmlns="http://www.w3.org/2000/svg">
  <circle cx="580" cy="360" r="54" fill="none" stroke="#ff3b30" stroke-width="4" opacity="0.9"/>
  <line x1="623" y1="403" x2="710" y2="490" stroke="#ff3b30" stroke-width="3" stroke-linecap="round"/>
  <circle cx="710" cy="490" r="8" fill="#ff3b30"/>
  <circle cx="1640" cy="720" r="42" fill="none" stroke="#ff3b30" stroke-width="4" opacity="0.9"/>
  <line x1="1600" y1="688" x2="1510" y2="610" stroke="#ff3b30" stroke-width="3" stroke-linecap="round"/>
  <circle cx="1510" cy="610" r="8" fill="#ff3b30"/>
  <circle cx="920" cy="940" r="36" fill="none" stroke="#ff9500" stroke-width="4" opacity="0.85"/>
  <line x1="950" y1="966" x2="1050" y2="1040" stroke="#ff9500" stroke-width="3" stroke-linecap="round"/>
  <circle cx="1050" cy="1040" r="8" fill="#ff9500"/>
</svg>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // ── 14. DUO-SPLIT ────────────────────────────────────────────────────────────
  'duo-split': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    // Left panel: wide desktop crop. Right panel: narrow mobile-crop of same screenshot.
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2800px;height:1600px;overflow:hidden;background:#0a0a0a;display:flex;align-items:center;justify-content:center;gap:32px;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
  <div style="width:1760px;height:1240px;border-radius:10px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,0.8),0 0 0 1px rgba(255,255,255,0.06);">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
  <span style="font-size:13px;color:rgba(255,255,255,0.28);letter-spacing:0.12em;text-transform:uppercase;">Desktop</span>
</div>
<div style="display:flex;flex-direction:column;align-items:center;gap:12px;align-self:flex-start;padding-top:40px;">
  <div style="width:380px;height:800px;border-radius:32px;overflow:hidden;background:#1c1c1e;border:8px solid #2a2a2a;box-shadow:0 24px 80px rgba(0,0,0,0.8),0 0 0 1px rgba(255,255,255,0.05);">
    <div style="height:20px;background:#1c1c1e;display:flex;align-items:center;justify-content:center;">
      <div style="width:72px;height:10px;background:#111;border-radius:6px;"></div>
    </div>
    <div style="height:760px;overflow:hidden;">
      <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top left;display:block;">
    </div>
  </div>
  <span style="font-size:13px;color:rgba(255,255,255,0.28);letter-spacing:0.12em;text-transform:uppercase;">Mobile</span>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2800, height: 1600, deviceScaleFactor: 2 } };
  },

  // ── 15. DEVICE-GLOW ──────────────────────────────────────────────────────────
  'device-glow': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const cfg = options.renderConfig || {};
    const showMockup = cfg.showMockup !== false;
    // Animated-style neon glow — indigo/violet hue
    const glowColor = showMockup ? 'rgba(99,102,241,0.55)' : 'transparent';
    const shadow = showMockup
      ? `box-shadow:0 0 0 1px rgba(99,102,241,0.3),0 0 40px 8px rgba(99,102,241,0.25),0 0 100px 20px rgba(99,102,241,0.12),0 40px 120px rgba(0,0,0,0.9);`
      : 'box-shadow:0 40px 120px rgba(0,0,0,0.9);';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#050508;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:1680px;height:1120px;border-radius:12px;background:${glowColor};filter:blur(60px);opacity:0.6;pointer-events:none;"></div>
<img src="${img}" style="position:relative;z-index:1;width:1840px;height:1200px;object-fit:cover;object-position:top center;border-radius:10px;${shadow}display:block;">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // ── 16. NEON ─────────────────────────────────────────────────────────────────
  'neon': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    const cfg = options.renderConfig || {};
    const showMockup = cfg.showMockup !== false;
    // Neon cyan/magenta corner brackets + glowing cyan border
    const shadow = showMockup
      ? 'box-shadow:0 0 0 2px rgba(0,255,255,0.45),0 0 24px 4px rgba(0,255,255,0.2),0 0 80px 16px rgba(0,255,255,0.08),0 40px 120px rgba(0,0,0,0.95);'
      : 'box-shadow:0 40px 120px rgba(0,0,0,0.95);';
    const cornerW = 60; // px of corner bracket arm
    const cornerT = 4;  // stroke-width
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#030305;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Screenshot -->
<img src="${img}" style="position:relative;z-index:1;width:1920px;height:1240px;object-fit:cover;object-position:top center;${shadow}display:block;">
<!-- SVG corner brackets -->
<svg style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:1960px;height:1280px;pointer-events:none;z-index:2;overflow:visible;" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="glowC"><feDropShadow dx="0" dy="0" stdDeviation="6" flood-color="#00ffff" flood-opacity="0.9"/></filter>
    <filter id="glowM"><feDropShadow dx="0" dy="0" stdDeviation="6" flood-color="#ff00ff" flood-opacity="0.9"/></filter>
  </defs>
  <!-- top-left cyan -->
  <polyline points="${cornerW},0 0,0 0,${cornerW}" fill="none" stroke="#00ffff" stroke-width="${cornerT}" filter="url(#glowC)"/>
  <!-- top-right cyan -->
  <polyline points="${1960 - cornerW},0 1960,0 1960,${cornerW}" fill="none" stroke="#00ffff" stroke-width="${cornerT}" filter="url(#glowC)"/>
  <!-- bottom-left magenta -->
  <polyline points="0,${1280 - cornerW} 0,1280 ${cornerW},1280" fill="none" stroke="#ff00ff" stroke-width="${cornerT}" filter="url(#glowM)"/>
  <!-- bottom-right magenta -->
  <polyline points="${1960 - cornerW},1280 1960,1280 1960,${1280 - cornerW}" fill="none" stroke="#ff00ff" stroke-width="${cornerT}" filter="url(#glowM)"/>
</svg>
<!-- domain label -->
<div style="position:absolute;bottom:60px;left:0;right:0;text-align:center;font-size:14px;font-weight:300;letter-spacing:0.5em;text-transform:uppercase;color:rgba(0,255,255,0.45);z-index:3;">${dom}</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // ── 12. NOIR ─────────────────────────────────────────────────────────────────
  'noir': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#000000;position:relative;}</style></head><body>
<svg style="display:none"><defs><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter></defs></svg>
<img src="${img}" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:2100px;height:1312px;object-fit:cover;object-position:top center;display:block;filter:grayscale(100%) contrast(1.4) brightness(0.88);">
<div style="position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 38%,rgba(0,0,0,0.9) 100%);pointer-events:none;"></div>
<div style="position:absolute;inset:0;filter:url(#grain);opacity:0.06;pointer-events:none;"></div>
<div style="position:absolute;bottom:70px;left:0;right:0;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;font-size:13px;font-weight:300;letter-spacing:0.45em;text-transform:uppercase;color:rgba(255,255,255,0.45);">${dom}</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

};

// ── Section 3: Main render function (returns Buffer) ─────────────────────────

// Legacy template IDs → new IDs
const LEGACY_MAP = {
  'browser':           'chrome',
  'browser-light':     'chrome',
  'iphone':            'iphone-pro',
  'iphone-15':         'iphone-pro',
  'macbook-pro':       'macbook',
  'presentation':      'presentation-slide',
  'slide':             'presentation-slide',
  'og-image':          'void',
  'twitter-card':      'void',
  'linkedin-banner':   'gradient-mesh',
  'instagram-post':    'gradient-mesh',
  'whatsapp-preview':  'float',
  'ocean':             'gradient-mesh',
  'duotone':           'gradient-mesh',
  'isometric':         'float',
  'diorama':           'float',
  'vaporwave':         'gradient-mesh',
  'filmstrip':         'cinematic',
  'ipad':              'macbook',
  'watch':             'iphone-pro',
  'magazine':          'paper',
  'report':            'paper',
};

async function renderTemplate(templateId, screenshotPath, deviceType, options) {
  options = options || {};
  const resolvedId = LEGACY_MAP[templateId] || templateId;
  const renderFn   = templateRenderers[resolvedId] || templateRenderers['void'];

  if (!fs.existsSync(screenshotPath)) {
    throw new Error(`Screenshot não encontrado: ${screenshotPath}`);
  }

  let entry = null;
  let page  = null;
  try {
    const { html, renderConfig } = await renderFn(screenshotPath, deviceType, options);
    const rc = renderConfig || { width: 2400, height: 1600, deviceScaleFactor: 2 };

    entry = await getBrowserFromPool();
    page  = await entry.browser.newPage();

    await page.setViewport({
      width:             rc.width,
      height:            rc.height,
      deviceScaleFactor: rc.deviceScaleFactor || 2,
    });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 600));

    const buffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: rc.width, height: rc.height },
    });
    return buffer;
  } finally {
    try { if (page)  await page.close();               } catch {}
    try { if (entry) await releaseBrowserToPool(entry); } catch {}
  }
}

// ── Section 4: Backward-compatible wrappers for screenshotter.js ──────────────

/**
 * Renders a template and writes the result to outputPath.
 * Called by screenshotter.js for each captured page.
 */
async function renderProfessional({ screenshotPath, deviceType, templateId, outputPath, pageUrl, pageTitle, applyWatermark }) {
  const options = { pageUrl, pageTitle, applyWatermark };
  const buffer  = await renderTemplate(templateId || 'void', screenshotPath, deviceType, options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

/**
 * Renders a template to a Buffer for social export variants.
 */
async function renderSocialExport({ screenshotPath, deviceType, templateId, pageUrl, pageTitle, applyWatermark }) {
  const options = { pageUrl, pageTitle, applyWatermark };
  return renderTemplate(templateId || 'void', screenshotPath, deviceType, options);
}

/**
 * Renders desktop + mobile side-by-side comparison image.
 */
async function renderComparison({ desktopPath, mobilePath, outputPath, pageUrl }) {
  const desktopB64 = screenshotToBase64(desktopPath);
  const mobileB64  = screenshotToBase64(mobilePath);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2800px;height:1600px;overflow:hidden;background:#0a0a0a;display:flex;align-items:center;justify-content:center;gap:40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="display:flex;flex-direction:column;align-items:center;gap:16px;">
  <img src="${desktopB64}" style="width:1920px;height:1200px;object-fit:cover;object-position:top center;border-radius:8px;box-shadow:0 24px 80px rgba(0,0,0,0.8);display:block;">
  <span style="font-size:14px;color:rgba(255,255,255,0.3);letter-spacing:0.1em;text-transform:uppercase;">Desktop</span>
</div>
<div style="display:flex;flex-direction:column;align-items:center;gap:16px;align-self:flex-start;padding-top:80px;">
  <img src="${mobileB64}" style="width:360px;height:760px;object-fit:cover;object-position:top center;border-radius:24px;box-shadow:0 24px 80px rgba(0,0,0,0.8);display:block;">
  <span style="font-size:14px;color:rgba(255,255,255,0.3);letter-spacing:0.1em;text-transform:uppercase;">Mobile</span>
</div>
</body></html>`;

  let entry = null;
  let page  = null;
  try {
    entry = await getBrowserFromPool();
    page  = await entry.browser.newPage();
    await page.setViewport({ width: 2800, height: 1600, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 600));
    const buffer = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 2800, height: 1600 } });
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, buffer);
      return outputPath;
    }
    return buffer;
  } finally {
    try { if (page)  await page.close();               } catch {}
    try { if (entry) await releaseBrowserToPool(entry); } catch {}
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  renderTemplate,
  renderProfessional,
  renderSocialExport,
  renderComparison,
  templateRenderers,
  screenshotToBase64,
  getDomain,
  getFormattedDate,
  getWatermarkHtml,
};
