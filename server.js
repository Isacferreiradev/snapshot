'use strict';

require('dotenv').config();

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const http     = require('http');
const https    = require('https');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');

const {
  createJob, markPaid, markDownloaded, markReady, markFailed,
  updateCrawlResult, updateSelectedPages, updateRenderConfig,
  updateCaptureProgress, setCompareMode, appendCrawlLog, addGalleryItem,
  isPaid, jobExists, getJob, getJobByShareToken,
  incrementCounter, getCounter,
} = require('./jobs');

const { crawlSite }          = require('./crawler');
const { captureJobPages, captureComparison } = require('./screenshotter');
const {
  validateSubscription,
  incrementCaptures,
  isSubscriptionActive,
  getCodeBySession,
} = require('./subscriptions');
const { createCheckoutSession, handleWebhook, getPlans } = require('./stripe');
const { generateSubscriptionCode } = require('./subscriptions');

const app  = express();
const PORT = process.env.PORT || 3001;
const SS   = path.join(__dirname, 'screenshots');

fs.mkdirSync(SS, { recursive: true });
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

// ── Rate limiter (10 req / 60s por IP) ───────────────────────────────────────
const rateLimitStore = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT     = 10;

function rateLimiter(req, res, next) {
  const ip  = clientIp(req);
  const now = Date.now();
  let entry = rateLimitStore.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimitStore.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde um momento.' });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimitStore) if (now >= e.resetAt) rateLimitStore.delete(ip);
}, 5 * 60 * 1000);

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

// ── Webhook ANTES do express.json() ──────────────────────────────────────────
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'Missing signature.' });
  try {
    const result = handleWebhook(req.body, sig);
    if (result) {
      console.log(`[webhook] ${result.event}:`, result.stripeSubscriptionId || result.sessionId);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[webhook] error:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SS));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => res.json({ total: getCounter() }));

// ── Planos ────────────────────────────────────────────────────────────────────
app.get('/api/plans', (_req, res) => res.json({ plans: getPlans() }));

// Compat: /api/packages → /api/plans
app.get('/api/packages', (_req, res) => res.json({ packages: getPlans() }));

// ── Validar código de assinatura ─────────────────────────────────────────────
app.post('/api/validate-code', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ valid: false, reason: 'Código obrigatório.' });
  const result = validateSubscription(code);
  if (!result.valid) return res.status(400).json(result);
  return res.json({
    valid: true,
    info:  { plan: result.plan, remaining: result.capturesRemaining, isWatermarked: false },
  });
});

// ── Buscar código pelo Checkout Session ID (página pós-pagamento) ─────────────
app.get('/api/subscription-code', (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id obrigatório.' });
  const code = getCodeBySession(session_id);
  if (!code) return res.status(404).json({ error: 'Código não encontrado ainda. Aguarde alguns segundos e tente novamente.' });
  return res.json({ code });
});

// ── Validate URL ──────────────────────────────────────────────────────────────
app.post('/api/validate-url', (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'URL obrigatória.' });
  const t = url.trim();
  if (!t.startsWith('http://') && !t.startsWith('https://')) return res.status(400).json({ ok: false, error: 'URL deve começar com http:// ou https://' });
  let parsed;
  try { parsed = new URL(t); } catch { return res.status(400).json({ ok: false, error: 'Formato de URL inválido.' }); }

  const lib    = parsed.protocol === 'https:' ? https : http;
  const reqOut = lib.request({ method: 'HEAD', hostname: parsed.hostname, path: parsed.pathname + parsed.search, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 SnapShot-Validator/1.0' } }, rsp => {
    const ok = rsp.statusCode < 400 || rsp.statusCode === 405;
    res.json({ ok, statusCode: rsp.statusCode });
  });
  reqOut.on('timeout', () => { reqOut.destroy(); res.json({ ok: false, error: 'Tempo limite ao verificar URL.' }); });
  reqOut.on('error',   err => res.json({ ok: false, error: err.message }));
  reqOut.end();
});

