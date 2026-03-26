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

// ── Section 2: 32 Template Renderers ─────────────────────────────────────────

const templateRenderers = {

  // ── FREE TEMPLATES ────────────────────────────────────────────────────────

  // 1. browser-clean — Minimal dark browser window
  'browser-clean': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#0f0f0f;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="width:2200px;height:1420px;background:#1a1a1a;border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,0.9),0 8px 32px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.05);">
  <div style="height:52px;background:#1a1a1a;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;padding:0 20px;flex-shrink:0;">
    <div style="display:flex;align-items:center;gap:9px;">
      <div style="width:12px;height:12px;border-radius:50%;background:#ff5f57;"></div>
      <div style="width:12px;height:12px;border-radius:50%;background:#febc2e;"></div>
      <div style="width:12px;height:12px;border-radius:50%;background:#28c840;"></div>
    </div>
    <div style="flex:1;display:flex;align-items:center;justify-content:center;">
      <div style="background:#272727;border:1px solid rgba(255,255,255,0.08);width:360px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:13px;color:rgba(255,255,255,0.4);">🔒 ${dom || 'exemplo.com'}</div>
    </div>
    <div style="width:120px;"></div>
  </div>
  <div style="flex:1;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 2. minimal-clean — Pure white/off-white
  'minimal-clean': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#f8f8f6;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:2240px;height:1400px;object-fit:cover;object-position:top center;display:block;box-shadow:0 4px 32px rgba(0,0,0,0.08),0 1px 3px rgba(0,0,0,0.04);">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 3. social-basic — Square social format
  'social-basic': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1200px;height:1200px;overflow:hidden;background:#ffffff;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="width:1152px;height:1152px;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:24px;background:#fff;">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;border-radius:4px;">
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1200, height: 1200, deviceScaleFactor: 2 } };
  },

  // 4. mobile-simple — Lightweight mobile frame
  'mobile-simple': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1900px;overflow:hidden;background:#1a1a2e;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="width:660px;height:1400px;background:#111;border:3px solid #333;border-radius:40px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 40px 100px rgba(0,0,0,0.8),0 0 0 1px rgba(255,255,255,0.04);">
  <div style="height:60px;background:#111;flex-shrink:0;display:flex;align-items:center;justify-content:center;">
    <div style="width:80px;height:8px;background:#222;border-radius:4px;"></div>
  </div>
  <div style="flex:1;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
  <div style="height:40px;background:#111;flex-shrink:0;display:flex;align-items:center;justify-content:center;">
    <div style="width:100px;height:6px;background:#222;border-radius:3px;"></div>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 900, height: 1900, deviceScaleFactor: 2 } };
  },

  // 5. gradient-basic — Soft gradient background
  'gradient-basic': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:2100px;height:1320px;object-fit:cover;object-position:top center;display:block;border:3px solid rgba(255,255,255,0.9);border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,0.3),0 8px 24px rgba(0,0,0,0.2);">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 6. default-dark — Premium black
  'default-dark': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#000000;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:2208px;height:1440px;object-fit:cover;object-position:top center;display:block;box-shadow:0 0 80px rgba(255,255,255,0.05),0 40px 120px rgba(0,0,0,1);">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // ── SOCIAL MEDIA TEMPLATES ────────────────────────────────────────────────

  // 7. instagram-post — Instagram post mock
  'instagram-post': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1200px;height:1400px;overflow:hidden;background:#fafafa;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="width:1080px;background:#fff;border:1px solid #dbdbdb;border-radius:4px;">
  <!-- Header -->
  <div style="display:flex;align-items:center;padding:14px 16px;gap:12px;">
    <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888);display:flex;align-items:center;justify-content:center;">
      <div style="width:36px;height:36px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;">
        <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(45deg,#833ab4,#fd1d1d,#fcb045);"></div>
      </div>
    </div>
    <div style="flex:1;">
      <div style="font-size:14px;font-weight:600;color:#262626;display:flex;align-items:center;gap:4px;">your_brand <svg width="12" height="12" viewBox="0 0 24 24" fill="#0095f6"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg></div>
      <div style="font-size:12px;color:#8e8e8e;">Patrocinado</div>
    </div>
    <div style="font-size:20px;color:#262626;letter-spacing:2px;cursor:pointer;">···</div>
  </div>
  <!-- Image -->
  <div style="width:100%;aspect-ratio:1;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
  <!-- Actions -->
  <div style="padding:12px 16px 4px;">
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:10px;">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#262626" stroke-width="2" stroke-linecap="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#262626" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#262626" stroke-width="2" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      <div style="flex:1;"></div>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#262626" stroke-width="2" stroke-linecap="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
    </div>
    <div style="font-size:14px;font-weight:600;color:#262626;margin-bottom:6px;">2.847 curtidas</div>
    <div style="font-size:14px;color:#262626;line-height:1.5;"><span style="font-weight:600;">your_brand</span> Confira nosso mais novo lançamento! Detalhes no link da bio. 🚀</div>
    <div style="font-size:14px;color:#8e8e8e;margin-top:4px;">Ver todos os 234 comentários</div>
    <div style="font-size:12px;color:#c7c7c7;margin-top:4px;text-transform:uppercase;letter-spacing:0.02em;">Há 2 horas</div>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1200, height: 1400, deviceScaleFactor: 2 } };
  },

  // 8. instagram-story — Instagram story
  'instagram-story': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1080px;height:1920px;overflow:hidden;background:#000;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<img src="${img}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
<!-- Top gradient -->
<div style="position:absolute;top:0;left:0;right:0;height:200px;background:linear-gradient(to bottom,rgba(0,0,0,0.6),transparent);z-index:2;"></div>
<!-- Bottom gradient -->
<div style="position:absolute;bottom:0;left:0;right:0;height:200px;background:linear-gradient(to top,rgba(0,0,0,0.7),transparent);z-index:2;"></div>
<!-- Progress bar -->
<div style="position:absolute;top:20px;left:16px;right:16px;display:flex;gap:4px;z-index:10;">
  <div style="flex:1;height:3px;background:rgba(255,255,255,0.9);border-radius:2px;"></div>
  <div style="flex:1;height:3px;background:rgba(255,255,255,0.35);border-radius:2px;"></div>
  <div style="flex:1;height:3px;background:rgba(255,255,255,0.35);border-radius:2px;"></div>
</div>
<!-- Story header -->
<div style="position:absolute;top:40px;left:16px;right:16px;display:flex;align-items:center;gap:12px;z-index:10;">
  <div style="width:44px;height:44px;border-radius:50%;border:2px solid #fff;background:linear-gradient(45deg,#833ab4,#fd1d1d,#fcb045);flex-shrink:0;"></div>
  <div>
    <div style="font-size:16px;font-weight:600;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.5);">your_brand</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.75);">Agora</div>
  </div>
  <div style="margin-left:auto;font-size:24px;color:#fff;line-height:1;">×</div>
