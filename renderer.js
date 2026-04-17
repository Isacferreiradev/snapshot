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
  // Dual blend-mode strategy: multiply (dark text) on light pages + screen (white text) on dark pages
  // mix-blend-mode:multiply with dark text → visible on white/light backgrounds
  // mix-blend-mode:screen with white text → visible on dark backgrounds
  // Badge with dark background → always visible on any background
  return `
<div style="position:absolute;inset:0;z-index:99999;pointer-events:none;overflow:hidden;user-select:none;">
  <svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:multiply;opacity:0.28;">
    <defs>
      <pattern id="wmM" x="0" y="0" width="380" height="190" patternUnits="userSpaceOnUse">
        <text x="190" y="95" font-size="20" font-family="Arial,sans-serif" font-weight="bold" fill="#111111" transform="rotate(-25 190 95)" text-anchor="middle" dominant-baseline="middle">SNAPDECK.PRO</text>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#wmM)" />
  </svg>
  <svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:screen;opacity:0.22;">
    <defs>
      <pattern id="wmS" x="0" y="0" width="380" height="190" patternUnits="userSpaceOnUse">
        <text x="190" y="95" font-size="20" font-family="Arial,sans-serif" font-weight="bold" fill="#ffffff" transform="rotate(-25 190 95)" text-anchor="middle" dominant-baseline="middle">SNAPDECK.PRO</text>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#wmS)" />
  </svg>
  <div style="position:absolute;bottom:24px;right:28px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#ffffff;background:rgba(0,0,0,0.75);padding:7px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);letter-spacing:0.03em;">snapdeck.pro</div>
</div>`;
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url || '').slice(0, 40); }
}

function getFormattedDate() {
  return new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── Section 2: 32 Template Renderers ─────────────────────────────────────────
// Each template handles deviceType ('desktop'|'mobile') internally.

const templateRenderers = {

  // ── FREE TEMPLATES ────────────────────────────────────────────────────────

  // 1. browser-clean — Minimal dark browser window
  'browser-clean': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:#0f0f0f;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="width:820px;height:1460px;background:#1a1a1a;border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,0.9),0 8px 32px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.05);">
  <div style="height:44px;background:#1a1a1a;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;padding:0 16px;flex-shrink:0;">
    <div style="display:flex;align-items:center;gap:7px;">
      <div style="width:10px;height:10px;border-radius:50%;background:#ff5f57;"></div>
      <div style="width:10px;height:10px;border-radius:50%;background:#febc2e;"></div>
      <div style="width:10px;height:10px;border-radius:50%;background:#28c840;"></div>
    </div>
    <div style="flex:1;display:flex;align-items:center;justify-content:center;">
      <div style="background:#272727;border:1px solid rgba(255,255,255,0.08);width:280px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;color:rgba(255,255,255,0.4);">🔒 ${dom || 'exemplo.com'}</div>
    </div>
    <div style="width:60px;"></div>
  </div>
  <div style="flex:1;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
</div>
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
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
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:#f8f8f6;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:820px;height:1460px;object-fit:cover;object-position:top center;display:block;box-shadow:0 4px 32px rgba(0,0,0,0.08),0 1px 3px rgba(0,0,0,0.04);">
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#f8f8f6;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:2240px;height:1400px;object-fit:cover;object-position:top center;display:block;box-shadow:0 4px 32px rgba(0,0,0,0.08),0 1px 3px rgba(0,0,0,0.04);">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 3. default-dark — Premium black
  'default-dark': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:#000000;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:820px;height:1460px;object-fit:cover;object-position:top center;display:block;box-shadow:0 0 80px rgba(255,255,255,0.05),0 40px 120px rgba(0,0,0,1);">
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#000000;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:2208px;height:1440px;object-fit:cover;object-position:top center;display:block;box-shadow:0 0 80px rgba(255,255,255,0.05),0 40px 120px rgba(0,0,0,1);">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 4. gradient-basic — Soft gradient background
  'gradient-basic': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:800px;height:1420px;object-fit:cover;object-position:top center;display:block;border:3px solid rgba(255,255,255,0.9);border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,0.3),0 8px 24px rgba(0,0,0,0.2);">
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:2100px;height:1320px;object-fit:cover;object-position:top center;display:block;border:3px solid rgba(255,255,255,0.9);border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,0.3),0 8px 24px rgba(0,0,0,0.2);">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 5. shadow-soft — Soft light background with rounded shadow
  'shadow-soft': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:#fafafa;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:800px;height:1420px;object-fit:cover;object-position:top center;display:block;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.10),0 2px 8px rgba(0,0,0,0.06);">
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#fafafa;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:2160px;height:1360px;object-fit:cover;object-position:top center;display:block;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.10),0 2px 8px rgba(0,0,0,0.06);">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 6. dark-frame — Dark minimalist frame without device chrome
  'dark-frame': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:#0a0a0a;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="width:800px;height:1420px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,0.8);">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#0a0a0a;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="width:2200px;height:1400px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,0.8);">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // ── SOCIAL MEDIA TEMPLATES ─────────────────────────────────���──────────────

  // 7. instagram-post — Instagram post mock (portrait-native: same for desktop & mobile)
  'instagram-post': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1080px;height:1350px;overflow:hidden;background:#fafafa;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="width:1080px;background:#fff;border:1px solid #dbdbdb;border-radius:4px;">
  <div style="display:flex;align-items:center;padding:14px 16px;gap:12px;">
    <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888);display:flex;align-items:center;justify-content:center;"><div style="width:36px;height:36px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;"><div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(45deg,#833ab4,#fd1d1d,#fcb045);"></div></div></div>
    <div style="flex:1;"><div style="font-size:14px;font-weight:600;color:#262626;display:flex;align-items:center;gap:4px;">your_brand <svg width="12" height="12" viewBox="0 0 24 24" fill="#0095f6"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg></div><div style="font-size:12px;color:#8e8e8e;">Patrocinado</div></div>
    <div style="font-size:20px;color:#262626;letter-spacing:2px;">···</div>
  </div>
  <div style="width:100%;aspect-ratio:1;overflow:hidden;"><img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;"></div>
  <div style="padding:12px 16px 4px;">
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:10px;">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#262626" stroke-width="2" stroke-linecap="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#262626" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#262626" stroke-width="2" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      <div style="flex:1;"></div>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#262626" stroke-width="2" stroke-linecap="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
    </div>
    <div style="font-size:14px;font-weight:600;color:#262626;margin-bottom:6px;">2.847 curtidas</div>
    <div style="font-size:14px;color:#262626;line-height:1.5;"><span style="font-weight:600;">your_brand</span> Confira nosso mais novo lançamento! Detalhes no link da bio.</div>
    <div style="font-size:14px;color:#8e8e8e;margin-top:4px;">Ver todos os 234 comentários</div>
    <div style="font-size:12px;color:#c7c7c7;margin-top:4px;text-transform:uppercase;letter-spacing:0.02em;">Há 2 horas</div>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1080, height: 1350, deviceScaleFactor: 2 } };
  },

  // 8. instagram-story — Instagram story (portrait-native)
  'instagram-story': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1080px;height:1920px;overflow:hidden;background:#000;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<img src="${img}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