// ── POST /api/crawl ───────────────────────────────────────────────────────────
// Crawl é sempre gratuito. Marca d'água é determinada pelo código de assinatura.
app.post('/api/crawl', rateLimiter, (req, res) => {
  const { url, subscriptionCode, accessCode } = req.body || {};
  // Accept both field names for compat
  const code = subscriptionCode || accessCode || null;

  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL obrigatória.' });
  const t = url.trim();
  if (!t.startsWith('http://') && !t.startsWith('https://')) return res.status(400).json({ error: 'URL deve começar com http:// ou https://' });
  if (t.length > 500) return res.status(400).json({ error: 'URL muito longa.' });

  // Validar código se fornecido (não bloqueante — apenas para flag de watermark)
  let validatedCode = null;
  if (code) {
    const cv = validateSubscription(code);
    if (cv.valid) validatedCode = code.trim().toUpperCase();
  }

  const jobId = uuidv4();
  createJob(jobId, { subscriptionCode: validatedCode });

  (async () => {
    try {
      appendCrawlLog(jobId, 'Iniciando exploração do site…');
      const pages = await crawlSite(t, jobId);
      appendCrawlLog(jobId, `Exploração concluída — ${pages.length} página(s) encontrada(s).`);
      updateCrawlResult(jobId, pages);
    } catch (err) {
      appendCrawlLog(jobId, `Erro: ${err.message}`);
      markFailed(jobId, err.message || 'Não foi possível explorar este site.');
    }
  })();

  return res.status(202).json({ jobId, status: 'crawling' });
});

// ── GET /api/crawl-status/:jobId ──────────────────────────────────────────────
app.get('/api/crawl-status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.status === 'crawling') return res.json({ status: 'crawling', pages: [] });
  if (job.status === 'failed')   return res.json({ status: 'failed', error: job.failReason || 'Erro ao explorar o site.' });
  return res.json({ status: job.status, pages: job.pages });
});

// ── GET /api/crawl-stream/:jobId — SSE ───────────────────────────────────────
app.get('/api/crawl-stream/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) { res.status(404).end(); return; }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  let lastIdx = 0;
  const send  = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const flush = () => {
    const fresh = job.crawlLog.slice(lastIdx);
    fresh.forEach(entry => send(entry));
    lastIdx += fresh.length;
  };

  flush();

  const terminal = ['selecting', 'failed', 'configuring', 'capturing', 'ready', 'downloaded'];
  const interval = setInterval(() => {
    const j = getJob(req.params.jobId);
    if (!j) { clearInterval(interval); send({ done: true }); res.end(); return; }
    flush();
    if (terminal.includes(j.status)) {
      send({ done: true, status: j.status, pages: j.pages });
      clearInterval(interval);
      res.end();
    }
  }, 300);

  req.on('close', () => clearInterval(interval));
});

// ── POST /api/select-pages ────────────────────────────────────────────────────
app.post('/api/select-pages', (req, res) => {
  const { jobId, selectedUrls } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId obrigatório.' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (!Array.isArray(selectedUrls) || selectedUrls.length === 0) return res.status(400).json({ error: 'Selecione ao menos uma página.' });
  if (selectedUrls.length > 12) return res.status(400).json({ error: 'Máximo de 12 páginas.' });
  const discovered = new Set(job.pages.map(p => p.url));
  for (const u of selectedUrls) {
    if (!discovered.has(u)) return res.status(400).json({ error: `URL desconhecida: ${u}` });
  }
  updateSelectedPages(jobId, selectedUrls);
  return res.json({ jobId, status: 'configuring' });
});