</div>
<!-- Bottom reply -->
<div style="position:absolute;bottom:36px;left:16px;right:16px;z-index:10;display:flex;align-items:center;gap:12px;">
  <div style="flex:1;height:48px;border:1.5px solid rgba(255,255,255,0.5);border-radius:24px;display:flex;align-items:center;padding:0 20px;font-size:14px;color:rgba(255,255,255,0.7);">Enviar mensagem...</div>
  <div style="width:48px;height:48px;display:flex;align-items:center;justify-content:center;">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l7.84-7.84a5.5 5.5 0 0 0 0-7.78z"/></svg>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1080, height: 1920, deviceScaleFactor: 2 } };
  },

  // 9. twitter-post — X/Twitter tweet
  'twitter-post': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1200px;height:1000px;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="width:1100px;background:#000;border:1px solid #2f3336;border-radius:16px;padding:20px;">
  <!-- Author row -->
  <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:14px;">
    <div style="width:48px;height:48px;border-radius:50%;background:#333;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px;color:#fff;">Y</div>
    <div style="flex:1;">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <span style="font-size:16px;font-weight:700;color:#fff;">Your Brand</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="#1d9bf0"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91C2.88 9.33 2 10.57 2 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.33-2.19c1.4.46 2.91.2 3.92-.81s1.26-2.52.8-3.91c1.32-.67 2.2-1.91 2.2-3.34zm-6.61-4.44L10.5 13.5l-2.14-2.14a.75.75 0 10-1.06 1.06l2.67 2.67a.75.75 0 001.06 0l5.5-5.5a.75.75 0 10-1.06-1.06z"/></svg>
        <span style="font-size:15px;color:#71767b;">@yourbrand</span>
        <span style="font-size:15px;color:#71767b;">·</span>
        <span style="font-size:15px;color:#71767b;">2h</span>
      </div>
    </div>
    <div style="color:#71767b;font-size:20px;cursor:pointer;">···</div>
  </div>
  <!-- Tweet text -->
  <div style="font-size:17px;color:#fff;line-height:1.6;margin-bottom:16px;">Confira esse produto incrível que vai transformar o seu negócio 🚀 Link nos comentários!</div>
  <!-- Embedded media -->
  <div style="border-radius:12px;overflow:hidden;border:1px solid #2f3336;margin-bottom:16px;">
    <img src="${img}" style="width:100%;height:420px;object-fit:cover;object-position:top center;display:block;">
  </div>
  <!-- Engagement row -->
  <div style="display:flex;align-items:center;gap:32px;color:#71767b;font-size:14px;">
    <span style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>48
    </span>
    <span style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>127
    </span>
    <span style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>2.4K
    </span>
    <span style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>34.7K
    </span>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1200, height: 1000, deviceScaleFactor: 2 } };
  },

  // 10. linkedin-post — LinkedIn corporate
  'linkedin-post': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1200px;height:1100px;overflow:hidden;background:#f3f2ef;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="width:1080px;background:#fff;border-radius:8px;border:1px solid #e0e0e0;overflow:hidden;">
  <!-- Header -->
  <div style="padding:16px 16px 12px;display:flex;align-items:flex-start;gap:12px;">
    <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#0073b1,#00a0dc);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff;">Y</div>
    <div style="flex:1;">
      <div style="font-size:15px;font-weight:600;color:#000;display:flex;align-items:center;gap:6px;">Your Name <svg width="14" height="14" viewBox="0 0 24 24" fill="#0073b1"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg></div>
      <div style="font-size:13px;color:#666;">CEO at Company · 1.243 seguidores</div>
      <div style="font-size:12px;color:#666;display:flex;align-items:center;gap:4px;margin-top:2px;">1h · <svg width="12" height="12" viewBox="0 0 24 24" fill="#666"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg></div>
    </div>
    <div style="display:flex;gap:4px;color:#666;font-size:20px;cursor:pointer;">···</div>
  </div>
  <!-- Post text -->
  <div style="padding:0 16px 12px;font-size:15px;color:#000;line-height:1.6;">Excited to share our latest work! We've been building something incredible and I can't wait to show you the results. Check out this preview 👇 #innovation #tech #startup</div>
  <!-- Post image -->
  <div style="width:100%;overflow:hidden;">
    <img src="${img}" style="width:100%;height:480px;object-fit:cover;object-position:top center;display:block;">
  </div>
  <!-- Actions -->
  <div style="padding:4px 16px;border-top:1px solid #e0e0e0;display:flex;align-items:center;gap:4px;">
    <button style="flex:1;padding:12px 8px;background:none;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:600;color:#666;border-radius:4px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>Curtir
    </button>
    <button style="flex:1;padding:12px 8px;background:none;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:600;color:#666;border-radius:4px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Comentar
    </button>
    <button style="flex:1;padding:12px 8px;background:none;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:600;color:#666;border-radius:4px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>Repostar
    </button>
    <button style="flex:1;padding:12px 8px;background:none;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:600;color:#666;border-radius:4px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Enviar
    </button>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1200, height: 1100, deviceScaleFactor: 2 } };
  },

  // 11. whatsapp-share — WhatsApp message
  'whatsapp-share': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:#111b21;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- WhatsApp dot pattern bg -->