<div style="position:absolute;top:0;left:0;right:0;height:200px;background:linear-gradient(to bottom,rgba(0,0,0,0.6),transparent);z-index:2;"></div>
<div style="position:absolute;bottom:0;left:0;right:0;height:200px;background:linear-gradient(to top,rgba(0,0,0,0.7),transparent);z-index:2;"></div>
<div style="position:absolute;top:20px;left:16px;right:16px;display:flex;gap:4px;z-index:10;">
  <div style="flex:1;height:3px;background:rgba(255,255,255,0.9);border-radius:2px;"></div>
  <div style="flex:1;height:3px;background:rgba(255,255,255,0.35);border-radius:2px;"></div>
  <div style="flex:1;height:3px;background:rgba(255,255,255,0.35);border-radius:2px;"></div>
</div>
<div style="position:absolute;top:40px;left:16px;right:16px;display:flex;align-items:center;gap:12px;z-index:10;">
  <div style="width:44px;height:44px;border-radius:50%;border:2px solid #fff;background:linear-gradient(45deg,#833ab4,#fd1d1d,#fcb045);flex-shrink:0;"></div>
  <div><div style="font-size:16px;font-weight:600;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.5);">your_brand</div><div style="font-size:13px;color:rgba(255,255,255,0.75);">Agora</div></div>
  <div style="margin-left:auto;font-size:24px;color:#fff;line-height:1;">×</div>
</div>
<div style="position:absolute;bottom:36px;left:16px;right:16px;z-index:10;display:flex;align-items:center;gap:12px;">
  <div style="flex:1;height:48px;border:1.5px solid rgba(255,255,255,0.5);border-radius:24px;display:flex;align-items:center;padding:0 20px;font-size:14px;color:rgba(255,255,255,0.7);">Enviar mensagem...</div>
  <div style="width:48px;height:48px;display:flex;align-items:center;justify-content:center;"><svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l7.84-7.84a5.5 5.5 0 0 0 0-7.78z"/></svg></div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1080, height: 1920, deviceScaleFactor: 2 } };
  },

  // 9. twitter-post — X/Twitter tweet
  'twitter-post': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const W = deviceType === 'mobile' ? 900 : 1200;
    const H = deviceType === 'mobile' ? 1100 : 900;
    const imgH = deviceType === 'mobile' ? 440 : 340;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="width:${W - 100}px;background:#000;border:1px solid #2f3336;border-radius:16px;padding:20px;">
  <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:14px;">
    <div style="width:48px;height:48px;border-radius:50%;background:#333;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px;color:#fff;">Y</div>
    <div style="flex:1;"><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;"><span style="font-size:16px;font-weight:700;color:#fff;">Your Brand</span><svg width="18" height="18" viewBox="0 0 24 24" fill="#1d9bf0"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91C2.88 9.33 2 10.57 2 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.33-2.19c1.4.46 2.91.2 3.92-.81s1.26-2.52.8-3.91c1.32-.67 2.2-1.91 2.2-3.34zm-6.61-4.44L10.5 13.5l-2.14-2.14a.75.75 0 10-1.06 1.06l2.67 2.67a.75.75 0 001.06 0l5.5-5.5a.75.75 0 10-1.06-1.06z"/></svg><span style="font-size:15px;color:#71767b;">@yourbrand · 2h</span></div></div>
    <div style="color:#71767b;font-size:20px;">···</div>
  </div>
  <div style="font-size:17px;color:#fff;line-height:1.6;margin-bottom:16px;">Confira esse produto incrível que vai transformar o seu negócio! Link nos comentários.</div>
  <div style="border-radius:12px;overflow:hidden;border:1px solid #2f3336;margin-bottom:16px;"><img src="${img}" style="width:100%;height:${imgH}px;object-fit:cover;object-position:top center;display:block;"></div>
  <div style="display:flex;align-items:center;gap:32px;color:#71767b;font-size:14px;">
    <span style="display:flex;align-items:center;gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>48</span>
    <span style="display:flex;align-items:center;gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>127</span>
    <span style="display:flex;align-items:center;gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>2.4K</span>
    <span style="display:flex;align-items:center;gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>34.7K</span>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: W, height: H, deviceScaleFactor: 2 } };
  },

  // 10. linkedin-post — LinkedIn corporate
  'linkedin-post': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const W = deviceType === 'mobile' ? 900 : 1200;
    const H = deviceType === 'mobile' ? 1200 : 1100;
    const imgH = deviceType === 'mobile' ? 540 : 480;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#f3f2ef;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="width:${W - 120}px;background:#fff;border-radius:8px;border:1px solid #e0e0e0;overflow:hidden;">
  <div style="padding:16px 16px 12px;display:flex;align-items:flex-start;gap:12px;">
    <div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#0073b1,#00a0dc);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff;">Y</div>
    <div style="flex:1;"><div style="font-size:15px;font-weight:600;color:#000;">Your Name</div><div style="font-size:13px;color:#666;">CEO at Company · 1.243 seguidores</div><div style="font-size:12px;color:#666;margin-top:2px;">1h</div></div>
    <div style="color:#666;font-size:20px;">···</div>
  </div>
  <div style="padding:0 16px 12px;font-size:15px;color:#000;line-height:1.6;">Excited to share our latest work! Check out this preview. #innovation #tech #startup</div>
  <div style="width:100%;overflow:hidden;"><img src="${img}" style="width:100%;height:${imgH}px;object-fit:cover;object-position:top center;display:block;"></div>
  <div style="padding:4px 16px;border-top:1px solid #e0e0e0;display:flex;align-items:center;gap:4px;">
    <button style="flex:1;padding:12px 8px;background:none;border:none;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:600;color:#666;border-radius:4px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/></svg>Curtir</button>
    <button style="flex:1;padding:12px 8px;background:none;border:none;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:600;color:#666;border-radius:4px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Comentar</button>
    <button style="flex:1;padding:12px 8px;background:none;border:none;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:600;color:#666;border-radius:4px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Enviar</button>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: W, height: H, deviceScaleFactor: 2 } };
  },

  // 11. whatsapp-share — WhatsApp chat with link preview
  'whatsapp-share': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    const W = deviceType === 'mobile' ? 900 : 1200;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:${W}px;height:1800px;overflow:hidden;background:#111b21;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<!-- WhatsApp doodle bg -->