// ── POST /api/start-capture ───────────────────────────────────────────────────
app.post('/api/start-capture', (req, res) => {
  const { jobId, renderConfig } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId obrigatório.' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.status !== 'configuring') return res.status(409).json({ error: `Status inesperado: ${job.status}` });

  const cfg = renderConfig || {};
  updateRenderConfig(jobId, cfg);

  // Determinar applyWatermark com base no código de assinatura do job
  const subCode       = job.subscriptionCode || null;
  const subValid      = subCode ? validateSubscription(subCode) : null;
  const applyWatermark = !(subValid && subValid.valid);
  job.applyWatermark   = applyWatermark;

  console.log(`[capture] job ${jobId} — watermark: ${applyWatermark}, code: ${subCode || 'none'}`);

  const pages = job.selectedPages;
  updateCaptureProgress(jobId, { total: pages.length, completed: 0, current: 'Preparando captura…', percent: 0 });

  (async () => {
    let completedCount = 0;
    try {
      await captureJobPages(pages, jobId, cfg, (i, result, err) => {
        const pageUrl = pages[i];
        const pageObj = job.pages.find(p => p.url === pageUrl) || {};
        completedCount++;

        if (result) {
          addGalleryItem(jobId, {
            index:      i,
            url:        pageUrl,
            title:      result.pageTitle || pageUrl,
            previewUrl: `/screenshots/${jobId}/page-${String(i).padStart(2, '0')}/preview.png`,
          });
          console.log(`[capture] ✓ página ${i}: ${pageUrl}`);
        } else {
          console.error(`[capture] ✗ página ${i}: ${pageUrl} — ${err ? err.message : 'unknown'}`);
        }

        // Atualiza progresso IMEDIATAMENTE após cada página (bug fix)
        updateCaptureProgress(jobId, {
          completed: completedCount,
          current:   pageObj.title || pageUrl,
          total:     pages.length,
          percent:   Math.round((completedCount / pages.length) * 100),
        });
        incrementCounter();
      }, applyWatermark);

      // Incrementar contagem de capturas no plano (se tiver código válido)
      if (subCode && subValid && subValid.valid) {
        for (let i = 0; i < completedCount; i++) incrementCaptures(subCode);
      }
    } catch (err) {
      console.error('[capture] captureJobPages erro:', err.message);
    }
    console.log(`[capture] job ${jobId} concluído — ${completedCount}/${pages.length}`);
    markReady(jobId);
  })();

  return res.status(202).json({ jobId, status: 'capturing' });
});

// ── GET /api/capture-progress/:jobId ─────────────────────────────────────────
app.get('/api/capture-progress/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  return res.json({
    status:          job.status,
    captureProgress: job.captureProgress,
    gallery:         job.gallery || [],
    applyWatermark:  job.applyWatermark !== undefined ? job.applyWatermark : true,
  });
});

// ── POST /api/compare ─────────────────────────────────────────────────────────
app.post('/api/compare', (req, res) => {
  const { url1, url2, renderConfig } = req.body || {};
  if (!url1 || !url2) return res.status(400).json({ error: 'url1 e url2 são obrigatórios.' });
  for (const u of [url1, url2]) {
    if (!u.startsWith('http://') && !u.startsWith('https://')) return res.status(400).json({ error: 'URLs devem começar com http:// ou https://' });
  }

  const jobId = uuidv4();
  createJob(jobId);
  setCompareMode(jobId, [url1, url2]);
  const cfg = renderConfig || {};
  updateRenderConfig(jobId, cfg);

  (async () => {
    updateCaptureProgress(jobId, { current: 'Capturando primeira URL…' });
    try {
      await captureComparison(url1, url2, jobId, cfg);
      updateCaptureProgress(jobId, { completed: 2, percent: 100 });
      incrementCounter();
      markReady(jobId);
    } catch {
      markReady(jobId);
    }
  })();

  return res.status(202).json({ jobId, status: 'capturing' });
});