<div style="position:absolute;inset:0;opacity:0.06;background-image:radial-gradient(circle,rgba(255,255,255,0.3) 1px,transparent 1px);background-size:24px 24px;"></div>
<!-- Chat area -->
<div style="position:relative;z-index:1;padding:80px 24px 60px;display:flex;flex-direction:column;gap:16px;">
  <!-- Other person bubble -->
  <div style="max-width:75%;background:#202c33;border-radius:0 12px 12px 12px;padding:12px 14px;position:relative;">
    <div style="font-size:14px;color:#e9edef;">Oi! Você viu esse site? Acho que vai gostar 👀</div>
    <div style="font-size:11px;color:#8696a0;text-align:right;margin-top:4px;">14:30</div>
    <!-- Bubble tail -->
    <div style="position:absolute;top:0;left:-8px;width:0;height:0;border-top:8px solid #202c33;border-left:8px solid transparent;"></div>
  </div>
  <!-- My bubble with screenshot -->
  <div style="max-width:85%;align-self:flex-end;background:#005c4b;border-radius:12px 0 12px 12px;overflow:hidden;position:relative;">
    <img src="${img}" style="width:100%;max-height:400px;object-fit:cover;object-position:top center;display:block;">
    <div style="padding:10px 14px;display:flex;align-items:center;justify-content:flex-end;gap:6px;">
      <div style="font-size:11px;color:rgba(255,255,255,0.6);">14:32</div>
      <svg width="16" height="10" viewBox="0 0 16 10" fill="none"><path d="M1 5l3 3.5L10 1" stroke="#8696a0" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 5l3 3.5L15 1" stroke="#8696a0" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <!-- Bubble tail -->
    <div style="position:absolute;top:0;right:-8px;width:0;height:0;border-top:8px solid #005c4b;border-right:8px solid transparent;"></div>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
  },

  // 12. carousel-post — Carousel/swipeable
  'carousel-post': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1400px;height:1000px;overflow:hidden;background:#18181b;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="display:flex;align-items:center;gap:24px;position:relative;padding:0 80px;">
  <!-- Left nav -->
  <div style="position:absolute;left:16px;width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:10;">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
  </div>
  <!-- Left card -->
  <div style="flex-shrink:0;transform:rotate(-3deg) scale(0.8);filter:blur(1.5px);opacity:0.5;overflow:hidden;border-radius:12px;">
    <img src="${img}" style="width:600px;height:700px;object-fit:cover;object-position:top center;display:block;">
  </div>
  <!-- Center card (main) -->
  <div style="flex-shrink:0;border-radius:16px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,0.8),0 0 0 2px rgba(255,255,255,0.1);">
    <img src="${img}" style="width:760px;height:760px;object-fit:cover;object-position:top center;display:block;">
  </div>
  <!-- Right card -->
  <div style="flex-shrink:0;transform:rotate(3deg) scale(0.8);filter:blur(1.5px);opacity:0.5;overflow:hidden;border-radius:12px;">
    <img src="${img}" style="width:600px;height:700px;object-fit:cover;object-position:top center;display:block;">
  </div>
  <!-- Right nav -->
  <div style="position:absolute;right:16px;width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:10;">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
  </div>
</div>
<!-- Dots -->
<div style="display:flex;gap:8px;margin-top:28px;">
  <div style="width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.35);"></div>
  <div style="width:24px;height:8px;border-radius:4px;background:#fff;"></div>
  <div style="width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.35);"></div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1400, height: 1000, deviceScaleFactor: 2 } };
  },

  // 13. ad-style — Digital advertisement
  'ad-style': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1200px;height:1400px;overflow:hidden;background:#fff;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="width:100%;height:100%;display:flex;flex-direction:column;">
  <!-- Sponsored badge -->
  <div style="padding:12px 16px;display:flex;align-items:center;justify-content:space-between;">
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="width:40px;height:40px;background:#f0f0f0;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:#333;">M</div>
      <div>
        <div style="font-size:14px;font-weight:600;color:#1c1e21;">Nome da Marca</div>
        <div style="font-size:12px;color:#606770;">Patrocinado · <span>🌐</span></div>
      </div>
    </div>
    <div style="font-size:11px;font-weight:500;color:#606770;background:#f0f2f5;padding:4px 10px;border-radius:12px;">PATROCINADO</div>
  </div>
  <!-- Ad creative / screenshot -->
  <div style="flex:1;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
  <!-- CTA bar -->
  <div style="padding:14px 16px;border-top:1px solid #e4e6ea;display:flex;align-items:center;justify-content:space-between;gap:12px;">
    <div>
      <div style="font-size:13px;color:#606770;">${dom || 'seusite.com.br'}</div>
      <div style="font-size:15px;font-weight:700;color:#1c1e21;">Descubra tudo sobre nosso produto</div>
    </div>
    <button style="background:linear-gradient(135deg,#ff8c00,#ff6600);color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;">Saiba Mais →</button>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1200, height: 1400, deviceScaleFactor: 2 } };
  },

  // 14. viral-frame — Viral content frame
  'viral-frame': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#0a0a0a;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Corner accent lines -->
<div style="position:absolute;top:40px;left:40px;width:60px;height:60px;border-top:3px solid #ff0066;border-left:3px solid #ff0066;"></div>
<div style="position:absolute;top:40px;right:40px;width:60px;height:60px;border-top:3px solid #ff0066;border-right:3px solid #ff0066;"></div>
<div style="position:absolute;bottom:100px;left:40px;width:60px;height:60px;border-bottom:3px solid #ff0066;border-left:3px solid #ff0066;"></div>
<div style="position:absolute;bottom:100px;right:40px;width:60px;height:60px;border-bottom:3px solid #ff0066;border-right:3px solid #ff0066;"></div>
<img src="${img}" style="width:2200px;height:1360px;object-fit:cover;object-position:top center;display:block;box-shadow:0 0 20px rgba(255,0,102,0.2),0 0 60px rgba(255,0,102,0.1),0 40px 80px rgba(0,0,0,0.9);">
<div style="position:absolute;bottom:20px;left:0;right:0;text-align:center;font-size:60px;font-weight:900;color:#fff;letter-spacing:0.08em;text-shadow:0 0 30px rgba(255,0,102,0.5);">🔥 IMPERDÍVEL</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // ── PROFESSIONAL TEMPLATES ────────────────────────────────────────────────

  // 15. presentation-slide — 16:9 presentation slide
  'presentation-slide': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1920px;height:1080px;overflow:hidden;background:#1e1e2e;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Top label -->
<div style="position:absolute;top:32px;left:48px;display:flex;align-items:center;gap:10px;z-index:2;">
  <div style="width:8px;height:8px;border-radius:50%;background:#7c6cf5;"></div>
  <span style="font-size:12px;font-weight:500;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.4);">APRESENTAÇÃO</span>
</div>
<!-- Screenshot centered -->
<div style="position:absolute;top:5%;left:5%;right:5%;bottom:10%;overflow:hidden;border-radius:6px;">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
<!-- Bottom bar -->
<div style="position:absolute;bottom:0;left:0;right:0;height:48px;display:flex;align-items:center;padding:0 48px;justify-content:space-between;">
  <div style="height:1px;flex:1;background:rgba(255,255,255,0.1);margin-right:24px;"></div>
  <span style="font-size:11px;color:rgba(255,255,255,0.25);letter-spacing:0.05em;">slide 01</span>
  <div style="flex:1;"></div>
  <span style="font-size:11px;color:rgba(255,255,255,0.25);letter-spacing:0.05em;">Company Name</span>
  <div style="width:1px;height:12px;background:rgba(255,255,255,0.15);margin:0 12px;"></div>
  <span style="font-size:11px;color:rgba(255,255,255,0.25);">01</span>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1920, height: 1080, deviceScaleFactor: 2 } };
  },

  // 16. pitch-deck — Investor pitch style
  'pitch-deck': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#fff;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Left accent bar -->