<div style="position:absolute;inset:0;opacity:0.04;background-image:radial-gradient(circle,rgba(255,255,255,0.4) 1px,transparent 1px);background-size:20px 20px;"></div>
<!-- Top bar -->
<div style="position:relative;z-index:2;height:72px;background:#1f2c34;display:flex;align-items:center;padding:0 16px;gap:12px;border-bottom:1px solid rgba(255,255,255,0.06);">
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#aebac1" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
  <div style="width:44px;height:44px;border-radius:50%;background:#2a3942;display:flex;align-items:center;justify-content:center;font-size:20px;color:#aebac1;">J</div>
  <div style="flex:1;"><div style="font-size:17px;font-weight:500;color:#e9edef;">João</div><div style="font-size:13px;color:#8696a0;">online</div></div>
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#aebac1" stroke-width="2" stroke-linecap="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#aebac1" stroke-width="2" stroke-linecap="round" style="margin-left:16px;"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.36a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.76.32 1.55.55 2.36.68A2 2 0 0 1 22 16.92z"/></svg>
</div>
<!-- Chat area -->
<div style="position:relative;z-index:1;padding:24px 16px 100px;display:flex;flex-direction:column;gap:12px;">
  <!-- Date chip -->
  <div style="align-self:center;background:#1f2c34;border-radius:8px;padding:6px 14px;font-size:12px;color:#8696a0;margin-bottom:8px;">HOJE</div>
  <!-- Incoming bubble -->
  <div style="max-width:80%;background:#202c33;border-radius:0 12px 12px 12px;padding:10px 14px;position:relative;">
    <div style="font-size:15px;color:#e9edef;line-height:1.5;">Olha esse site que eu achei!</div>
    <div style="font-size:11px;color:#8696a0;text-align:right;margin-top:4px;">14:30</div>
    <div style="position:absolute;top:0;left:-8px;width:0;height:0;border-top:8px solid #202c33;border-left:8px solid transparent;"></div>
  </div>
  <!-- Outgoing bubble with link preview -->
  <div style="max-width:85%;align-self:flex-end;background:#005c4b;border-radius:12px 0 12px 12px;overflow:hidden;position:relative;">
    <!-- Link preview card -->
    <div style="background:rgba(0,0,0,0.15);overflow:hidden;">
      <img src="${img}" style="width:100%;height:360px;object-fit:cover;object-position:top center;display:block;">
      <div style="padding:10px 14px;border-top:1px solid rgba(255,255,255,0.06);">
        <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:2px;">${dom || 'seusite.com'}</div>
        <div style="font-size:14px;color:#e9edef;font-weight:500;">Confira o que há de novo</div>
      </div>
    </div>
    <!-- Message text -->
    <div style="padding:8px 14px 4px;">
      <div style="font-size:15px;color:#e9edef;line-height:1.4;">Olha que incrível esse site! Vale a pena conferir</div>
    </div>
    <div style="padding:4px 14px 8px;display:flex;align-items:center;justify-content:flex-end;gap:6px;">
      <div style="font-size:11px;color:rgba(255,255,255,0.5);">14:32</div>
      <svg width="16" height="10" viewBox="0 0 16 10" fill="none"><path d="M1 5l3 3.5L10 1" stroke="#53bdeb" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 5l3 3.5L15 1" stroke="#53bdeb" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div style="position:absolute;top:0;right:-8px;width:0;height:0;border-top:8px solid #005c4b;border-right:8px solid transparent;"></div>
  </div>
  <!-- Incoming reply -->
  <div style="max-width:70%;background:#202c33;border-radius:0 12px 12px 12px;padding:10px 14px;position:relative;">
    <div style="font-size:15px;color:#e9edef;">Muito bom! Vou dar uma olhada agora</div>
    <div style="font-size:11px;color:#8696a0;text-align:right;margin-top:4px;">14:33</div>
    <div style="position:absolute;top:0;left:-8px;width:0;height:0;border-top:8px solid #202c33;border-left:8px solid transparent;"></div>
  </div>