// ── POST /api/checkout — iniciar assinatura Stripe ────────────────────────────
app.post('/api/checkout', async (req, res) => {
  const { plan } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'Plano obrigatório.' });
  try {
    const checkoutUrl = await createCheckoutSession(plan);
    return res.json({ checkoutUrl });
  } catch (err) {
    console.error('[checkout] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/create-checkout (compat — determina se precisa upgrade) ─────────
// Usado pelo frontend quando clica em "Baixar agora"
app.post('/api/create-checkout', (req, res) => {
  const { jobId, withWatermark } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId obrigatório.' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.status !== 'ready') return res.status(409).json({ error: 'Captura ainda em andamento.' });

  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;

  // Se pediu download com marca d'água (free) OU já capturou sem marca d'água
  if (withWatermark || !job.applyWatermark) {
    markPaid(jobId);
    return res.json({ checkoutUrl: `${baseUrl}/?success=true&jobId=${jobId}` });
  }

  // Tem marca d'água e usuário quer remover → precisa de plano
  return res.json({
    requiresUpgrade: true,
    plans:           getPlans(),
    // Usuário pode também baixar com marca d'água
    watermarkUrl:    `/api/download/${jobId}`,
  });
});

// ── GET /api/share-token/:jobId ───────────────────────────────────────────────
app.get('/api/share-token/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (!job.shareToken) return res.status(404).json({ error: 'Token não disponível.' });
  return res.json({ token: job.shareToken });
});

// ── GET /api/download/:jobId ──────────────────────────────────────────────────
// Sem paywall — imagens já têm ou não têm watermark queimada pelo renderer
app.get('/api/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job)   return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.status !== 'ready' && job.status !== 'paid' && job.status !== 'downloaded')
    return res.status(409).json({ error: 'Captura ainda em andamento.' });

  const jobDir = path.join(SS, jobId);
  if (!fs.existsSync(jobDir)) return res.status(410).json({ error: 'Arquivos expirados ou já baixados anteriormente.' });

  const domainName = (() => {
    try {
      const u = job.compareMode ? job.compareUrls[0] : job.selectedPages[0];
      return new URL(u).hostname.replace('www.', '');
    } catch { return 'snapshot'; }
  })();
  const dateTag = new Date().toISOString().slice(0, 10);
  const tmpl    = (job.renderConfig && job.renderConfig.template) || 'void';
  const rootDir = `${domainName}-${dateTag}-${tmpl}`;

  res.setHeader('Content-Type',        'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${rootDir}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('error', err => {
    console.error('[zip] archive error:', err);
    if (!res.headersSent) res.status(500).end();
  });

  // BUGFIX: usar 'close' (não 'finish') para cleanup após o stream fechar
  archive.on('close', () => {
    console.log(`[zip] concluído — ${archive.pointer()} bytes`);
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    markDownloaded(jobId);
  });

  archive.pipe(res);

  if (job.compareMode) {
    const cDir  = path.join(jobDir, 'compare');
    const addIf = (f, n) => {
      if (fs.existsSync(f)) { archive.file(f, { name: n }); }
      else { console.error(`[zip] ARQUIVO FALTANDO: ${f}`); }
    };
    addIf(path.join(cDir, 'comparison.png'),             `${rootDir}/comparison.png`);
    addIf(path.join(cDir, 'desktop-1-professional.png'), `${rootDir}/page-1-desktop.png`);
    addIf(path.join(cDir, 'desktop-2-professional.png'), `${rootDir}/page-2-desktop.png`);
  } else {
    // PRÉ-VERIFICAÇÃO: logar arquivos faltando antes de construir o ZIP
    for (let i = 0; i < job.selectedPages.length; i++) {
      const pDir    = path.join(jobDir, `page-${String(i).padStart(2, '0')}`);
      const desktop = path.join(pDir, 'desktop-professional.png');
      const mobile  = path.join(pDir, 'mobile-professional.png');
      if (!fs.existsSync(desktop)) console.error(`[zip] FALTANDO: ${desktop}`);
      if (!fs.existsSync(mobile))  console.error(`[zip] FALTANDO: ${mobile}`);
    }

    // Se NENHUM arquivo existe, algo falhou no render — não servir ZIP vazio
    const anyFileExists = job.selectedPages.some((_, i) => {
      const pDir = path.join(jobDir, `page-${String(i).padStart(2, '0')}`);
      return fs.existsSync(path.join(pDir, 'desktop-professional.png'));
    });
    if (!anyFileExists) {
      return res.status(500).json({ error: 'Falha na renderização das imagens. As capturas brutas estão disponíveis — tente novamente ou contate o suporte.' });
    }

    for (let i = 0; i < job.selectedPages.length; i++) {
      const pageUrl = job.selectedPages[i];
      const slug    = (() => {
        try {
          const p = new URL(pageUrl).pathname;
          return (p === '/' || !p) ? 'homepage' : p.replace(/^\//, '').replace(/\//g, '-').slice(0, 40) || 'page';
        } catch { return `page-${i + 1}`; }
      })();
      const folder = `${rootDir}/${String(i + 1).padStart(2, '0')}-${slug}`;
      const pDir   = path.join(jobDir, `page-${String(i).padStart(2, '0')}`);
      const addIf  = (f, n) => {
        if (fs.existsSync(f)) { archive.file(f, { name: n }); }
        else { console.error(`[zip] FALTANDO: ${f}`); }
      };

      addIf(path.join(pDir, 'desktop-professional.png'), `${folder}/desktop-full.png`);
      addIf(path.join(pDir, 'mobile-professional.png'),  `${folder}/mobile-full.png`);

      const sectDir = path.join(pDir, 'sections');
      if (fs.existsSync(sectDir)) {
        fs.readdirSync(sectDir).filter(f => f.endsWith('.png')).forEach(f => {
          archive.file(path.join(sectDir, f), { name: `${folder}/sections/${f}` });
        });
      }

      const socialDir = path.join(pDir, 'social');
      if (fs.existsSync(socialDir)) {
        fs.readdirSync(socialDir).filter(f => f.endsWith('.png')).forEach(f => {
          archive.file(path.join(socialDir, f), { name: `${folder}/social/${f}` });
        });
      }
    }
  }

  // Manifest — adicionado ANTES de finalize()
  const manifest = {
    capturedAt:    new Date().toISOString(),
    domain:        domainName,
    template:      tmpl,
    applyWatermark: job.applyWatermark !== undefined ? job.applyWatermark : true,
    compareMode:   job.compareMode,
    pages: job.compareMode
      ? job.compareUrls.map((u, i) => ({ index: i + 1, url: u }))
      : job.selectedPages.map((u, i) => {
          const pg = job.pages.find(p => p.url === u);
          return { index: i + 1, url: u, title: pg ? pg.title : u, pageType: pg ? pg.pageType : 'other' };
        }),
    renderConfig: job.renderConfig,
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: `${rootDir}/manifest.json` });

  // finalize() chamado DEPOIS de todos os archive.file()
  archive.finalize();
});