<div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:#1a237e;"></div>
<!-- Top label -->
<div style="position:absolute;top:48px;left:80px;font-size:12px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;color:#9e9e9e;">PITCH DECK</div>
<!-- Screenshot -->
<div style="position:absolute;top:100px;left:80px;right:80px;bottom:100px;overflow:hidden;border-radius:4px;box-shadow:0 8px 32px rgba(0,0,0,0.08);">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
<!-- Footer -->
<div style="position:absolute;bottom:0;left:80px;right:80px;height:90px;display:flex;align-items:center;border-top:1px solid #e0e0e0;">
  <span style="font-size:12px;color:#bdbdbd;font-style:italic;">Confidential — For investor use only</span>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 17. proposal-clean — Business proposal doc
  'proposal-clean': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const date = getFormattedDate();
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1700px;overflow:hidden;background:#ffffff;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Header -->
<div style="padding:60px 80px 32px;">
  <div style="height:2px;background:#e0e0e0;margin-bottom:28px;"></div>
  <div style="display:flex;align-items:baseline;justify-content:space-between;">
    <div style="font-size:28px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#212121;">PROPOSTA COMERCIAL</div>
    <div style="font-size:13px;color:#9e9e9e;">${date}</div>
  </div>
</div>
<!-- Screenshot -->
<div style="margin:0 80px;overflow:hidden;border-radius:4px;border:1px solid #f0f0f0;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
  <img src="${img}" style="width:100%;height:1280px;object-fit:cover;object-position:top center;display:block;">
</div>
<!-- Footer -->
<div style="position:absolute;bottom:0;left:0;right:0;padding:20px 80px;border-top:1px solid #eeeeee;display:flex;align-items:center;justify-content:space-between;">
  <span style="font-size:12px;color:#bdbdbd;">Company Name · ${date}</span>
  <span style="font-size:12px;color:#bdbdbd;">Página 1 / 1</span>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1700, deviceScaleFactor: 2 } };
  },

  // 18. case-study — Editorial case study
  'case-study': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#f5f0eb;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Left column -->
<div style="position:absolute;top:0;left:0;bottom:0;width:680px;padding:80px 60px;display:flex;flex-direction:column;justify-content:space-between;">
  <div>
    <div style="font-size:72px;font-weight:900;line-height:1;color:#1a1a1a;letter-spacing:-0.02em;margin-bottom:40px;">CASE<br>STUDY</div>
    <!-- Placeholder text lines -->
    <div style="height:3px;background:#1a1a1a;width:200px;margin-bottom:20px;"></div>
    <div style="height:12px;background:#c8c0b6;border-radius:2px;width:100%;margin-bottom:12px;"></div>
    <div style="height:12px;background:#c8c0b6;border-radius:2px;width:85%;margin-bottom:12px;"></div>
    <div style="height:12px;background:#c8c0b6;border-radius:2px;width:92%;margin-bottom:12px;"></div>
    <div style="height:12px;background:#c8c0b6;border-radius:2px;width:78%;margin-bottom:12px;"></div>
    <div style="height:12px;background:#c8c0b6;border-radius:2px;width:95%;margin-bottom:12px;"></div>
    <div style="height:12px;background:#c8c0b6;border-radius:2px;width:70%;"></div>
  </div>
  <!-- Result tag -->
  <div style="display:inline-block;background:#1a1a1a;color:#f5f0eb;font-size:14px;font-weight:700;padding:10px 20px;border-radius:999px;letter-spacing:0.04em;">Resultado: +230% 🚀</div>
</div>
<!-- Right: screenshot -->
<div style="position:absolute;top:0;right:0;bottom:0;left:680px;overflow:hidden;">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 19. portfolio-showcase — Portfolio grid
  'portfolio-showcase': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#111111;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Label -->
<div style="position:absolute;top:40px;left:48px;font-size:11px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.3);">PORTFOLIO</div>
<!-- Main screenshot with inner frame -->
<div style="position:absolute;top:80px;left:48px;right:48px;bottom:140px;border:1px solid rgba(255,255,255,0.12);overflow:hidden;">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
<!-- Thumbnail strip -->
<div style="position:absolute;bottom:24px;left:48px;right:48px;display:flex;gap:16px;">
  <div style="height:80px;flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:4px;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;opacity:0.5;">
  </div>
  <div style="height:80px;flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:4px;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:40% top;display:block;opacity:0.5;">
  </div>
  <div style="height:80px;flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:4px;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:80% top;display:block;opacity:0.5;">
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 20. corporate-clean — Corporate neutral
  'corporate-clean': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#f0f4f8;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Top bar -->
<div style="height:80px;background:#1a237e;display:flex;align-items:center;padding:0 48px;gap:20px;">
  <div style="width:48px;height:48px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;color:#1a237e;">C</div>
  <span style="font-size:14px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.9);">CORPORATE</span>
  <div style="flex:1;"></div>
  <div style="height:1px;width:120px;background:rgba(255,255,255,0.2);"></div>
</div>
<!-- Content area -->
<div style="padding:48px;height:calc(100% - 80px - 60px);">
  <div style="background:#fff;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,0.08),0 1px 4px rgba(0,0,0,0.04);overflow:hidden;height:100%;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