</div>
<!-- Bottom input bar -->
<div style="position:absolute;bottom:0;left:0;right:0;height:68px;background:#1f2c34;display:flex;align-items:center;padding:0 8px;gap:8px;z-index:2;">
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8696a0" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
  <div style="flex:1;height:44px;background:#2a3942;border-radius:22px;display:flex;align-items:center;padding:0 16px;font-size:15px;color:#8696a0;">Mensagem</div>
  <div style="width:44px;height:44px;border-radius:50%;background:#00a884;display:flex;align-items:center;justify-content:center;">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3z"/><path d="M17 12c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: W, height: 1800, deviceScaleFactor: 2 } };
  },

  // ── DEVICE TEMPLATES ──────────────────────────────────────────────────────

  // 12. macbook-realistic — Realistic MacBook Pro
  'macbook-realistic': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:radial-gradient(circle at 50% 45%,#2a2a2a 0%,#111 100%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="display:flex;flex-direction:column;align-items:center;">
  <div style="width:780px;background:linear-gradient(180deg,#c0c0c0 0%,#a8a8a8 100%);border-radius:10px 10px 0 0;padding:8px 8px 0;box-shadow:0 -4px 20px rgba(0,0,0,0.3);">
    <div style="background:#1a1a1a;border-radius:6px 6px 0 0;overflow:hidden;padding:10px 10px 0;">
      <div style="text-align:center;height:12px;display:flex;align-items:center;justify-content:center;margin-bottom:3px;"><div style="width:6px;height:6px;border-radius:50%;background:#2a2a2a;border:1px solid #333;"></div></div>
      <div style="height:460px;overflow:hidden;border-radius:3px 3px 0 0;"><img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;"></div>
    </div>
  </div>
  <div style="width:820px;height:18px;background:linear-gradient(180deg,#c8c8c8,#b8b8b8);border-radius:0 0 3px 3px;box-shadow:0 8px 32px rgba(0,0,0,0.6);"></div>
  <div style="width:200px;height:12px;background:linear-gradient(180deg,#b0b0b0,#989898);border-radius:0 0 8px 8px;"></div>
</div>
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1700px;overflow:hidden;background:radial-gradient(circle at 50% 50%,#2a2a2a 0%,#111 100%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="display:flex;flex-direction:column;align-items:center;">
  <div style="width:1840px;background:linear-gradient(180deg,#c0c0c0 0%,#a8a8a8 100%);border-radius:16px 16px 0 0;padding:12px 12px 0;box-shadow:0 -4px 20px rgba(0,0,0,0.3);">
    <div style="background:#1a1a1a;border-radius:10px 10px 0 0;overflow:hidden;padding:14px 14px 0;">
      <div style="text-align:center;height:16px;display:flex;align-items:center;justify-content:center;margin-bottom:4px;"><div style="width:8px;height:8px;border-radius:50%;background:#2a2a2a;border:1px solid #333;"></div></div>
      <div style="height:980px;overflow:hidden;border-radius:4px 4px 0 0;"><img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;"></div>
    </div>
  </div>
  <div style="width:1920px;height:28px;background:linear-gradient(180deg,#c8c8c8,#b8b8b8);border-radius:0 0 4px 4px;box-shadow:0 8px 32px rgba(0,0,0,0.6),0 40px 80px rgba(0,0,0,0.4);"></div>
  <div style="width:440px;height:20px;background:linear-gradient(180deg,#b0b0b0,#989898);border-radius:0 0 12px 12px;"></div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1700, deviceScaleFactor: 2 } };
  },

  // 13. macbook-clean — Minimal MacBook
  'macbook-clean': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:#ffffff;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="display:flex;flex-direction:column;align-items:center;">
  <div style="width:780px;border:2px solid #c8c8c8;border-bottom:none;border-radius:8px 8px 0 0;overflow:hidden;background:#fff;box-shadow:0 8px 40px rgba(0,0,0,0.08);">
    <div style="height:14px;background:#f5f5f5;border-bottom:1px solid #e0e0e0;display:flex;align-items:center;justify-content:center;"><div style="width:5px;height:5px;border-radius:50%;background:#c8c8c8;"></div></div>
    <div style="height:460px;overflow:hidden;"><img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;"></div>
  </div>
  <div style="width:820px;height:16px;background:#f0f0f0;border:1px solid #ddd;border-top:none;border-radius:0 0 3px 3px;"></div>
  <div style="width:200px;height:10px;background:#e8e8e8;border:1px solid #ddd;border-top:none;border-radius:0 0 8px 8px;"></div>
</div>
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1700px;overflow:hidden;background:#ffffff;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="display:flex;flex-direction:column;align-items:center;">
  <div style="width:1840px;border:3px solid #c8c8c8;border-bottom:none;border-radius:12px 12px 0 0;overflow:hidden;background:#fff;box-shadow:0 8px 40px rgba(0,0,0,0.08);">
    <div style="height:20px;background:#f5f5f5;border-bottom:1px solid #e0e0e0;display:flex;align-items:center;justify-content:center;"><div style="width:6px;height:6px;border-radius:50%;background:#c8c8c8;"></div></div>
    <div style="height:1020px;overflow:hidden;"><img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;"></div>
  </div>
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

  // 16. multi-device — Desktop + Mobile combined
  'multi-device': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:#f8f9fa;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="position:absolute;top:28px;left:0;right:0;text-align:center;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#9e9e9e;">Responsive Design</div>
<!-- Browser (top) -->
<div style="position:absolute;top:60px;left:40px;right:40px;height:520px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);border:1px solid #e0e0e0;">
  <div style="height:32px;background:#f5f5f5;border-bottom:1px solid #e8e8e8;display:flex;align-items:center;padding:0 12px;gap:6px;">
    <div style="display:flex;gap:5px;"><div style="width:8px;height:8px;border-radius:50%;background:#ff5f57;"></div><div style="width:8px;height:8px;border-radius:50%;background:#febc2e;"></div><div style="width:8px;height:8px;border-radius:50%;background:#28c840;"></div></div>
    <div style="flex:1;background:#e8e8e8;border-radius:4px;height:18px;"></div>
  </div>
  <div style="height:488px;overflow:hidden;"><img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;"></div>
</div>
<!-- Phone (bottom center) -->
<div style="position:absolute;bottom:60px;left:50%;transform:translateX(-50%);width:260px;height:520px;background:#1c1c1e;border-radius:28px;border:4px solid #2a2a2a;box-shadow:0 12px 40px rgba(0,0,0,0.2);overflow:hidden;">
  <div style="height:12px;background:#1c1c1e;display:flex;align-items:center;justify-content:center;"><div style="width:48px;height:5px;background:#111;border-radius:3px;"></div></div>
  <div style="height:calc(100% - 12px);overflow:hidden;"><img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;"></div>
</div>
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
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

  // 17. browser-premium — Premium browser
  'browser-premium': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const dom = getDomain(options && options.pageUrl);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:#18181b;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}</style></head><body>
<div style="width:820px;display:flex;flex-direction:column;overflow:hidden;border-radius:12px;box-shadow:0 32px 100px rgba(0,0,0,0.9),0 0 0 1px rgba(255,255,255,0.06);">
  <div style="height:40px;background:#242424;display:flex;align-items:center;padding:0 14px;gap:10px;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.05);">
    <div style="display:flex;gap:6px;"><div style="width:10px;height:10px;border-radius:50%;background:#ff5f57;"></div><div style="width:10px;height:10px;border-radius:50%;background:#febc2e;"></div><div style="width:10px;height:10px;border-radius:50%;background:#28c840;"></div></div>
    <div style="flex:1;max-width:280px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:6px;height:24px;display:flex;align-items:center;padding:0 10px;gap:4px;">
      <span style="font-size:10px;color:rgba(255,255,255,0.3);">🔒</span><span style="font-size:11px;color:rgba(255,255,255,0.4);">${dom || 'exemplo.com'}</span>
    </div>
  </div>
  <div style="height:1420px;overflow:hidden;background:#fff;"><img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;"></div>