// ── GET /plano-ativo — página de confirmação pós-pagamento ───────────────────
app.get('/plano-ativo', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Plano Ativo — SnapShot.pro</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{background:#0a0a0a;color:rgba(255,255,255,.92);font-family:'Outfit',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
    .card{max-width:480px;width:100%;background:#141414;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:40px;text-align:center;}
    h1{font-size:28px;font-weight:800;letter-spacing:-.025em;margin-bottom:8px;}
    p{color:rgba(255,255,255,.55);font-size:15px;margin-bottom:28px;}
    .code-box{background:#0a0a0a;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:20px;margin:20px 0;font-family:monospace;font-size:24px;font-weight:700;letter-spacing:.1em;color:#fff;position:relative;}
    .copy-btn{background:#fff;color:#0a0a0a;border:none;border-radius:8px;padding:12px 28px;font-family:'Outfit',sans-serif;font-size:15px;font-weight:700;cursor:pointer;margin-top:4px;width:100%;}
    .copy-btn:hover{background:#f0f0f0;}
    .warn{font-size:13px;color:rgba(255,255,255,.4);margin-top:16px;}
    .back{display:inline-block;margin-top:24px;color:rgba(255,255,255,.5);font-size:14px;text-decoration:none;}
    .back:hover{color:#fff;}
    .spinner{width:32px;height:32px;border:3px solid rgba(255,255,255,.1);border-top-color:rgba(255,255,255,.7);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 20px;}
    @keyframes spin{to{transform:rotate(360deg)}}
    .check{width:56px;height:56px;background:rgba(74,222,128,.1);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:28px;}
  </style>
  </head><body>
  <div class="card" id="card">
    <div class="spinner" id="spinner"></div>
    <p id="msg">Confirmando pagamento…</p>
  </div>
  <script>
  (async () => {
    const params = new URLSearchParams(location.search);
    const sid = params.get('session_id');
    if (!sid) { document.getElementById('msg').textContent = 'Parâmetro de sessão ausente.'; document.getElementById('spinner').style.display='none'; return; }
    let code = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const r = await fetch('/api/subscription-code?session_id=' + encodeURIComponent(sid));
        const d = await r.json();
        if (d.code) { code = d.code; break; }
      } catch {}
    }
    const card = document.getElementById('card');
    if (!code) {
      card.innerHTML = '<div class="check">⚠</div><h1>Pagamento recebido</h1><p>Seu código está sendo processado. Verifique seu e-mail em alguns minutos ou entre em contato com suporte.</p><a class="back" href="/">← Voltar ao início</a>';
      return;
    }
    localStorage.setItem('snapshot_sub_code', code);
    card.innerHTML = \`
      <div class="check">✓</div>
      <h1>Plano ativo!</h1>
      <p>Salve seu código de acesso. Ele é necessário para usar o produto sem marca d'água.</p>
      <div class="code-box" id="codebox">\${code}</div>
      <button class="copy-btn" onclick="copyCode()">Copiar código</button>
      <p class="warn">⚠ Salve este código — sem ele você perde o acesso ao plano</p>
      <a class="back" href="/">← Capturar screenshots agora</a>
    \`;
    window.copyCode = () => {
      navigator.clipboard.writeText(code).catch(()=>{});
      document.querySelector('.copy-btn').textContent = 'Copiado!';
      setTimeout(()=>{ document.querySelector('.copy-btn').textContent = 'Copiar código'; }, 2000);
    };
  })();
  </script>
  </body></html>`);
});

// ── GET /share/:token ─────────────────────────────────────────────────────────
app.get('/share/:token', (req, res) => {
  const job = getJobByShareToken(req.params.token);
  if (!job) return res.status(404).send(`<!DOCTYPE html><html><head><title>Link Expirado</title><style>body{background:#0a0a0a;color:rgba(255,255,255,.6);font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}</style></head><body><div><div style="font-size:48px;font-weight:900;color:#fff;margin-bottom:12px;">SNAPSHOT.PRO</div><p>Este link de prévia expirou ou não existe.</p></div></body></html>`);

  const domainName = (() => { try { return new URL(job.selectedPages[0] || '').hostname.replace('www.', ''); } catch { return 'snapshot'; } })();
  const cards = job.compareMode
    ? `<p style="color:rgba(255,255,255,.55);font-size:16px;font-family:monospace;">Comparação — ${job.compareUrls ? job.compareUrls.join(' vs ') : ''}</p>`
    : job.selectedPages.map((u, i) => {
        const pg      = job.pages.find(p => p.url === u);
        const preview = `/screenshots/${job.jobId}/page-${String(i).padStart(2, '0')}/preview.png`;
        return `<div style="background:#0f0f0f;border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden;">
          <div style="position:relative;"><img src="${preview}" style="width:100%;display:block;" onerror="this.style.display='none'">
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;"><span style="font-family:monospace;font-size:22px;font-weight:900;color:rgba(255,255,255,.4);letter-spacing:.1em;transform:rotate(-15deg);">SNAPSHOT.PRO</span></div></div>
          <div style="padding:14px 16px;"><div style="font-size:14px;font-weight:600;color:rgba(255,255,255,.85);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${pg ? pg.title : u}</div><div style="font-size:12px;color:rgba(255,255,255,.35);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${u}</div></div>
        </div>`;
      }).join('');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>SnapShot.pro — ${domainName}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0a0a0a;color:rgba(255,255,255,.92);font-family:'Outfit',sans-serif;min-height:100vh;padding:48px 24px;}
  .wrap{max-width:900px;margin:0 auto;}.logo{font-size:28px;font-weight:800;color:#fff;letter-spacing:-.02em;margin-bottom:8px;}
  .meta{font-size:13px;color:rgba(255,255,255,.35);margin-bottom:48px;}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;}
  .notice{margin-top:40px;font-size:13px;color:rgba(255,255,255,.25);text-align:center;}</style></head>
  <body><div class="wrap">
    <div class="logo">SnapShot.pro</div>
    <div class="meta">Prévia compartilhada · ${domainName} · Expira em ${new Date(job.shareExpiry).toLocaleDateString('pt-BR')}</div>
    <div class="grid">${cards}</div>
    <p class="notice">Esta é uma prévia. Os arquivos HD foram entregues ao solicitante original.</p>
  </div></body></html>`);
});

// ── Admin auth middleware ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (!process.env.ADMIN_PASSWORD || token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const TEMPLATES_FILE = path.join(__dirname, 'data', 'templates.json');
const ERRORS_FILE    = path.join(__dirname, 'data', 'errors.json');
const CONFIG_FILE    = path.join(__dirname, 'data', 'config.json');

function readJsonFile(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}
function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ── GET /admin ────────────────────────────────────────────────────────────────
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── GET /admin/data ───────────────────────────────────────────────────────────
app.get('/admin/data', requireAdmin, (_req, res) => {
  const diskMB = (() => {
    try {
      let total = 0;
      const walk = (dir) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); try { const s = fs.statSync(p); if (s.isDirectory()) walk(p); else total += s.size; } catch {} } };
      walk(SS);
      return Math.round(total / 1024 / 1024);
    } catch { return 0; }
  })();
  const errors = readJsonFile(ERRORS_FILE, []);
  res.json({
    jobsActive:           0,
    capturesToday:        0,
    capturesTotal:        getCounter(),
    diskUsageMB:          diskMB,
    activeSubscriptions:  0,
    recentErrors:         errors.slice(-20),
    uptime:               Math.floor(process.uptime()),
  });
});

// ── GET /admin/templates ──────────────────────────────────────────────────────
app.get('/admin/templates', requireAdmin, (_req, res) => {
  res.json(readJsonFile(TEMPLATES_FILE, []));
});

// ── POST /admin/templates ─────────────────────────────────────────────────────
app.post('/admin/templates', requireAdmin, (req, res) => {
  const templates = readJsonFile(TEMPLATES_FILE, []);
  const tpl = Object.assign({ id: uuidv4(), active: true }, req.body);
  templates.push(tpl);
  writeJsonFile(TEMPLATES_FILE, templates);
  res.status(201).json(tpl);
});

// ── PATCH /admin/templates/:id ────────────────────────────────────────────────
app.patch('/admin/templates/:id', requireAdmin, (req, res) => {
  const templates = readJsonFile(TEMPLATES_FILE, []);
  const idx = templates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Template não encontrado.' });
  templates[idx] = Object.assign({}, templates[idx], req.body);
  writeJsonFile(TEMPLATES_FILE, templates);
  res.json(templates[idx]);
});

// ── DELETE /admin/templates/:id ───────────────────────────────────────────────
app.delete('/admin/templates/:id', requireAdmin, (req, res) => {
  const templates = readJsonFile(TEMPLATES_FILE, []);
  const filtered  = templates.filter(t => t.id !== req.params.id);
  if (filtered.length === templates.length) return res.status(404).json({ error: 'Template não encontrado.' });
  writeJsonFile(TEMPLATES_FILE, filtered);
  res.json({ ok: true });
});

// ── POST /admin/generate-code ─────────────────────────────────────────────────
app.post('/admin/generate-code', requireAdmin, (req, res) => {
  const { plan } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'Plano obrigatório.' });
  try {
    const code = generateSubscriptionCode(plan, null, null);
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /admin/errors ──────────────────────────────────────────────────────
app.delete('/admin/errors', requireAdmin, (_req, res) => {
  writeJsonFile(ERRORS_FILE, []);
  res.json({ ok: true });
});

// ── PATCH /admin/config ───────────────────────────────────────────────────────
app.patch('/admin/config', requireAdmin, (req, res) => {
  const config = readJsonFile(CONFIG_FILE, {});
  Object.assign(config, req.body);
  writeJsonFile(CONFIG_FILE, config);
  res.json(config);
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Algo deu errado. Por favor, tente novamente.' });
});

app.listen(PORT, () => console.log(`SnapShot.pro rodando em http://localhost:${PORT}`));