</div>
<!-- Footer bar -->
<div style="position:absolute;bottom:0;left:0;right:0;height:60px;background:#1a237e;display:flex;align-items:center;padding:0 48px;">
  <span style="font-size:12px;color:rgba(255,255,255,0.5);letter-spacing:0.05em;">© 2025 Company Name. All rights reserved.</span>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // ── DEVICE TEMPLATES ──────────────────────────────────────────────────────

  // 21. macbook-realistic — Realistic MacBook Pro
  'macbook-realistic': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1700px;overflow:hidden;background:radial-gradient(circle at 50% 50%,#2a2a2a 0%,#111 100%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="display:flex;flex-direction:column;align-items:center;">
  <!-- Screen lid -->
  <div style="width:1840px;background:linear-gradient(180deg,#c0c0c0 0%,#a8a8a8 100%);border-radius:16px 16px 0 0;padding:12px 12px 0;box-shadow:0 -4px 20px rgba(0,0,0,0.3);">
    <!-- Bezel -->
    <div style="background:#1a1a1a;border-radius:10px 10px 0 0;overflow:hidden;padding:14px 14px 0;">
      <!-- Camera -->
      <div style="text-align:center;height:16px;display:flex;align-items:center;justify-content:center;margin-bottom:4px;">
        <div style="width:8px;height:8px;border-radius:50%;background:#2a2a2a;border:1px solid #333;"></div>
      </div>
      <!-- Screen -->
      <div style="height:980px;overflow:hidden;border-radius:4px 4px 0 0;">
        <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
      </div>
    </div>
  </div>
  <!-- Keyboard base -->
  <div style="width:1920px;height:28px;background:linear-gradient(180deg,#c8c8c8,#b8b8b8);border-radius:0 0 4px 4px;box-shadow:0 8px 32px rgba(0,0,0,0.6),0 40px 80px rgba(0,0,0,0.4);"></div>
  <!-- Stand/hinge -->
  <div style="width:440px;height:20px;background:linear-gradient(180deg,#b0b0b0,#989898);border-radius:0 0 12px 12px;"></div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1700, deviceScaleFactor: 2 } };
  },

  // 22. macbook-clean — Minimal MacBook
  'macbook-clean': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1700px;overflow:hidden;background:#ffffff;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="display:flex;flex-direction:column;align-items:center;">
  <!-- Screen -->
  <div style="width:1840px;border:3px solid #c8c8c8;border-bottom:none;border-radius:12px 12px 0 0;overflow:hidden;background:#fff;box-shadow:0 8px 40px rgba(0,0,0,0.08);">
    <!-- Camera dot -->
    <div style="height:20px;background:#f5f5f5;border-bottom:1px solid #e0e0e0;display:flex;align-items:center;justify-content:center;">
      <div style="width:6px;height:6px;border-radius:50%;background:#c8c8c8;"></div>
    </div>
    <!-- Screenshot -->
    <div style="height:1020px;overflow:hidden;">
      <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
    </div>
  </div>
  <!-- Base platform -->
  <div style="width:1920px;height:24px;background:#f0f0f0;border:1px solid #ddd;border-top:none;border-radius:0 0 4px 4px;"></div>
  <div style="width:420px;height:16px;background:#e8e8e8;border:1px solid #ddd;border-top:none;border-radius:0 0 10px 10px;"></div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1700, deviceScaleFactor: 2 } };
  },

  // 23. iphone-pro — iPhone 15 Pro
  'iphone-pro': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1900px;overflow:hidden;background:radial-gradient(circle at 50% 40%,#2c2c2c 0%,#111 60%,#000 100%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="position:relative;width:680px;height:1480px;background:linear-gradient(145deg,#2c2c2c,#1c1c1e,#161618);border-radius:54px;box-shadow:0 0 0 1px rgba(255,255,255,0.08),inset 0 0 0 1px rgba(255,255,255,0.04),0 40px 100px rgba(0,0,0,0.95);">
  <!-- Screen content -->
  <div style="position:absolute;inset:0;border-radius:44px;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
  <!-- Dynamic Island -->
  <div style="position:absolute;top:14px;left:50%;transform:translateX(-50%);width:120px;height:36px;background:#000;border-radius:20px;z-index:10;"></div>
  <!-- Home indicator -->
  <div style="position:absolute;bottom:10px;left:50%;transform:translateX(-50%);width:120px;height:5px;background:rgba(255,255,255,0.5);border-radius:3px;z-index:10;"></div>
  <!-- Side buttons -->
  <div style="position:absolute;left:-4px;top:180px;width:3px;height:72px;background:#3a3a3a;border-radius:2px;"></div>
  <div style="position:absolute;left:-4px;top:270px;width:3px;height:72px;background:#3a3a3a;border-radius:2px;"></div>
  <div style="position:absolute;right:-4px;top:220px;width:3px;height:100px;background:#3a3a3a;border-radius:2px;"></div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 900, height: 1900, deviceScaleFactor: 2 } };
  },

  // 24. iphone-dark — iPhone dark environment
  'iphone-dark': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1900px;overflow:hidden;background:#000000;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<!-- Glow effect behind phone -->
<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:500px;height:900px;border-radius:50%;background:rgba(100,100,255,0.15);filter:blur(80px);pointer-events:none;"></div>
<div style="position:relative;width:680px;height:1480px;background:linear-gradient(145deg,#2c2c2c,#1c1c1e,#161618);border-radius:54px;box-shadow:0 0 0 1px rgba(255,255,255,0.07),0 0 60px rgba(100,100,255,0.3),0 40px 100px rgba(0,0,0,0.99);">
  <!-- Screen content -->
  <div style="position:absolute;inset:0;border-radius:44px;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
  <!-- Dynamic Island -->
  <div style="position:absolute;top:14px;left:50%;transform:translateX(-50%);width:120px;height:36px;background:#000;border-radius:20px;z-index:10;"></div>
  <!-- Home indicator -->
  <div style="position:absolute;bottom:10px;left:50%;transform:translateX(-50%);width:120px;height:5px;background:rgba(255,255,255,0.4);border-radius:3px;z-index:10;"></div>
  <!-- Side buttons -->
  <div style="position:absolute;left:-4px;top:180px;width:3px;height:72px;background:#2a2a2a;border-radius:2px;"></div>
  <div style="position:absolute;left:-4px;top:270px;width:3px;height:72px;background:#2a2a2a;border-radius:2px;"></div>
  <div style="position:absolute;right:-4px;top:220px;width:3px;height:100px;background:#2a2a2a;border-radius:2px;"></div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 900, height: 1900, deviceScaleFactor: 2 } };
  },

  // 25. multi-device — Desktop + Mobile combined
  'multi-device': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#f8f9fa;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Label -->
<div style="position:absolute;top:32px;left:0;right:0;text-align:center;font-size:13px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#9e9e9e;">Responsive Design</div>
<!-- Browser (desktop) - left 65% -->
<div style="position:absolute;top:80px;left:48px;width:1520px;bottom:60px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.1),0 2px 8px rgba(0,0,0,0.06);border:1px solid #e0e0e0;">
  <!-- Browser chrome -->
  <div style="height:44px;background:#f5f5f5;border-bottom:1px solid #e8e8e8;display:flex;align-items:center;padding:0 16px;gap:8px;">
    <div style="display:flex;gap:6px;"><div style="width:10px;height:10px;border-radius:50%;background:#ff5f57;"></div><div style="width:10px;height:10px;border-radius:50%;background:#febc2e;"></div><div style="width:10px;height:10px;border-radius:50%;background:#28c840;"></div></div>
    <div style="flex:1;background:#e8e8e8;border-radius:4px;height:24px;display:flex;align-items:center;padding:0 10px;font-size:11px;color:#999;">https://seusite.com</div>
  </div>
  <div style="height:calc(100% - 44px);overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