</div>
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
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

  // 19. hero-section — Landing page hero (dramatic dark background)
  'hero-section': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:#0d0d0d;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 30%,rgba(255,255,255,0.04) 0%,transparent 70%);pointer-events:none;"></div>
<div style="transform:rotate(-1deg);position:relative;z-index:2;border-radius:10px;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,0.9),0 0 80px rgba(255,255,255,0.03);">
  <img src="${img}" style="width:800px;height:1420px;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#0d0d0d;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 30%,rgba(255,255,255,0.04) 0%,transparent 70%);pointer-events:none;"></div>
<div style="transform:rotate(-1deg);position:relative;z-index:2;border-radius:10px;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,0.8),0 0 80px rgba(255,255,255,0.03);">
  <img src="${img}" style="width:2160px;height:1340px;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // 20. landing-highlight — SaaS landing
  'landing-highlight': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:linear-gradient(180deg,#0f172a 0%,#1e293b 100%);position:relative;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;}</style></head><body>
<div style="position:absolute;top:40px;left:50%;transform:translateX(-50%);background:rgba(250,204,21,0.12);border:1px solid rgba(250,204,21,0.3);border-radius:999px;padding:6px 16px;font-size:11px;font-weight:600;color:#fbbf24;letter-spacing:0.04em;">✦ NOVO PRODUTO</div>
<div style="border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);box-shadow:0 32px 100px rgba(0,0,0,0.7);margin-top:60px;">
  <div style="height:28px;background:#1e293b;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;padding:0 10px;gap:6px;">
    <div style="display:flex;gap:4px;"><div style="width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.1);"></div><div style="width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.1);"></div><div style="width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.1);"></div></div>
    <div style="flex:1;background:rgba(255,255,255,0.05);border-radius:4px;height:14px;"></div>
  </div>
  <img src="${img}" style="width:820px;height:1340px;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
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

  // 18. gradient-premium — Premium gradient background
  'gradient-premium': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:#1a1a2e;background-image:radial-gradient(at 0% 0%,#ff6b6b 0%,transparent 50%),radial-gradient(at 100% 0%,#4ecdc4 0%,transparent 50%),radial-gradient(at 100% 100%,#45b7d1 0%,transparent 50%),radial-gradient(at 0% 100%,#96ceb4 0%,transparent 50%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:800px;height:1420px;object-fit:cover;object-position:top center;display:block;border:2px solid rgba(255,255,255,0.9);border-radius:10px;box-shadow:0 25px 80px rgba(0,0,0,0.5),0 8px 24px rgba(0,0,0,0.3);">
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1600px;overflow:hidden;background:#1a1a2e;background-image:radial-gradient(at 0% 0%,#ff6b6b 0%,transparent 50%),radial-gradient(at 100% 0%,#4ecdc4 0%,transparent 50%),radial-gradient(at 100% 100%,#45b7d1 0%,transparent 50%),radial-gradient(at 0% 100%,#96ceb4 0%,transparent 50%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<img src="${img}" style="width:2160px;height:1360px;object-fit:cover;object-position:top center;display:block;border:2px solid rgba(255,255,255,0.9);border-radius:12px;box-shadow:0 25px 80px rgba(0,0,0,0.5),0 8px 24px rgba(0,0,0,0.3);">
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1600, deviceScaleFactor: 2 } };
  },

  // ── 12 NEW TEMPLATES (v2 expansion) ──────────────────────────────────────

  // 21. paper-note — Screenshot como nota de papel com textura e sombra natural
  'paper-note': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const W = deviceType === 'mobile' ? 900 : 2400;
    const H = deviceType === 'mobile' ? 1600 : 1600;
    const imgW = deviceType === 'mobile' ? 780 : 2100;
    const imgH = deviceType === 'mobile' ? 1400 : 1340;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#f0ebe0;background-image:radial-gradient(ellipse at 50% 50%,#f7f2e6 0%,#e8dfc8 100%);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="width:${imgW}px;height:${imgH}px;background:#fffdf7;padding:24px;border-radius:2px;box-shadow:0 30px 60px rgba(80,60,30,0.18),0 10px 20px rgba(80,60,30,0.10),inset 0 0 60px rgba(180,150,90,0.04);transform:rotate(-0.4deg);">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: W, height: H, deviceScaleFactor: 2 } };
  },

  // 22. neon-glow — Glow neon vibrante ao redor do screenshot, fundo preto
  'neon-glow': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const W = deviceType === 'mobile' ? 900 : 2400;
    const H = deviceType === 'mobile' ? 1600 : 1600;
    const imgW = deviceType === 'mobile' ? 780 : 2100;
    const imgH = deviceType === 'mobile' ? 1380 : 1340;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#050014;display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="width:${imgW}px;height:${imgH}px;border-radius:12px;box-shadow:0 0 60px #b026ff,0 0 120px rgba(176,38,255,0.6),0 0 180px rgba(0,200,255,0.4),inset 0 0 2px rgba(255,255,255,0.3);border:2px solid rgba(176,38,255,0.8);overflow:hidden;">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: W, height: H, deviceScaleFactor: 2 } };
  },

  // 23. instagram-carousel — 3 cards empilhados simulando swipe de carousel
  'instagram-carousel': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1080px;height:1350px;overflow:hidden;background:#fafafa;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}.card{position:absolute;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.15);}</style></head><body>
<div style="position:absolute;top:40px;right:40px;background:rgba(0,0,0,0.6);color:#fff;padding:6px 12px;border-radius:14px;font-size:14px;font-weight:600;">1/3</div>
<div class="card" style="width:880px;height:1100px;top:125px;left:100px;transform:rotate(-4deg) translateX(-40px);opacity:0.35;"><div style="width:100%;height:100%;background:linear-gradient(135deg,#667eea,#764ba2);"></div></div>
<div class="card" style="width:880px;height:1100px;top:125px;left:100px;transform:rotate(-2deg) translateX(-20px);opacity:0.6;"><div style="width:100%;height:100%;background:linear-gradient(135deg,#f093fb,#f5576c);"></div></div>
<div class="card" style="width:880px;height:1100px;top:125px;left:100px;">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
<div style="position:absolute;bottom:50px;left:50%;transform:translateX(-50%);display:flex;gap:8px;">
  <div style="width:10px;height:10px;border-radius:50%;background:#0095f6;"></div>
  <div style="width:10px;height:10px;border-radius:50%;background:rgba(0,0,0,0.2);"></div>
  <div style="width:10px;height:10px;border-radius:50%;background:rgba(0,0,0,0.2);"></div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1080, height: 1350, deviceScaleFactor: 2 } };
  },

  // 24. tiktok-mockup — Interface TikTok vertical com action bar lateral
  'tiktok-mockup': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1080px;height:1920px;overflow:hidden;background:#000;position:relative;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#fff;}</style></head><body>