</div>
<!-- Phone (mobile) - right overlapping -->
<div style="position:absolute;right:48px;top:50%;transform:translateY(-50%);width:340px;height:680px;background:#1c1c1e;border-radius:36px;border:6px solid #2a2a2a;box-shadow:0 20px 60px rgba(0,0,0,0.3),0 0 0 1px rgba(255,255,255,0.05);overflow:hidden;">
  <div style="height:16px;background:#1c1c1e;display:flex;align-items:center;justify-content:center;">
    <div style="width:60px;height:6px;background:#111;border-radius:3px;"></div>
  </div>
  <div style="height:calc(100% - 16px);overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 26. browser-premium — Premium browser
  'browser-premium': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1720px;overflow:hidden;background:#18181b;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="position:absolute;top:70px;left:80px;right:80px;display:flex;flex-direction:column;overflow:hidden;border-radius:14px;box-shadow:0 32px 100px rgba(0,0,0,0.9),0 8px 24px rgba(0,0,0,0.7),0 0 0 1px rgba(255,255,255,0.06);">
  <!-- Chrome bar -->
  <div style="height:48px;background:#242424;display:flex;align-items:center;padding:0 20px;gap:16px;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.05);">
    <div style="display:flex;gap:8px;">
      <div style="width:12px;height:12px;border-radius:50%;background:#ff5f57;"></div>
      <div style="width:12px;height:12px;border-radius:50%;background:#febc2e;"></div>
      <div style="width:12px;height:12px;border-radius:50%;background:#28c840;"></div>
    </div>
    <!-- Tab -->
    <div style="background:#2e2e2e;border-radius:8px 8px 0 0;padding:6px 16px;display:flex;align-items:center;gap:8px;min-width:180px;">
      <div style="width:14px;height:14px;border-radius:50%;background:#555;"></div>
      <span style="font-size:12px;color:rgba(255,255,255,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${dom || 'Site Name'}</span>
    </div>
    <!-- URL bar -->
    <div style="flex:1;max-width:500px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:8px;height:28px;display:flex;align-items:center;padding:0 12px;gap:6px;">
      <span style="font-size:11px;color:rgba(255,255,255,0.3);">🔒</span>
      <span style="font-size:12px;color:rgba(255,255,255,0.45);">${dom || 'exemplo.com'}</span>
    </div>
  </div>
  <!-- Screenshot area -->
  <div style="height:1320px;overflow:hidden;background:#fff;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
</div>
<!-- Reflection -->
<div style="position:absolute;bottom:20px;left:80px;right:80px;height:160px;overflow:hidden;border-radius:0 0 14px 14px;opacity:0.18;">
  <img src="${img}" style="width:100%;height:300px;object-fit:cover;object-position:bottom center;display:block;transform:scaleY(-1);-webkit-mask-image:linear-gradient(to bottom,rgba(0,0,0,0.8),transparent);mask-image:linear-gradient(to bottom,rgba(0,0,0,0.8),transparent);">
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1720, deviceScaleFactor: 2 } };
  },

  // ── MARKETING TEMPLATES ───────────────────────────────────────────────────

  // 27. hero-section — Landing page hero
  'hero-section': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#0d0d0d;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Ghost text -->
<div style="position:absolute;top:0;left:0;right:0;text-align:center;font-size:400px;font-weight:900;color:rgba(255,255,255,0.03);letter-spacing:-0.02em;line-height:0.9;pointer-events:none;overflow:hidden;top:-40px;">HERO</div>
<!-- Screenshot (slightly angled) -->
<div style="transform:rotate(-1deg);position:relative;z-index:2;border-radius:10px;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,0.8);">
  <img src="${img}" style="width:2100px;height:1200px;object-fit:cover;object-position:top center;display:block;">
</div>
<!-- CTA buttons -->
<div style="position:absolute;bottom:60px;display:flex;gap:16px;z-index:3;">
  <button style="background:#fff;color:#0d0d0d;border:none;border-radius:999px;padding:18px 44px;font-size:16px;font-weight:700;cursor:pointer;">Começar agora</button>
  <button style="background:transparent;color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.25);border-radius:999px;padding:18px 44px;font-size:16px;font-weight:600;cursor:pointer;">Ver demo</button>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 28. landing-highlight — SaaS landing
  'landing-highlight': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1700px;overflow:hidden;background:linear-gradient(180deg,#0f172a 0%,#1e293b 100%);position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;}</style></head><body>
<!-- Badge -->
<div style="position:absolute;top:60px;left:50%;transform:translateX(-50%);background:rgba(250,204,21,0.12);border:1px solid rgba(250,204,21,0.3);border-radius:999px;padding:8px 20px;font-size:13px;font-weight:600;color:#fbbf24;letter-spacing:0.04em;">✦ NOVO PRODUTO</div>
<!-- Title placeholder lines -->
<div style="position:absolute;top:120px;left:50%;transform:translateX(-50%);width:900px;display:flex;flex-direction:column;gap:12px;align-items:center;">
  <div style="height:28px;background:rgba(255,255,255,0.12);border-radius:4px;width:700px;"></div>
  <div style="height:28px;background:rgba(255,255,255,0.08);border-radius:4px;width:540px;"></div>
</div>
<!-- Browser-framed screenshot -->
<div style="border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);box-shadow:0 32px 100px rgba(0,0,0,0.7);margin-top:40px;">
  <div style="height:36px;background:#1e293b;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;padding:0 14px;gap:8px;">
    <div style="display:flex;gap:5px;"><div style="width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,0.1);"></div><div style="width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,0.1);"></div><div style="width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,0.1);"></div></div>
    <div style="flex:1;background:rgba(255,255,255,0.05);border-radius:4px;height:18px;"></div>
  </div>
  <img src="${img}" style="width:2100px;height:1080px;object-fit:cover;object-position:top center;display:block;">
</div>
<!-- CTA bottom -->
<div style="position:absolute;bottom:50px;display:flex;align-items:center;gap:20px;">
  <span style="font-size:14px;color:rgba(255,255,255,0.5);">14 dias grátis</span>
  <div style="width:1px;height:16px;background:rgba(255,255,255,0.15);"></div>
  <button style="background:#fff;color:#0f172a;border:none;border-radius:8px;padding:12px 32px;font-size:14px;font-weight:700;cursor:pointer;">Testar agora →</button>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1700, deviceScaleFactor: 2 } };
  },

  // 29. feature-showcase — Feature highlight
  'feature-showcase': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1400px;overflow:hidden;background:#ffffff;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;}</style></head><body>
<!-- Left: feature info -->
<div style="width:900px;padding:80px;flex-shrink:0;">
  <!-- Icon -->
  <div style="width:56px;height:56px;background:#f0f4ff;border-radius:14px;display:flex;align-items:center;justify-content:center;margin-bottom:24px;">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
  </div>
  <!-- Title placeholder -->
  <div style="height:32px;background:#1a1a1a;border-radius:4px;width:380px;margin-bottom:16px;"></div>
  <div style="height:20px;background:#e5e7eb;border-radius:3px;width:320px;margin-bottom:32px;"></div>
  <!-- Bullet points -->
  <div style="display:flex;flex-direction:column;gap:16px;">
    <div style="display:flex;align-items:center;gap:12px;">
      <div style="width:20px;height:20px;border-radius:50%;background:#e0f2fe;flex-shrink:0;display:flex;align-items:center;justify-content:center;"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="#0ea5e9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div>
      <div style="height:14px;background:#e5e7eb;border-radius:3px;flex:1;"></div>
    </div>
    <div style="display:flex;align-items:center;gap:12px;">
      <div style="width:20px;height:20px;border-radius:50%;background:#e0f2fe;flex-shrink:0;display:flex;align-items:center;justify-content:center;"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="#0ea5e9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div>
      <div style="height:14px;background:#e5e7eb;border-radius:3px;flex:1;max-width:280px;"></div>
    </div>
    <div style="display:flex;align-items:center;gap:12px;">
      <div style="width:20px;height:20px;border-radius:50%;background:#e0f2fe;flex-shrink:0;display:flex;align-items:center;justify-content:center;"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="#0ea5e9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div>
      <div style="height:14px;background:#e5e7eb;border-radius:3px;flex:1;max-width:300px;"></div>
    </div>
  </div>
</div>
<!-- Right: screenshot card -->
<div style="flex:1;padding:60px 80px 60px 0;">
  <div style="border-radius:12px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.1),0 2px 8px rgba(0,0,0,0.06);border:1px solid #e5e7eb;height:1200px;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1400, deviceScaleFactor: 2 } };
  },

  // 30. comparison-before-after — Before vs After split
  'comparison-before-after': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#0a0a0a;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Left: ANTES -->
<div style="position:absolute;inset:0;right:50%;overflow:hidden;">
  <img src="${img}" style="width:2400px;height:100%;object-fit:cover;object-position:top left;display:block;filter:saturate(0.3) brightness(0.8) sepia(0.4);">
  <!-- Red tint overlay -->
  <div style="position:absolute;inset:0;background:rgba(180,0,0,0.12);"></div>
  <!-- ANTES label -->
  <div style="position:absolute;bottom:40px;left:40px;font-size:20px;font-weight:800;color:#fff;letter-spacing:0.1em;background:rgba(180,0,0,0.6);padding:8px 20px;border-radius:6px;">ANTES</div>
</div>
<!-- Right: DEPOIS -->
<div style="position:absolute;inset:0;left:50%;overflow:hidden;">
  <img src="${img}" style="width:2400px;height:100%;object-fit:cover;object-position:top right;display:block;transform:translateX(-50%);margin-left:0;">
  <!-- Green tint overlay -->
  <div style="position:absolute;inset:0;background:rgba(0,150,50,0.08);"></div>
  <!-- DEPOIS label -->
  <div style="position:absolute;bottom:40px;right:40px;font-size:20px;font-weight:800;color:#fff;letter-spacing:0.1em;background:rgba(0,120,40,0.6);padding:8px 20px;border-radius:6px;">DEPOIS</div>
</div>
<!-- Center divider -->
<div style="position:absolute;top:0;bottom:0;left:50%;width:3px;background:rgba(255,255,255,0.9);transform:translateX(-50%);"></div>
<!-- Center handle -->
<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:56px;height:56px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,0.4);">
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round"><path d="M7 16l-4-4 4-4M17 8l4 4-4 4"/></svg>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 31. gradient-premium — Premium gradient background
  'gradient-premium': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#1a1a2e;background-image:radial-gradient(at 0% 0%,#ff6b6b 0%,transparent 50%),radial-gradient(at 100% 0%,#4ecdc4 0%,transparent 50%),radial-gradient(at 100% 100%,#45b7d1 0%,transparent 50%),radial-gradient(at 0% 100%,#96ceb4 0%,transparent 50%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:2160px;height:1360px;object-fit:cover;object-position:top center;display:block;border:2px solid rgba(255,255,255,0.9);border-radius:12px;box-shadow:0 25px 80px rgba(0,0,0,0.5),0 8px 24px rgba(0,0,0,0.3);">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 32. spotlight-product — Product spotlight
  'spotlight-product': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#000000;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- Spotlight radial gradient -->
<div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 40%,rgba(255,255,255,0.12) 0%,rgba(255,255,255,0.04) 25%,transparent 60%);pointer-events:none;"></div>
<!-- Stars -->
<div style="position:absolute;top:48px;left:0;right:0;text-align:center;font-size:28px;letter-spacing:8px;">★★★★★</div>
<!-- Screenshot -->
<img src="${img}" style="position:relative;z-index:2;width:2100px;height:1300px;object-fit:cover;object-position:top center;display:block;box-shadow:0 40px 120px rgba(0,0,0,0.9),0 16px 40px rgba(0,0,0,0.7);">
<!-- Bottom label -->
<div style="position:absolute;bottom:28px;left:0;right:0;display:flex;flex-direction:column;align-items:center;gap:8px;z-index:3;">
  <div style="width:120px;height:1px;background:rgba(255,255,255,0.35);"></div>
  <div style="font-size:14px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:rgba(255,255,255,0.6);">PRODUTO EM DESTAQUE</div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

};

// ── Section 3: Main render function (returns Buffer) ─────────────────────────

// Templates that are already portrait-oriented — skip mobile adaptation
const MOBILE_SAFE_TEMPLATES = new Set([
  'mobile-simple', 'iphone-pro', 'iphone-dark',
  'instagram-story', 'instagram-post', 'social-basic',
]);