<img src="${img}" style="position:absolute;top:0;left:0;width:1080px;height:1920px;object-fit:cover;object-position:top center;display:block;filter:brightness(0.88);">
<div style="position:absolute;top:0;left:0;right:0;height:320px;background:linear-gradient(180deg,rgba(0,0,0,0.6),transparent);"></div>
<div style="position:absolute;bottom:0;left:0;right:0;height:480px;background:linear-gradient(0deg,rgba(0,0,0,0.7),transparent);"></div>
<div style="position:absolute;top:80px;left:50%;transform:translateX(-50%);display:flex;gap:60px;font-size:30px;font-weight:600;">
  <span style="opacity:0.55;">Seguindo</span>
  <span style="border-bottom:3px solid #fff;padding-bottom:4px;">Para Você</span>
</div>
<div style="position:absolute;right:32px;bottom:260px;display:flex;flex-direction:column;gap:34px;align-items:center;">
  <div style="display:flex;flex-direction:column;align-items:center;gap:6px;"><div style="width:90px;height:90px;border-radius:50%;border:3px solid #fff;background:linear-gradient(135deg,#25f4ee,#fe2c55);"></div></div>
  <div style="display:flex;flex-direction:column;align-items:center;gap:6px;"><svg width="68" height="68" viewBox="0 0 24 24" fill="#fff"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg><span style="font-size:22px;font-weight:600;">128.4K</span></div>
  <div style="display:flex;flex-direction:column;align-items:center;gap:6px;"><svg width="64" height="64" viewBox="0 0 24 24" fill="#fff"><path d="M21.99 4c0-1.1-.89-2-1.99-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4-.01-18z"/></svg><span style="font-size:22px;font-weight:600;">2,847</span></div>
  <div style="display:flex;flex-direction:column;align-items:center;gap:6px;"><svg width="64" height="64" viewBox="0 0 24 24" fill="#fff"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/></svg><span style="font-size:22px;font-weight:600;">Share</span></div>
</div>
<div style="position:absolute;left:40px;bottom:120px;right:200px;">
  <div style="font-size:34px;font-weight:700;margin-bottom:10px;">@your_brand</div>
  <div style="font-size:26px;font-weight:400;line-height:1.35;">Check this out 🔥 #viral #tech</div>
  <div style="display:flex;align-items:center;gap:10px;margin-top:16px;font-size:22px;opacity:0.9;"><svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg> som original · your_brand</div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1080, height: 1920, deviceScaleFactor: 2 } };
  },

  // 25. youtube-thumbnail — Thumbnail de vídeo YouTube 16:9 com CTA
  'youtube-thumbnail': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1280px;height:720px;overflow:hidden;background:#0d0d0d;position:relative;font-family:'Impact','Arial Black',sans-serif;}</style></head><body>
<img src="${img}" style="position:absolute;right:0;top:0;width:720px;height:720px;object-fit:cover;object-position:top center;display:block;">
<div style="position:absolute;left:0;top:0;bottom:0;width:600px;background:linear-gradient(135deg,#ff0000,#cc0000);padding:70px 50px;display:flex;flex-direction:column;justify-content:center;color:#fff;">
  <div style="font-size:28px;font-weight:700;letter-spacing:6px;color:#ffeb3b;margin-bottom:18px;">ASSISTA AGORA</div>
  <div style="font-size:96px;font-weight:900;line-height:0.95;text-shadow:6px 6px 0 #000;text-transform:uppercase;">A VERDADE que ninguém te contou</div>
</div>
<div style="position:absolute;bottom:32px;right:40px;background:#000;color:#fff;padding:8px 16px;border-radius:4px;font-size:22px;font-weight:700;">10:42</div>
<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:130px;height:130px;background:rgba(0,0,0,0.75);border:5px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;"><div style="width:0;height:0;border-left:38px solid #fff;border-top:24px solid transparent;border-bottom:24px solid transparent;margin-left:10px;"></div></div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1280, height: 720, deviceScaleFactor: 2 } };
  },

  // 26. presentation-slide — Slide 16:9 estilo keynote: título + screenshot
  'presentation-slide': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const domain = getDomain((options && options.url) || '');
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:linear-gradient(180deg,#0f172a,#1e293b);position:relative;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#fff;}</style></head><body>
<div style="padding:80px 70px 40px;">
  <div style="font-size:22px;letter-spacing:4px;color:#60a5fa;margin-bottom:16px;">APRESENTAÇÃO</div>
  <div style="font-size:72px;font-weight:700;line-height:1.1;margin-bottom:18px;">O produto, de um<br/>olhar rápido.</div>
  <div style="font-size:24px;color:rgba(255,255,255,0.6);">${domain || 'snapdeck.pro'}</div>
</div>
<div style="position:absolute;bottom:60px;left:70px;right:70px;height:1000px;border-radius:10px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,0.7);">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1350px;overflow:hidden;background:linear-gradient(135deg,#0f172a,#1e293b);position:relative;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#fff;}</style></head><body>
<div style="position:absolute;left:0;top:0;bottom:0;width:900px;padding:160px 100px 100px;display:flex;flex-direction:column;justify-content:center;">
  <div style="font-size:28px;letter-spacing:6px;color:#60a5fa;margin-bottom:28px;font-weight:600;">APRESENTAÇÃO</div>
  <div style="font-size:96px;font-weight:700;line-height:1.05;margin-bottom:32px;">O produto,<br/>de um olhar<br/>rápido.</div>
  <div style="font-size:32px;color:rgba(255,255,255,0.55);font-weight:400;">${domain || 'snapdeck.pro'}</div>
</div>
<div style="position:absolute;right:100px;top:100px;bottom:100px;width:1360px;border-radius:14px;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,0.7),0 12px 32px rgba(0,0,0,0.4);">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1350, deviceScaleFactor: 2 } };
  },

  // 27. document-report — Página A4 portrait com cabeçalho e rodapé corporativo
  'document-report': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const domain = getDomain((options && options.url) || '');
    const date = getFormattedDate();
    const W = deviceType === 'mobile' ? 900 : 1700;
    const H = deviceType === 'mobile' ? 1600 : 2200;
    const bodyPad = deviceType === 'mobile' ? 50 : 120;
    const imgH = deviceType === 'mobile' ? 900 : 1450;
    const titleSize = deviceType === 'mobile' ? 36 : 54;
    const smallSize = deviceType === 'mobile' ? 16 : 20;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#fbfbf9;position:relative;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;}</style></head><body>