// Per-template mobile canvas config — canvas matches each template's visual theme
// canvas: body background (matches desktop bg)
// canvasExtra: additional background-image override (for gradient effects)
// phoneBg: phone chassis color
// isDark: drives indicator/button colors
const TEMPLATE_MOBILE_CONFIG = {
  // FREE
  'browser-clean':           { canvas: '#0f0f0f',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'minimal-clean':           { canvas: '#f8f8f6',                                                                        phoneBg: 'linear-gradient(145deg,#e8e8e8,#d8d8d8)', isDark: false },
  'social-basic':            { canvas: '#ffffff',                                                                        phoneBg: 'linear-gradient(145deg,#f0f0f0,#e0e0e0)', isDark: false },
  'gradient-basic':          { canvas: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)',                                phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'default-dark':            { canvas: '#000000',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  // SOCIAL
  'twitter-post':            { canvas: '#000000',                                                                        phoneBg: 'linear-gradient(145deg,#1a1a1a,#111111)', isDark: true  },
  'linkedin-post':           { canvas: 'linear-gradient(135deg,#0077b5,#005f99)',                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'whatsapp-share':          { canvas: 'linear-gradient(135deg,#25d366,#128c7e)',                                        phoneBg: 'linear-gradient(145deg,#111111,#1a1a1a)', isDark: true  },
  'carousel-post':           { canvas: '#fafafa',                                                                        phoneBg: 'linear-gradient(145deg,#f0f0f0,#e0e0e0)', isDark: false },
  'ad-style':                { canvas: '#0f0f0f',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'viral-frame':             { canvas: '#000000',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  // PROFESSIONAL
  'presentation-slide':      { canvas: 'linear-gradient(135deg,#1e3a5f 0%,#2d5a8e 100%)',                               phoneBg: 'linear-gradient(145deg,#e8e8e8,#d0d0d0)', isDark: true  },
  'pitch-deck':              { canvas: '#0a0a0a',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'proposal-clean':          { canvas: '#ffffff',                                                                        phoneBg: 'linear-gradient(145deg,#f0f0f0,#e0e0e0)', isDark: false },
  'case-study':              { canvas: '#f5f5f5',                                                                        phoneBg: 'linear-gradient(145deg,#e8e8e8,#d8d8d8)', isDark: false },
  'portfolio-showcase':      { canvas: '#0d0d0d',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'corporate-clean':         { canvas: '#1a1a2e',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  // DEVICES
  'macbook-realistic':       { canvas: '#0a0a0a',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'macbook-clean':           { canvas: '#ffffff',                                                                        phoneBg: 'linear-gradient(145deg,#e0e0e0,#cccccc)', isDark: false },
  'multi-device':            { canvas: '#0f1117',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'browser-premium':         { canvas: '#0a0a1a',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  // MARKETING
  'hero-section':            { canvas: '#0d0d0d',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'landing-highlight':       { canvas: 'linear-gradient(180deg,#0f172a 0%,#1e293b 100%)',                               phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'feature-showcase':        { canvas: '#ffffff',                                                                        phoneBg: 'linear-gradient(145deg,#f0f0f0,#e0e0e0)', isDark: false },
  'comparison-before-after': { canvas: '#0a0a0a',                                                                        phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'gradient-premium':        { canvas: '#1a1a2e', canvasExtra: 'radial-gradient(at 0% 0%,#ff6b6b 0%,transparent 50%),radial-gradient(at 100% 100%,#45b7d1 0%,transparent 50%)', phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
  'spotlight-product':       { canvas: '#000000', canvasExtra: 'radial-gradient(circle at 50% 40%,rgba(255,255,255,0.1) 0%,transparent 60%)',                                    phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true  },
};

// Wraps a mobile screenshot in a phone frame whose background matches the chosen template's theme.
function renderMobileAdaptedHtml(screenshotPath, templateId, options) {
  const img = screenshotToBase64(screenshotPath);
  const wm  = getWatermarkHtml(options);
  const cfg = TEMPLATE_MOBILE_CONFIG[templateId] || { canvas: '#0f0f0f', phoneBg: 'linear-gradient(145deg,#2c2c2c,#1c1c1e)', isDark: true };

  // Build body background: if canvas is a gradient use background directly, else use background-color
  const isGradient = cfg.canvas.startsWith('linear-gradient') || cfg.canvas.startsWith('radial-gradient');
  const bodyBg = isGradient
    ? `background:${cfg.canvas};`
    : `background-color:${cfg.canvas};`;
  const bodyBgExtra = cfg.canvasExtra ? `background-image:${cfg.canvasExtra};` : '';

  const isDark      = cfg.isDark;
  const phoneShadow = isDark
    ? '0 0 0 1px rgba(255,255,255,0.08),inset 0 0 0 1px rgba(255,255,255,0.04),0 40px 100px rgba(0,0,0,0.95)'
    : '0 0 0 1px rgba(0,0,0,0.15),0 40px 100px rgba(0,0,0,0.20)';
  const indicatorBg = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.25)';
  const btnBg       = isDark ? '#3a3a3a' : '#aaaaaa';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1900px;overflow:hidden;${bodyBg}${bodyBgExtra}display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="position:relative;width:680px;height:1480px;background:${cfg.phoneBg};border-radius:54px;box-shadow:${phoneShadow};">
  <div style="position:absolute;inset:0;border-radius:44px;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
  <div style="position:absolute;top:14px;left:50%;transform:translateX(-50%);width:120px;height:36px;background:#000;border-radius:20px;z-index:10;"></div>
  <div style="position:absolute;bottom:10px;left:50%;transform:translateX(-50%);width:120px;height:5px;background:${indicatorBg};border-radius:3px;z-index:10;"></div>
  <div style="position:absolute;left:-4px;top:180px;width:3px;height:72px;background:${btnBg};border-radius:2px;"></div>
  <div style="position:absolute;left:-4px;top:270px;width:3px;height:72px;background:${btnBg};border-radius:2px;"></div>
  <div style="position:absolute;right:-4px;top:220px;width:3px;height:100px;background:${btnBg};border-radius:2px;"></div>
</div>
${wm}</body></html>`;
  return { html, renderConfig: { width: 900, height: 1900, deviceScaleFactor: 2 } };
}

// Legacy template IDs → new IDs
const LEGACY_MAP = {
  'browser':           'browser-clean',
  'browser-light':     'browser-clean',
  'iphone':            'iphone-pro',
  'iphone-15':         'iphone-pro',
  'macbook-pro':       'macbook-realistic',
  'presentation':      'presentation-slide',
  'slide':             'presentation-slide',
  'og-image':          'default-dark',
  'twitter-card':      'default-dark',
  'linkedin-banner':   'linkedin-post',
  'whatsapp-preview':  'whatsapp-share',
  'ocean':             'gradient-premium',
  'duotone':           'gradient-premium',
  'isometric':         'gradient-basic',
  'diorama':           'gradient-basic',
  'vaporwave':         'gradient-premium',
  'filmstrip':         'spotlight-product',
  'ipad':              'macbook-clean',
  'watch':             'iphone-dark',
  'magazine':          'case-study',
  'report':            'proposal-clean',
};

async function renderTemplate(templateId, screenshotPath, deviceType, options) {
  options = options || {};
  const resolvedId = LEGACY_MAP[templateId] || templateId;

  // For mobile screenshots, use a portrait phone frame unless template is already mobile-native
  let renderFn;
  if (deviceType === 'mobile' && !MOBILE_SAFE_TEMPLATES.has(resolvedId)) {
    renderFn = async (sp, _dt, opts) => renderMobileAdaptedHtml(sp, resolvedId, opts);
  } else {
    renderFn = templateRenderers[resolvedId] || templateRenderers['default-dark'];
  }

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
async function renderProfessional({ screenshotPath, deviceType, templateId, renderConfig, outputPath, pageUrl, pageTitle, applyWatermark }) {
  // templateId may be passed directly (rerender path) or embedded in renderConfig.template (screenshotter path)
  const resolvedTemplateId = templateId || (renderConfig && renderConfig.template) || 'default-dark';
  const options = { pageUrl, pageTitle, applyWatermark, renderConfig };
  const buffer  = await renderTemplate(resolvedTemplateId, screenshotPath, deviceType, options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

/**
 * Renders a template to a Buffer for social export variants.
 */
async function renderSocialExport({ screenshotPath, deviceType, templateId, renderConfig, pageUrl, pageTitle, applyWatermark }) {
  const resolvedTemplateId = templateId || (renderConfig && renderConfig.template) || 'default-dark';
  const options = { pageUrl, pageTitle, applyWatermark, renderConfig };
  return renderTemplate(resolvedTemplateId, screenshotPath, deviceType, options);
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
  MOBILE_SAFE_TEMPLATES,
  TEMPLATE_MOBILE_CONFIG,
};