<div style="padding:${bodyPad}px ${bodyPad}px 30px;border-bottom:2px solid #1a1a1a;display:flex;justify-content:space-between;align-items:center;">
  <div>
    <div style="font-size:${smallSize}px;letter-spacing:4px;color:#666;font-family:Arial,sans-serif;">RELATÓRIO</div>
    <div style="font-size:${titleSize}px;font-weight:700;margin-top:8px;">${domain || 'snapdeck.pro'}</div>
  </div>
  <div style="text-align:right;font-size:${smallSize}px;color:#666;font-family:Arial,sans-serif;">${date}</div>
</div>
<div style="padding:${bodyPad/2}px ${bodyPad}px;">
  <div style="width:100%;height:${imgH}px;border:1px solid #e5e5e0;border-radius:3px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.06);">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
  <div style="margin-top:24px;font-size:${smallSize}px;color:#555;font-style:italic;">Figura 1 — Captura de tela de ${domain || 'snapdeck.pro'}</div>
</div>
<div style="position:absolute;bottom:${bodyPad/2}px;left:${bodyPad}px;right:${bodyPad}px;padding-top:20px;border-top:1px solid #c4c4be;display:flex;justify-content:space-between;font-size:${smallSize-2}px;color:#888;font-family:Arial,sans-serif;">
  <span>Gerado por snapdeck.pro</span>
  <span>Página 1</span>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: W, height: H, deviceScaleFactor: 2 } };
  },

  // 28. annotated-capture — Screenshot com 3 callouts numerados
  'annotated-capture': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const W = deviceType === 'mobile' ? 900 : 2400;
    const H = deviceType === 'mobile' ? 1600 : 1600;
    const imgW = deviceType === 'mobile' ? 780 : 2000;
    const imgH = deviceType === 'mobile' ? 1380 : 1340;
    const badgeSize = deviceType === 'mobile' ? 52 : 78;
    const badgeFont = deviceType === 'mobile' ? 26 : 38;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#fafaf7;display:flex;align-items:center;justify-content:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}.badge{position:absolute;width:${badgeSize}px;height:${badgeSize}px;border-radius:50%;background:#ef4444;color:#fff;display:flex;align-items:center;justify-content:center;font-size:${badgeFont}px;font-weight:700;box-shadow:0 4px 12px rgba(239,68,68,0.4),0 0 0 4px #fff;z-index:2;}</style></head><body>
<div style="position:relative;width:${imgW}px;height:${imgH}px;border-radius:8px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.15);">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
<div class="badge" style="top:${H*0.15}px;left:${(W-imgW)/2 + imgW*0.12}px;">1</div>
<div class="badge" style="top:${H*0.35}px;right:${(W-imgW)/2 + imgW*0.10}px;">2</div>
<div class="badge" style="bottom:${H*0.20}px;left:${(W-imgW)/2 + imgW*0.40}px;">3</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: W, height: H, deviceScaleFactor: 2 } };
  },

  // 29. ipad-landscape — iPad Pro horizontal com borda fina
  'ipad-landscape': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    if (deviceType === 'mobile') {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1600px;overflow:hidden;background:radial-gradient(ellipse at center,#2a2a2a,#0a0a0a);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="width:820px;height:600px;background:#1a1a1a;border-radius:24px;padding:22px;box-shadow:0 30px 80px rgba(0,0,0,0.6);">
  <div style="width:100%;height:100%;background:#000;border-radius:6px;overflow:hidden;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
</div>
${wm}</body></html>`;
      return { html, renderConfig: { width: 900, height: 1600, deviceScaleFactor: 2 } };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:2400px;height:1700px;overflow:hidden;background:radial-gradient(ellipse at center,#2a2a2a,#0a0a0a);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="width:2100px;height:1480px;background:linear-gradient(180deg,#2a2a2a,#1a1a1a);border-radius:34px;padding:34px;box-shadow:0 40px 120px rgba(0,0,0,0.6),inset 0 1px 0 rgba(255,255,255,0.05);">
  <div style="width:100%;height:100%;background:#000;border-radius:12px;overflow:hidden;position:relative;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
  </div>
</div>
<div style="position:absolute;right:60px;top:50%;transform:translateY(-50%) rotate(8deg);width:14px;height:380px;background:linear-gradient(180deg,#d4d4d4,#9a9a9a);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.4);opacity:0.85;"></div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 2400, height: 1700, deviceScaleFactor: 2 } };
  },

  // 30. android-phone — Pixel 8 Pro portrait
  'android-phone': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:900px;height:1900px;overflow:hidden;background:radial-gradient(ellipse at center,#1e293b,#0a0f1c);display:flex;align-items:center;justify-content:center;position:relative;}</style></head><body>
<div style="width:740px;height:1620px;background:linear-gradient(135deg,#2c2c2c,#1a1a1a);border-radius:56px;padding:16px;box-shadow:0 40px 120px rgba(0,0,0,0.7);position:relative;">
  <div style="width:100%;height:100%;background:#000;border-radius:42px;overflow:hidden;position:relative;">
    <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
    <div style="position:absolute;top:18px;left:50%;transform:translateX(-50%);width:28px;height:28px;border-radius:50%;background:#000;border:2px solid rgba(255,255,255,0.08);"></div>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 900, height: 1900, deviceScaleFactor: 2 } };
  },

  // 31. product-hunt — Card estilo Product Hunt com badge #1
  'product-hunt': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const domain = getDomain((options && options.url) || '');
    const W = deviceType === 'mobile' ? 900 : 2400;
    const H = deviceType === 'mobile' ? 1600 : 1600;
    const pad = deviceType === 'mobile' ? 40 : 120;
    const imgW = deviceType === 'mobile' ? 820 : 1560;
    const imgH = deviceType === 'mobile' ? 1000 : 1160;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#fff6f2;position:relative;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a1a;}</style></head><body>
<div style="padding:${pad}px;height:100%;display:flex;${deviceType==='mobile'?'flex-direction:column;':'align-items:center;'}gap:${deviceType==='mobile'?30:80}px;">
  <div style="${deviceType==='mobile'?'width:100%;':'flex:1;'}display:flex;flex-direction:column;${deviceType==='mobile'?'align-items:center;text-align:center;':'justify-content:center;'}">
    <div style="display:inline-flex;align-items:center;gap:10px;background:#da552f;color:#fff;padding:${deviceType==='mobile'?'8px 16px':'12px 24px'};border-radius:8px;font-weight:700;font-size:${deviceType==='mobile'?18:26}px;margin-bottom:28px;align-self:flex-start;${deviceType==='mobile'?'align-self:center;':''}">
      <span>▲</span> #1 Product of the Day
    </div>
    <div style="font-size:${deviceType==='mobile'?54:96}px;font-weight:800;line-height:1.02;margin-bottom:24px;">${domain || 'snapdeck.pro'}</div>
    <div style="font-size:${deviceType==='mobile'?22:32}px;color:#555;line-height:1.35;margin-bottom:36px;max-width:${deviceType==='mobile'?700:700}px;">A ferramenta que a comunidade adorou — capturas profissionais em segundos.</div>
    <div style="display:flex;align-items:center;gap:20px;">
      <div style="width:${deviceType==='mobile'?70:96}px;height:${deviceType==='mobile'?70:96}px;background:#da552f;border-radius:12px;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:800;">
        <div style="font-size:${deviceType==='mobile'?18:24}px;line-height:1;">▲</div>
        <div style="font-size:${deviceType==='mobile'?18:26}px;line-height:1.1;margin-top:2px;">2.4K</div>
      </div>
      <div style="color:#555;font-size:${deviceType==='mobile'?18:24}px;">upvotes hoje</div>
    </div>
  </div>
  <div style="${deviceType==='mobile'?'width:100%;':'flex:1.1;'}display:flex;align-items:center;justify-content:center;">
    <div style="width:${imgW}px;height:${imgH}px;border-radius:10px;overflow:hidden;box-shadow:0 30px 80px rgba(218,85,47,0.18),0 10px 30px rgba(0,0,0,0.10);border:1px solid #f3e3dc;">
      <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
    </div>
  </div>
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: W, height: H, deviceScaleFactor: 2 } };
  },

  // 32. ad-banner — Banner Google Ads 1200×628 com CTA
  'ad-banner': async (screenshotPath, deviceType, options) => {
    const img = screenshotToBase64(screenshotPath);
    const wm  = getWatermarkHtml(options);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box;}html,body{width:1200px;height:628px;overflow:hidden;background:linear-gradient(135deg,#6366f1,#8b5cf6 50%,#ec4899);position:relative;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#fff;}</style></head><body>
<div style="position:absolute;left:50px;top:0;bottom:0;width:520px;display:flex;flex-direction:column;justify-content:center;padding:50px 0;">
  <div style="font-size:18px;letter-spacing:3px;font-weight:600;color:rgba(255,255,255,0.85);margin-bottom:14px;text-transform:uppercase;">Lançamento</div>
  <div style="font-size:52px;font-weight:800;line-height:1.05;margin-bottom:18px;">Capturas que convertem.</div>
  <div style="font-size:20px;line-height:1.4;color:rgba(255,255,255,0.85);margin-bottom:30px;">Tire screenshots profissionais em segundos — sem Figma, sem Photoshop.</div>
  <div style="display:inline-flex;background:#fff;color:#6366f1;padding:16px 30px;border-radius:10px;font-weight:700;font-size:20px;align-self:flex-start;box-shadow:0 8px 24px rgba(0,0,0,0.25);">Experimente grátis →</div>
</div>
<div style="position:absolute;right:50px;top:50%;transform:translateY(-50%) rotate(-3deg);width:560px;height:480px;border-radius:10px;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,0.4);border:3px solid rgba(255,255,255,0.3);">
  <img src="${img}" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block;">
</div>
${wm}</body></html>`;
    return { html, renderConfig: { width: 1200, height: 628, deviceScaleFactor: 2 } };
  },

};

// ── Section 3: Main render function (returns Buffer) ─────────────────────────

// Legacy template IDs → new IDs
const LEGACY_MAP = {
  // Active aliases
  'browser':           'browser-clean',
  'browser-light':     'browser-clean',
  'iphone':            'iphone-pro',
  'iphone-15':         'iphone-pro',
  'macbook-pro':       'macbook-realistic',
  // Eliminated templates → best equivalent
  'presentation':      'presentation-slide',
  'slide':             'presentation-slide',
  'pitch-deck':        'presentation-slide',
  'proposal-clean':    'minimal-clean',
  'case-study':        'minimal-clean',
  'portfolio-showcase':'default-dark',
  'corporate-clean':   'browser-premium',
  'social-basic':      'shadow-soft',
  'mobile-simple':     'dark-frame',
  'carousel-post':     'instagram-post',
  'ad-style':          'shadow-soft',
  'viral-frame':       'default-dark',
  'comparison-before-after': 'default-dark',
  'spotlight-product': 'gradient-premium',
  'feature-showcase':  'shadow-soft',
  // Legacy aliases
  'og-image':          'default-dark',
  'twitter-card':      'default-dark',
  'linkedin-banner':   'linkedin-post',
  'whatsapp-preview':  'whatsapp-share',
  'ocean':             'gradient-premium',
  'duotone':           'gradient-premium',
  'isometric':         'gradient-basic',
  'diorama':           'gradient-basic',
  'vaporwave':         'gradient-premium',
  'filmstrip':         'gradient-premium',
  'ipad':              'macbook-clean',
  'watch':             'iphone-dark',
  'magazine':          'minimal-clean',
  'report':            'minimal-clean',
};

async function renderTemplate(templateId, screenshotPath, deviceType, options) {
  options = options || {};
  const resolvedId = LEGACY_MAP[templateId] || templateId;

  // Each template handles deviceType internally — no generic phone frame wrapper
  if (!templateRenderers[resolvedId]) {
    console.warn(`[renderer] template "${resolvedId}" não encontrado — usando browser-clean`);
  }
  const renderFn = templateRenderers[resolvedId] || templateRenderers['browser-clean'];

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
  // [FIX-10] Fallback para browser-clean (era default-dark — agora consistente com renderTemplate)
  const resolvedTemplateId = templateId || (renderConfig && renderConfig.template) || 'browser-clean';
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
  const resolvedTemplateId = templateId || (renderConfig && renderConfig.template) || 'browser-clean';
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
};
