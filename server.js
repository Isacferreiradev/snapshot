'use strict';

require('./instrument.js');
require('dotenv').config();

const Sentry = require('@sentry/node');

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
  updateCaptureProgress, appendCrawlLog, addGalleryItem,
  getJob, getJobByShareToken,
  incrementCounter, getCounter, setJobCaptureInfo,
  updatePageStatus, setPageTemplate, setPageOrder, setPageSetting, incrementManualPages, getManualPagesCount,
} = require('./jobs');

const { crawlSite, groupPages, rankPages }                                       = require('./crawler');
const { captureJobPages, initBrowserPool }                                        = require('./screenshotter');
const { renderProfessional }                                                     = require('./renderer');
const { createPixPayment, checkPixStatus,
        activatePayment, simulatePayment,
        verifyWebhookSignature }                                                  = require('./billing');
const { generateCode, validateCode, decrementCode }                              = require('./codes');
const { validateSubscription, canCapture, incrementCaptures,
        checkDailyFreeLimit, incrementDailyFreeUsage }                           = require('./subscriptions');
const { sendAlert }                                                              = require('./telegram');
const { getPlanConfig, getConfig, reloadConfig }                                 = require('./config');

const app  = express();
const PORT = process.env.PORT || 3001;
const SS   = path.join(__dirname, 'screenshots');

fs.mkdirSync(SS, { recursive: true });
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const TEMPLATES_FILE = path.join(__dirname, 'data', 'templates.json');
const ERRORS_FILE    = path.join(__dirname, 'data', 'errors.json');
const CONFIG_FILE    = path.join(__dirname, 'data', 'config.json');

// ── Rate limiter granular ─────────────────────────────────────────────────────
function makeRateLimiter(requestsPerMinute) {
  const store = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of store) if (now >= e.resetAt) store.delete(ip);
  }, 5 * 60 * 1000);
  return function(req, res, next) {
    const ip  = clientIp(req);
    const now = Date.now();
    let entry = store.get(ip);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + 60 * 1000 };
      store.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > requestsPerMinute) {
      return res.status(429).json({ error: 'Muitas requisições. Aguarde um momento.' });
    }
    next();
  };
}

// Rate limiters por rota
const rateLimiter        = makeRateLimiter(10);  // genérico
const rlCrawl            = makeRateLimiter(5);
const rlStartCapture     = makeRateLimiter(3);
const rlCreatePix        = makeRateLimiter(5);
const rlValidateCode     = makeRateLimiter(10);

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

// ── URL normalization (mirrors frontend normalizeUrlInput) ────────────────────
function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  try {
    let u = raw.trim();
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
    const parsed = new URL(u);
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','msclkid','ttclid','twclid']
      .forEach(p => parsed.searchParams.delete(p));
    parsed.hash = '';
    return parsed.href.replace(/\/$/, '') || parsed.href;
  } catch { return ''; }
}

// ── Resolver código de acesso (SNAP- ou hex) ──────────────────────────────────
function resolveAccessCode(code) {
  if (!code || typeof code !== 'string') return { valid: false };
  const norm = code.trim().toUpperCase();
  if (norm.startsWith('SNAP-')) {
    const r = validateSubscription(norm);
    return { valid: r.valid, plan: r.plan, isSnap: true, norm };
  }
  const r = validateCode(norm);
  return { valid: r.valid, plan: r.info && r.info.pkg, isSnap: false, norm };
}

function consumeAccessCredit(code) {
  if (!code) return;
  const norm = code.trim().toUpperCase();
  if (norm.startsWith('SNAP-')) {
    try { incrementCaptures(norm); } catch {}
  } else {
    try { decrementCode(norm); } catch {}
  }
}

// ── Webhook AbacatePay (raw body + HMAC verification) ────────────────────────
app.post('/api/webhook/abacatepay', express.raw({ type: 'application/json' }), async (req, res) => {
  // Logar todos os headers no primeiro webhook recebido
  if (!global._webhookReceived) {
    global._webhookReceived = true;
    console.log('[webhook] primeiro webhook recebido — headers:', JSON.stringify(req.headers, null, 2));
    console.log('[webhook] body raw (primeiros 500 chars):', req.body.toString().slice(0, 500));
  }

  try {
    const sig = req.headers['x-webhook-signature'] || req.headers['x-abacatepay-signature'] || '';

    // Verificar assinatura somente se ABACATEPAY_WEBHOOK_SECRET estiver configurado
    if (process.env.ABACATEPAY_WEBHOOK_SECRET) {
      if (!verifyWebhookSignature(req.body, sig)) {
        console.error('[webhook] assinatura inválida — sig recebida:', sig.slice(0, 40));
        return res.status(401).json({ error: 'Assinatura inválida.' });
      }
    }

    let event;
    try { event = JSON.parse(req.body.toString()); }
    catch { return res.status(200).end(); }

    console.log('[webhook] evento:', JSON.stringify(event).slice(0, 300));

    // Aceita tanto pix.paid quanto billing.paid
    const eventType = event && event.event;
    if (eventType !== 'pix.paid' && eventType !== 'billing.paid') return res.status(200).end();

    const pixId = event.data && event.data.id;
    if (!pixId) return res.status(200).end();

    // Extrair plano do metadata (PIX) ou externalId/completionUrl (billing)
    let plan = null;
    try {
      plan = event.data.metadata && event.data.metadata.plan;
    } catch {}
    if (!plan) {
      try {
        const products = event.data.products || event.data.billing?.products || [];
        for (const p of products) {
          const ext = (p.externalId || p.external_id || '').toLowerCase();
          if (ext.includes('starter')) { plan = 'starter'; break; }
          if (ext.includes('agency'))  { plan = 'agency';  break; }
          if (ext.includes('pro'))     { plan = 'pro';     break; }
        }
      } catch {}
    }
    if (!plan) {
      console.warn('[webhook] plano não encontrado no metadata — usando starter como fallback. pixId:', pixId);
      plan = 'starter';
    }

    const code = await activatePayment(pixId, plan);
    console.log(`[webhook] pagamento confirmado — plano: ${plan}, pixId: ${pixId}, código: ${code}`);
    sendAlert(`💰 Novo pagamento!\nPlano: ${plan}\nCódigo: ${code}`);

    return res.status(200).end();
  } catch (err) {
    console.error('[webhook] erro interno:', err.message);
    return res.status(200).end(); // nunca retornar 5xx ao AbacatePay
  }
});

// Compat: rota legada sem assinatura (aceita mas não verifica)
app.post('/api/webhook', express.json(), (_req, res) => res.status(200).json({ ok: true }));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SS));

// ── Plan middleware — enriquece req com plano completo do config.json ─────────
app.use((req, _res, next) => {
  const code = req.headers['x-access-code'];
  if (code) {
    const r = resolveAccessCode(code);
    req.accessCode      = r.valid ? r.norm : null;
    req.accessCodeValid = r.valid;
    req.accessCodePlan  = r.plan || null;
    const planKey       = r.valid ? (r.plan || 'free') : 'free';
    req.plan            = getPlanConfig(planKey);
    req.planKey         = planKey;
    req.planName        = planKey;
  } else {
    req.accessCode      = null;
    req.accessCodeValid = false;
    req.accessCodePlan  = null;
    req.plan            = getPlanConfig('free');
    req.planKey         = 'free';
    req.planName        = 'free';
  }
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => res.json({ total: getCounter() }));

// ── Planos ────────────────────────────────────────────────────────────────────
const PLAN_INFO = [
  { key: 'starter', name: 'Starter', priceCents: 1990,  priceLabel: 'R$ 19,90/mês',  monthlyCaptures: 100,  crawlLimit: 12,  cssSelector: false, manualPagesLimit: 3,   description: 'Screenshots sem marca d\'água, até 100 capturas/mês' },
  { key: 'pro',     name: 'Pro',     priceCents: 4990,  priceLabel: 'R$ 49,90/mês',  monthlyCaptures: -1,   crawlLimit: 20,  cssSelector: true,  manualPagesLimit: 10,  description: 'Capturas ilimitadas, templates exclusivos e exportação social' },
  { key: 'agency',  name: 'Agency',  priceCents: 12990, priceLabel: 'R$ 129,90/mês', monthlyCaptures: -1,   crawlLimit: 999, cssSelector: true,  manualPagesLimit: -1,  description: 'Tudo do Pro + 3 códigos de acesso e crawl ilimitado' },
];
app.get('/api/plans',    (_req, res) => res.json({ plans:    PLAN_INFO }));
app.get('/api/packages', (_req, res) => res.json({ packages: PLAN_INFO }));

// ── Validar código de acesso ──────────────────────────────────────────────────
app.post('/api/validate-code', rlValidateCode, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ valid: false, reason: 'Código obrigatório.' });
  const norm = code.trim().toUpperCase();
  if (norm.startsWith('SNAP-')) {
    const result = validateSubscription(norm);
    if (!result.valid) return res.status(400).json(result);
    return res.json({
      valid: true,
      info:  { plan: result.plan, remaining: result.capturesRemaining, isWatermarked: false },
    });
  }
  // Legado: códigos hex (codes.js)
  const result = validateCode(norm);
  if (!result.valid) return res.status(400).json(result);
  return res.json({
    valid: true,
    info:  { plan: result.info.pkg, remaining: result.info.remaining, isWatermarked: false },
  });
});

// ── POST /api/create-pix — gera QR Code PIX transparente ────────────────────
app.post('/api/create-pix', rlCreatePix, async (req, res) => {
  const { plan, customer } = req.body || {};
  const VALID = ['starter', 'pro', 'agency'];
  if (!plan || !VALID.includes(plan))
    return res.status(400).json({ error: `Plano inválido. Use: ${VALID.join(', ')}` });
  try {
    const result = await createPixPayment(plan, customer || null);
    const config = readJsonFile(CONFIG_FILE, { plans: {} });
    const planName = (config.plans && config.plans[plan] && config.plans[plan].name) || plan;
    return res.json({ ...result, planName });
  } catch (err) {
    console.error('[create-pix] erro:', err.message);
    return res.status(500).json({ error: `Erro ao gerar PIX: ${err.message}` });
  }
});

// ── GET /api/pix-status — polling de status do PIX (nunca retorna 4xx/5xx) ───
app.get('/api/pix-status', async (req, res) => {
  const { pixId } = req.query;
  if (!pixId) return res.json({ status: 'pending', accessCode: null });
  try {
    const result = await checkPixStatus(pixId);
    return res.json(result);
  } catch {
    return res.json({ status: 'pending', accessCode: null });
  }
});

// ── POST /api/simulate-pix — simula pagamento PIX (dev only) ─────────────────
app.post('/api/simulate-pix', async (req, res) => {
  if (process.env.NODE_ENV === 'production')
    return res.status(403).json({ error: 'Indisponível em produção.' });
  const { pixId } = req.body || {};
  if (!pixId) return res.status(400).json({ error: 'pixId obrigatório.' });
  try {
    const result = await simulatePayment(pixId);
    if (result.accessCode) sendAlert(`💰 Simulação PIX confirmada!\nPlano: ${result.plan}\nCódigo: ${result.accessCode}`);
    return res.json(result);
  } catch (err) {
    console.error('[simulate-pix] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Validate URL ──────────────────────────────────────────────────────────────
app.post('/api/validate-url', (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'URL obrigatória.' });
  const t = normalizeUrl(url);
  if (!t) return res.status(400).json({ ok: false, error: 'Formato de URL inválido.' });
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
app.post('/api/crawl', rlCrawl, (req, res) => {
  const { url, subscriptionCode, accessCode } = req.body || {};
  // Accept both field names for compat
  const code = subscriptionCode || accessCode || null;

  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL obrigatória.' });
  const t = normalizeUrl(url);
  if (!t) return res.status(400).json({ error: 'URL inválida.' });
  if (t.length > 500) return res.status(400).json({ error: 'URL muito longa.' });

  // Validar código se fornecido (não bloqueante — apenas para flag de watermark)
  let validatedCode = null;
  if (code) {
    const cv = resolveAccessCode(code);
    if (cv.valid) validatedCode = cv.norm;
  }

  // Crawl é sempre gratuito e ilimitado — o limite diário é cobrado na captura (/api/start-capture)

  const jobId = uuidv4();
  createJob(jobId, { subscriptionCode: validatedCode });

  const planCrawlLimit = req.plan ? req.plan.crawlLimit : 4;

  (async () => {
    try {
      appendCrawlLog(jobId, 'Iniciando exploração do site…');
      const { pages, totalFound } = await crawlSite(t, jobId, planCrawlLimit);
      appendCrawlLog(jobId, `Exploração concluída — ${pages.length} página(s) encontrada(s).`);
      updateCrawlResult(jobId, pages);
      // Armazenar totalFound e planLimit no job para o frontend
      const job = getJob(jobId);
      if (job) { job.totalFound = totalFound; job.planLimit = planCrawlLimit; }
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
  const rankedPages = rankPages(job.pages || []);
  const grouped = groupPages(rankedPages);
  return res.json({ status: job.status, pages: rankedPages, grouped, planLimit: job.planLimit || null, totalFound: job.totalFound || rankedPages.length });
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
      const rp = rankPages(j.pages || []);
      send({ done: true, status: j.status, pages: rp, grouped: groupPages(rp), error: j.failReason, planLimit: j.planLimit || null, totalFound: j.totalFound || (rp && rp.length) || 0 });
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
app.post('/api/start-capture', rlStartCapture, (req, res) => {
  const { jobId, renderConfig } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId obrigatório.' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.status !== 'configuring') return res.status(409).json({ error: `Status inesperado: ${job.status}` });

  // Verificar limite diário de capturas free (cobrado na captura, não no crawl)
  const reqIp = clientIp(req);
  if (req.planName === 'free') {
    const dayLimit = req.plan.capturesPerDay || 3;
    const dayCheck = checkDailyFreeLimit(reqIp, dayLimit);
    if (!dayCheck.allowed) {
      return res.status(429).json({
        error:   `Limite diário de ${dayLimit} capturas atingido. Volte amanhã ou ative um plano.`,
        used:    dayCheck.used,
        limit:   dayCheck.limit,
        resetAt: 'meia-noite UTC',
      });
    }
  }

  const cfg = { ...(renderConfig || {}), planName: req.planName || 'free' };

  // Verificar template autorizado para o plano
  const reqTemplate    = cfg.template || 'void';
  const unlocked       = req.plan.templatesUnlocked;
  const templateOk     = unlocked === 'all' || (Array.isArray(unlocked) && unlocked.includes(reqTemplate));
  if (!templateOk) {
    return res.status(403).json({ error: 'Template não disponível no seu plano atual.', requiredPlan: 'starter' });
  }

  // Verificar limite de capturas mensais (SNAP- codes)
  const subCodeForLimit = job.subscriptionCode || req.accessCode || null;
  if (subCodeForLimit && subCodeForLimit.startsWith('SNAP-')) {
    const capCheck = canCapture(subCodeForLimit, req.plan);
    if (!capCheck.allowed) {
      const resetDate = new Date();
      resetDate.setMonth(resetDate.getMonth() + 1);
      resetDate.setDate(1);
      return res.status(429).json({
        error:     `Limite de capturas mensais atingido. Você usou ${capCheck.used} de ${capCheck.limit} capturas.`,
        used:      capCheck.used,
        limit:     capCheck.limit,
        resetDate: `dia 1 de ${resetDate.toLocaleDateString('pt-BR', { month: 'long' })}`,
      });
    }
  }

  updateRenderConfig(jobId, cfg);

  // [COR-2] Sincronizar overrides de template por página caso venham no renderConfig
  if (cfg.pageTemplates && typeof cfg.pageTemplates === 'object') {
    Object.entries(cfg.pageTemplates).forEach(([url, tplId]) => {
      setPageTemplate(jobId, url, tplId);
    });
  }

  // [COR-4] Determinar applyWatermark com base no plano do request
  const subCode        = job.subscriptionCode || null;
  const subValid       = subCode ? resolveAccessCode(subCode) : null;
  const applyWatermark = (req.plan && req.plan.watermark === true);
  job.applyWatermark   = applyWatermark;
  setJobCaptureInfo(jobId, req.planKey || 'free', applyWatermark);

  // Parâmetros do plano e preferências de exportação
  const isPaid           = req.planKey !== 'free';
  const includeMobile     = req.plan.mobileCapture !== false;
  const deviceScaleFactor = (cfg.highRes && isPaid) ? 2 : (req.plan.deviceScaleFactor || 1);

  console.log(`[capture] job ${jobId} — watermark: ${applyWatermark}, code: ${subCode || 'none'}, mobile: ${includeMobile}, scale: ${deviceScaleFactor}`);

  const pages = job.selectedPages;

  // Build per-page options (captureStrategy, aboveFoldOnly, per-page template)
  const pageOptionsArray = pages.map(pageUrl => {
    const settings = (job.pageSettings && job.pageSettings[pageUrl]) || {};
    return {
      aboveFoldOnly: !!settings.aboveFoldOnly,
      captureStrategy: job.captureStrategy || null,
    };
  });
  updateCaptureProgress(jobId, { total: pages.length, completed: 0, current: 'Preparando captura…', percent: 0 });

  (async () => {
    let completedCount = 0;
    let failCount      = 0;
    try {
      // Incrementar uso diário free — cobrado na captura
      if (req.planName === 'free') incrementDailyFreeUsage(reqIp, 1);

      await captureJobPages(pages, jobId, { ...cfg, includeMobile, deviceScaleFactor, pageTemplates: job.pageTemplates || {} }, (i, result, err) => {
        const pageUrl = pages[i];
        const pageObj = job.pages.find(p => p.url === pageUrl) || {};
        completedCount++;

        if (result) {
          failCount = 0; // reset contador de falhas consecutivas
          addGalleryItem(jobId, {
            index:      i,
            url:        pageUrl,
            title:      result.pageTitle || pageUrl,
            previewUrl: `/screenshots/${jobId}/page-${String(i).padStart(2, '0')}/preview.png`,
          });
          console.log(`[capture] ✓ página ${i}: ${pageUrl}`);
        } else {
          failCount++;
          console.error(`[capture] ✗ página ${i}: ${pageUrl} — ${err ? err.message : 'unknown'}`);
          if (failCount >= 3) {
            sendAlert(`⚠️ <b>SnapShot.pro</b> — 3 falhas consecutivas\nURL: ${pageUrl}\nJob: ${jobId}`);
          }
        }

        // Atualiza progresso IMEDIATAMENTE após cada página (bug fix)
        updateCaptureProgress(jobId, {
          completed: completedCount,
          current:   pageObj.title || pageUrl,
          total:     pages.length,
          percent:   Math.round((completedCount / pages.length) * 100),
        });
        incrementCounter();
      }, applyWatermark, pageOptionsArray);

      // Decrementar 1 crédito do código (job inteiro = 1 captura)
      if (subCode && subValid && subValid.valid) {
        consumeAccessCredit(subCode);
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


// ── POST /api/create-checkout (download) ──────────────────────────────────────
app.post('/api/create-checkout', (req, res) => {
  const { jobId, withWatermark } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId obrigatório.' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.status !== 'ready') return res.status(409).json({ error: 'Captura ainda em andamento.' });

  if (withWatermark || !job.applyWatermark) {
    markPaid(jobId);
    return res.json({ checkoutUrl: `/api/download/${jobId}` });
  }
  return res.json({ requiresUpgrade: true, watermarkUrl: `/api/download/${jobId}` });
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

  // mode param: 'full' (default), 'desktop', 'mobile'
  const dlMode = (req.query.mode === 'desktop' || req.query.mode === 'mobile') ? req.query.mode : 'full';

  const domainName = (() => {
    try { return new URL(job.selectedPages[0]).hostname.replace('www.', ''); }
    catch { return 'snapshot'; }
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
    return res.status(500).json({ error: 'Falha na renderização das imagens. Tente novamente ou contate o suporte.' });
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

    if (dlMode !== 'mobile') addIf(path.join(pDir, 'desktop-professional.png'), `${folder}/desktop-full.png`);
    if (dlMode !== 'desktop') addIf(path.join(pDir, 'mobile-professional.png'), `${folder}/mobile-full.png`);

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

  // Manifest — adicionado ANTES de finalize()
  const manifest = {
    capturedAt:    new Date().toISOString(),
    domain:        domainName,
    template:      tmpl,
    applyWatermark: job.applyWatermark !== undefined ? job.applyWatermark : true,
    pages: job.selectedPages.map((u, i) => {
      const pg = job.pages.find(p => p.url === u);
      return { index: i + 1, url: u, title: pg ? pg.title : u, pageType: pg ? pg.pageType : 'other' };
    }),
    renderConfig: job.renderConfig,
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: `${rootDir}/manifest.json` });

  // finalize() chamado DEPOIS de todos os archive.file()
  archive.finalize();
});

// ── GET /api/templates — lista pública de templates ativos ───────────────────
app.get('/api/templates', (req, res) => {
  const templates = readJsonFile(TEMPLATES_FILE, []);
  const active    = templates
    .filter(t => t.active !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const unlocked  = req.plan.templatesUnlocked;
  const result    = active.map(t => ({
    ...t,
    locked: unlocked !== 'all' && !(Array.isArray(unlocked) && unlocked.includes(t.id)),
  }));
  // Free (unlocked) templates first, then locked
  result.sort((a, b) => {
    if (a.locked === b.locked) return (a.order || 0) - (b.order || 0);
    return a.locked ? 1 : -1;
  });
  console.log('[templates] Retornando', result.length, 'templates');
  res.json(result);
});

// ── GET /api/plan-status — estado atual do plano ──────────────────────────────
app.get('/api/plan-status', (req, res) => {
  const planCfg = req.plan || getPlanConfig('free');
  const planKey = req.planKey || 'free';
  // Capturas usadas (para SNAP- codes)
  let capturesUsed = 0;
  if (req.accessCode && req.accessCode.startsWith('SNAP-')) {
    try {
      const r = validateSubscription(req.accessCode);
      if (r.valid && r.capturesRemaining !== null && r.capturesRemaining !== undefined) {
        const limit = planCfg.monthlyCaptures;
        capturesUsed = (limit !== null && limit !== -1) ? Math.max(0, limit - r.capturesRemaining) : 0;
      }
    } catch {}
  }
  res.json({
    plan:              planKey,
    planName:          planCfg.name || planKey,
    watermark:         planCfg.watermark !== false,
    templatesUnlocked: planCfg.templatesUnlocked || [],
    crawlLimit:        planCfg.crawlLimit || 6,
    monthlyCaptures:   planCfg.monthlyCaptures !== undefined ? planCfg.monthlyCaptures : -1,
    capturesUsed,
    cssSelector:       !!planCfg.cssSelector,
    apiAccess:         !!planCfg.apiAccess,
    manualPagesLimit:  planCfg.manualPagesLimit !== undefined ? planCfg.manualPagesLimit : 0,
  });
});



// ── GET /share/:token ─────────────────────────────────────────────────────────
app.get('/share/:token', (req, res) => {
  const job = getJobByShareToken(req.params.token);
  if (!job) return res.status(404).send(`<!DOCTYPE html><html><head><title>Link Expirado</title><style>body{background:#0a0a0a;color:rgba(255,255,255,.6);font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}</style></head><body><div><div style="font-size:48px;font-weight:900;color:#fff;margin-bottom:12px;">SNAPSHOT.PRO</div><p>Este link de prévia expirou ou não existe.</p></div></body></html>`);

  const domainName = (() => { try { return new URL(job.selectedPages[0] || '').hostname.replace('www.', ''); } catch { return 'snapshot'; } })();
  const cards = job.selectedPages.map((u, i) => {
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

// ── POST /api/rerender/:jobId — Remove watermark após compra ──────────────────
app.post('/api/rerender/:jobId', async (req, res) => {
  const { jobId } = req.params;

  if (!req.planKey || req.planKey === 'free') {
    return res.status(403).json({ error: 'Plano pago necessário para remover a marca d\'água.' });
  }

  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });

  const jobDir = path.join(SS, jobId);
  if (!fs.existsSync(jobDir)) {
    return res.status(404).json({ error: 'Arquivos do job não encontrados.' });
  }

  const pages = job.selectedPages || [];
  let rerendered = 0;

  for (let i = 0; i < pages.length; i++) {
    const url    = pages[i];
    const dir    = path.join(jobDir, `page-${String(i).padStart(2, '0')}`);
    const rawD   = path.join(dir, 'desktop-raw.png');
    const rawM   = path.join(dir, 'mobile-raw.png');
    const outD   = path.join(dir, 'desktop-professional.png');
    const outM   = path.join(dir, 'mobile-professional.png');
    const outPre = path.join(dir, 'preview.png');

    if (!fs.existsSync(rawD)) continue;

    const templateId = (job.pageTemplates && job.pageTemplates[url]) || job.renderConfig?.template || 'void';
    const pageTitle  = (job.pages?.find(p => p.url === url))?.title || url;

    try {
      await renderProfessional({ screenshotPath: rawD, deviceType: 'desktop', templateId, outputPath: outD, pageUrl: url, pageTitle, applyWatermark: false });
      await renderProfessional({ screenshotPath: rawD, deviceType: 'desktop', templateId, outputPath: outPre, pageUrl: url, pageTitle, applyWatermark: false });
      if (fs.existsSync(rawM)) {
        await renderProfessional({ screenshotPath: rawM, deviceType: 'mobile', templateId, outputPath: outM, pageUrl: url, pageTitle, applyWatermark: false });
      }
      rerendered++;
    } catch (err) {
      console.error(`[rerender] falhou página ${i} (${url}): ${err.message}`);
    }
  }

  if (rerendered === 0) {
    return res.status(422).json({ error: 'Nenhuma imagem encontrada para re-renderizar. O job pode ter expirado.' });
  }

  res.json({ ok: true, rerendered, total: pages.length });
});

// ── Admin token store (em memória, expiração de 8h) ──────────────────────────
const _adminTokens = new Set();

// ── Admin auth middleware ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  // Aceita token gerado OU a senha direta
  if (_adminTokens.has(token) || (process.env.ADMIN_PASSWORD && token === process.env.ADMIN_PASSWORD)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── POST /admin/login — gera token de sessão admin ───────────────────────────
app.post('/admin/login', express.json(), (req, res) => {
  const { password } = req.body || {};
  if (!password || !process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Senha inválida.' });
  }
  const token = require('crypto').randomBytes(32).toString('hex');
  _adminTokens.add(token);
  setTimeout(() => _adminTokens.delete(token), 8 * 60 * 60 * 1000); // expira em 8h
  return res.json({ token });
});

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
  const { plan, captures } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'Plano obrigatório.' });
  const captureCount = captures ? parseInt(captures, 10) : 999999; // planos mensais = ilimitado
  if (!captureCount || captureCount < 1) return res.status(400).json({ error: 'Quantidade inválida.' });
  try {
    const code = generateCode(captureCount, plan);
    res.json({ code, captures: captureCount, plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pix-debug/:pixId — debug de pagamento PIX (admin) ───────────────
app.get('/api/pix-debug/:pixId', requireAdmin, async (req, res) => {
  try {
    const result = await checkPixStatus(req.params.pixId);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
  reloadConfig();
  res.json(config);
});

// ── GET /admin/errors ─────────────────────────────────────────────────────────
app.get('/admin/errors', requireAdmin, (_req, res) => {
  const errors = readJsonFile(ERRORS_FILE, []);
  res.json(errors);
});

// ── GET /admin/subscriptions ──────────────────────────────────────────────────
app.get('/admin/subscriptions', requireAdmin, (_req, res) => {
  try {
    const subs = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'subscriptions.json'), 'utf8'));
    const list = Object.entries(subs).map(([code, sub]) => ({ code, ...sub }));
    res.json(list);
  } catch { res.json([]); }
});

// ── DELETE /admin/subscriptions/:code ─────────────────────────────────────────
app.delete('/admin/subscriptions/:code', requireAdmin, (req, res) => {
  const subFile = path.join(__dirname, 'data', 'subscriptions.json');
  try {
    const subs = JSON.parse(fs.readFileSync(subFile, 'utf8'));
    const code = req.params.code.toUpperCase();
    if (!subs[code]) return res.status(404).json({ error: 'Código não encontrado.' });
    subs[code].active = false;
    fs.writeFileSync(subFile, JSON.stringify(subs, null, 2));
    res.json({ ok: true, code });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /privacidade ──────────────────────────────────────────────────────────
app.get('/privacidade', (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Política de Privacidade — SnapShot.pro</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:720px;margin:48px auto;padding:0 24px;background:#0a0a0a;color:rgba(255,255,255,0.85);line-height:1.7;}h1{font-size:28px;margin-bottom:8px;}h2{font-size:18px;margin-top:32px;color:rgba(255,255,255,0.7);}p,li{font-size:15px;color:rgba(255,255,255,0.65);}a{color:#fff;}header{margin-bottom:40px;}.back{font-size:13px;color:rgba(255,255,255,0.4);text-decoration:none;}</style>
  </head><body>
  <a class="back" href="/">← Voltar</a>
  <header><h1>Política de Privacidade</h1><p style="font-size:13px;color:rgba(255,255,255,0.35);">Última atualização: ${new Date().toLocaleDateString('pt-BR')}</p></header>
  <h2>1. Quem somos</h2><p>SnapShot.pro é um serviço de captura de screenshots profissionais de sites. Contato: contato@snapshot.pro</p>
  <h2>2. Dados coletados</h2><p>Coletamos apenas o endereço de e-mail quando fornecido voluntariamente durante o pagamento, e o endereço IP para fins de limitação de uso (rate limiting). Não coletamos senhas, dados bancários nem qualquer dado sensível.</p>
  <h2>3. Uso dos dados</h2><p>Os dados são usados exclusivamente para: geração do código de acesso após pagamento, envio de notificações transacionais, e controle de limite de capturas gratuitas.</p>
  <h2>4. Armazenamento</h2><p>Screenshots geradas são armazenadas temporariamente por até 2 horas após a captura e então removidas automaticamente. Não armazenamos imagens de sites de terceiros de forma permanente.</p>
  <h2>5. Compartilhamento</h2><p>Não vendemos nem compartilhamos dados pessoais com terceiros, exceto processadores de pagamento (AbacatePay) sujeitos às suas próprias políticas.</p>
  <h2>6. Direitos (LGPD)</h2><p>Você tem direito a acessar, corrigir ou solicitar a exclusão de seus dados pessoais. Entre em contato: contato@snapshot.pro</p>
  <h2>7. Cookies</h2><p>Usamos apenas localStorage para armazenar preferências locais (código de acesso, histórico de URLs). Não usamos cookies de rastreamento.</p>
  </body></html>`);
});

// ── GET /termos ───────────────────────────────────────────────────────────────
app.get('/termos', (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Termos de Uso — SnapShot.pro</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:720px;margin:48px auto;padding:0 24px;background:#0a0a0a;color:rgba(255,255,255,0.85);line-height:1.7;}h1{font-size:28px;margin-bottom:8px;}h2{font-size:18px;margin-top:32px;color:rgba(255,255,255,0.7);}p,li{font-size:15px;color:rgba(255,255,255,0.65);}a{color:#fff;}header{margin-bottom:40px;}.back{font-size:13px;color:rgba(255,255,255,0.4);text-decoration:none;}</style>
  </head><body>
  <a class="back" href="/">← Voltar</a>
  <header><h1>Termos de Uso</h1><p style="font-size:13px;color:rgba(255,255,255,0.35);">Última atualização: ${new Date().toLocaleDateString('pt-BR')}</p></header>
  <h2>1. Aceitação</h2><p>Ao utilizar o SnapShot.pro você concorda com estes termos. Se não concordar, não utilize o serviço.</p>
  <h2>2. Uso permitido</h2><p>O serviço destina-se exclusivamente à captura de screenshots de sites públicos para fins legítimos (portfólio, documentação, apresentações). É proibido capturar conteúdo que viole direitos de terceiros.</p>
  <h2>3. Uso proibido</h2><ul><li>Capturar sites com conteúdo ilegal</li><li>Tentar contornar limites do plano</li><li>Revender ou redistribuir o serviço sem autorização</li><li>Uso automatizado sem contratar o plano Agency com acesso à API</li></ul>
  <h2>4. Planos e pagamentos</h2><p>Os pagamentos são processados pelo AbacatePay via PIX. Planos mensais expiram após 30 dias. Não há reembolso após a ativação do código de acesso.</p>
  <h2>5. Disponibilidade</h2><p>O serviço é fornecido "como está". Não garantimos disponibilidade contínua nem resultados específicos na captura de screenshots.</p>
  <h2>6. Limitação de responsabilidade</h2><p>O SnapShot.pro não se responsabiliza por danos decorrentes do uso ou impossibilidade de uso do serviço.</p>
  <h2>7. Contato</h2><p>Dúvidas: contato@snapshot.pro</p>
  </body></html>`);
});

// ── POST /api/detect-site — Detect platform from URL ─────────────────────────
app.post('/api/detect-site', async (req, res) => {
  const { url: rawUrl } = req.body || {};
  const url = normalizeUrl(rawUrl || '') || rawUrl;
  if (!url) return res.json({ platform: 'generic', confidence: 0 });

  const PLATFORM_STRATEGIES = {
    wordpress:  { waitUntil: 'domcontentloaded', delay: 1500 },
    shopify:    { delay: 2500 },
    webflow:    { waitUntil: 'networkidle2', timeout: 8000 },
    framer:     { delay: 3000 },
    nextjs:     { waitUntil: 'networkidle2' },
    nuxt:       { waitUntil: 'networkidle2' },
    wix:        { delay: 2000 },
    squarespace:{ delay: 2000 },
    generic:    {},
  };
  const TEMPLATE_SUGGESTIONS = {
    wordpress: 'chrome', shopify: 'poster', webflow: 'float',
    framer: 'neon', nextjs: 'void', nuxt: 'void',
    wix: 'paper', squarespace: 'paper', generic: 'void',
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let platform = 'generic';
    let confidence = 0;

    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 SnapShot-Detector/1.0' },
    }).catch(() => null);
    clearTimeout(timer);

    if (r) {
      const powered = (r.headers.get('x-powered-by') || '').toLowerCase();
      const gen     = (r.headers.get('x-generator') || '').toLowerCase();

      if (r.headers.get('x-shopify-stage') || powered.includes('shopify')) { platform = 'shopify'; confidence = 0.95; }
      else if (r.headers.get('x-wix-request-id')) { platform = 'wix'; confidence = 0.95; }
      else if (gen.includes('wordpress') || powered.includes('wordpress')) { platform = 'wordpress'; confidence = 0.9; }
      else {
        const html = (await r.text().catch(() => '')).slice(0, 8000).toLowerCase();
        if (html.includes('wp-content') || html.includes('wp-includes')) { platform = 'wordpress'; confidence = 0.85; }
        else if (html.includes('shopify')) { platform = 'shopify'; confidence = 0.8; }
        else if (html.includes('webflow') || html.includes('wf-')) { platform = 'webflow'; confidence = 0.85; }
        else if (html.includes('framer') || html.includes('framerusercontent')) { platform = 'framer'; confidence = 0.85; }
        else if (html.includes('squarespace')) { platform = 'squarespace'; confidence = 0.85; }
        else if (html.includes('wix.com') || html.includes('wixsite')) { platform = 'wix'; confidence = 0.85; }
        else if (html.includes('_next/') || html.includes('__next')) { platform = 'nextjs'; confidence = 0.8; }
        else if (html.includes('__nuxt') || html.includes('_nuxt/')) { platform = 'nuxt'; confidence = 0.8; }
        else { confidence = 0.1; }
      }
    }

    return res.json({
      platform,
      confidence,
      suggestedTemplate: TEMPLATE_SUGGESTIONS[platform] || 'void',
      captureStrategy: PLATFORM_STRATEGIES[platform] || {},
    });
  } catch {
    return res.json({ platform: 'generic', confidence: 0, suggestedTemplate: 'void', captureStrategy: {} });
  }
});

// ── POST /api/crawl-manual — Manual page addition ─────────────────────────────
app.post('/api/crawl-manual', rateLimiter, async (req, res) => {
  const { baseUrl: rawBase, query, exactUrl: rawExact, jobId } = req.body || {};
  const baseUrl  = normalizeUrl(rawBase  || '') || rawBase;
  const exactUrl = rawExact ? (normalizeUrl(rawExact) || rawExact) : undefined;
  if (!jobId) return res.status(400).json({ error: 'jobId obrigatório.' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });

  const planLimit = req.plan.manualPagesPerJob !== undefined ? req.plan.manualPagesPerJob : (req.plan.manualPagesLimit !== undefined ? req.plan.manualPagesLimit : 0);
  const used      = getManualPagesCount(jobId);
  if (planLimit !== -1 && planLimit !== null && used >= planLimit) {
    return res.status(429).json({ error: 'Limite de páginas manuais atingido.', limit: planLimit, used });
  }

  let targetUrl = exactUrl || null;

  if (!targetUrl && query) {
    const base    = baseUrl || (job.pages[0] && new URL(job.pages[0].url).origin) || '';
    const slug    = query.trim().toLowerCase().replace(/\s+/g, '-');
    const candidates = [`${base}/${slug}`, `${base}/${query.trim()}`];
    for (const candidate of candidates) {
      try {
        const r = await fetch(candidate, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        if (r.ok || r.status === 405) { targetUrl = candidate; break; }
      } catch {}
    }
    if (!targetUrl) {
      const suggestions = candidates.map(c => c);
      return res.json({ found: false, suggestions });
    }
  }

  if (!targetUrl) return res.status(400).json({ error: 'URL ou query obrigatória.' });

  // Validate same domain
  try {
    const base   = baseUrl || (job.pages[0] && new URL(job.pages[0].url).origin) || '';
    const origin = new URL(base).origin;
    if (!targetUrl.startsWith(origin)) {
      return res.status(400).json({ error: 'URL deve pertencer ao mesmo domínio.' });
    }
  } catch {}

  try {
    const { getBrowserFromPool, releaseBrowserToPool } = require('./screenshotter');
    const thumbDir  = path.join(SS, jobId, 'thumbs');
    fs.mkdirSync(thumbDir, { recursive: true });
    const thumbName = `manual-${Date.now()}.jpg`;
    const thumbPath = path.join(thumbDir, thumbName);
    const thumbUrl  = `/screenshots/${jobId}/thumbs/${thumbName}`;

    let poolEntry;
    let title = targetUrl;
    try {
      poolEntry = await getBrowserFromPool();
      const pg  = await poolEntry.browser.newPage();
      await pg.setViewport({ width: 800, height: 500 });
      await pg.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
      title = await pg.title().catch(() => targetUrl);
      await pg.screenshot({ path: thumbPath, type: 'jpeg', quality: 40,
        clip: { x: 0, y: 0, width: 800, height: 500 }, timeout: 4000 }).catch(() => {});
      await pg.close().catch(() => {});
    } finally {
      if (poolEntry) await releaseBrowserToPool(poolEntry);
    }

    const newPage = {
      url: targetUrl, title, thumbnailPath: thumbPath, thumbnailUrl: thumbUrl,
      pageType: 'other', recommended: false, manual: true,
    };
    job.pages.push(newPage);
    incrementManualPages(jobId);

    return res.json({ found: true, url: targetUrl, title, thumbnailUrl: thumbUrl, thumbPath });
  } catch (err) {
    return res.status(500).json({ error: `Erro ao acessar página: ${err.message}` });
  }
});

// ── POST /api/rerender — Re-render page with new template ────────────────────
app.post('/api/rerender', async (req, res) => {
  const { jobId, pageUrl, templateId } = req.body || {};
  if (!jobId || !pageUrl || !templateId) return res.status(400).json({ error: 'jobId, pageUrl e templateId obrigatórios.' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });

  const pageIdx = job.selectedPages.indexOf(pageUrl);
  if (pageIdx === -1) return res.status(404).json({ error: 'Página não encontrada no job.' });

  const dir         = path.join(SS, jobId, `page-${String(pageIdx).padStart(2, '0')}`);
  const desktopRaw  = path.join(dir, 'desktop-raw.png');
  const mobileRaw   = path.join(dir, 'mobile-raw.png');
  const desktopOut  = path.join(dir, 'desktop-professional.png');
  const mobileOut   = path.join(dir, 'mobile-professional.png');
  const previewOut  = path.join(dir, 'preview.png');

  const hasDesktopRaw = fs.existsSync(desktopRaw);
  const hasMobileRaw  = fs.existsSync(mobileRaw);
  if (!hasDesktopRaw && !hasMobileRaw) {
    return res.status(409).json({ error: 'Arquivos brutos não disponíveis. A troca de template requer capturas recentes.' });
  }

  try {
    const { renderProfessional } = require('./renderer');
    const cfg         = Object.assign({}, job.renderConfig || {}, { template: templateId });
    const applyWM     = !!job.applyWatermark;
    const pg          = job.pages.find(p => p.url === pageUrl);
    const pageTitle   = pg ? pg.title : pageUrl;

    if (hasDesktopRaw) {
      await renderProfessional({ screenshotPath: desktopRaw, deviceType: 'desktop', renderConfig: cfg, outputPath: desktopOut, pageUrl, pageTitle, applyWatermark: applyWM });
      await renderProfessional({ screenshotPath: desktopRaw, deviceType: 'desktop', renderConfig: cfg, outputPath: previewOut, pageUrl, pageTitle, applyWatermark: applyWM });
    }
    if (hasMobileRaw) {
      await renderProfessional({ screenshotPath: mobileRaw, deviceType: 'mobile', renderConfig: cfg, outputPath: mobileOut, pageUrl, pageTitle, applyWatermark: applyWM });
    }

    setPageTemplate(jobId, pageUrl, templateId);

    const newPreviewUrl = `/screenshots/${jobId}/page-${String(pageIdx).padStart(2, '0')}/preview.png?t=${Date.now()}`;
    return res.json({ success: true, newPreviewUrl, templateId });
  } catch (err) {
    console.error('[rerender] erro:', err.message);
    return res.status(500).json({ error: `Erro ao rerenderizar: ${err.message}` });
  }
});

// ── GET /api/download-sample/:jobId — Free sample download ───────────────────
app.get('/api/download-sample/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.status !== 'ready' && job.status !== 'downloaded') {
    return res.status(409).json({ error: 'Captura ainda em andamento.' });
  }

  const previewPath = path.join(SS, jobId, 'page-00', 'preview.png');
  if (!fs.existsSync(previewPath)) return res.status(404).json({ error: 'Preview não disponível.' });

  const domain = (() => { try { return new URL(job.selectedPages[0] || '').hostname.replace('www.', '').split('.')[0]; } catch { return 'snapshot'; } })();
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename="${domain}-amostra.png"`);
  res.sendFile(previewPath);
});

// ── POST /api/set-page-order — Save user's drag-reorder ──────────────────────
app.post('/api/set-page-order', (req, res) => {
  const { jobId, pageOrder } = req.body || {};
  if (!jobId || !Array.isArray(pageOrder)) return res.status(400).json({ error: 'jobId e pageOrder obrigatórios.' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  setPageOrder(jobId, pageOrder);
  return res.json({ ok: true });
});

// ── POST /api/set-page-template — Assign template per page ───────────────────
app.post('/api/set-page-template', (req, res) => {
  const { jobId, pageUrl, templateId } = req.body || {};
  if (!jobId || !pageUrl || !templateId) return res.status(400).json({ error: 'Campos obrigatórios.' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  setPageTemplate(jobId, pageUrl, templateId);
  return res.json({ ok: true });
});

// ── POST /api/set-page-setting — Toggle per-page settings ────────────────────
app.post('/api/set-page-setting', (req, res) => {
  const { jobId, pageUrl, key, value } = req.body || {};
  if (!jobId || !pageUrl || !key) return res.status(400).json({ error: 'Campos obrigatórios.' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  setPageSetting(jobId, pageUrl, key, value);
  return res.json({ ok: true });
});

// ── Rota de teste do Sentry (desenvolvimento apenas) ─────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.get('/api/sentry-test', (_req, _res) => {
    throw new Error('Teste do Sentry — SnapShot.pro funcionando corretamente');
  });
}

// ── Global error handler (Sentry + fallback) ──────────────────────────────────
Sentry.setupExpressErrorHandler(app);
app.use((err, _req, res, _next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Algo deu errado. Por favor, tente novamente.' });
});

// ── syncTemplates — garante que todo template do renderer existe no JSON ───────
function syncTemplates() {
  let templates;
  try { templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')); }
  catch { templates = []; }

  // IDs que o renderer conhece (48 novos IDs — 4 categorias)
  const RENDERER_IDS = [
    // device — free (6)
    'void', 'chrome', 'paper', 'float', 'annotation', 'story',
    // device — starter (6)
    'macbook', 'iphone-pro', 'tablet', 'duo-split', 'device-glow', 'browser-dark',
    // editorial — starter (6)
    'magazine-cover', 'spread', 'poster-a4', 'zine', 'newspaper', 'film-frame',
    // editorial — pro (6)
    'white-space', 'minimal-dark', 'grid-lines', 'ruled', 'dot-matrix', 'mono-line',
    // creative — pro (12)
    'gradient-mesh', 'neon-border', 'duotone', 'color-block', 'retro-wave', 'aurora',
    'blueprint', 'terminal', 'schematic', 'isometric', 'code-review', 'dashboard-panel',
    // social — agency (12)
    'cinematic', 'polaroid', 'diorama', 'glitch', 'vaporwave', 'noir',
    'linkedin-banner', 'twitter-card', 'instagram-post', 'og-image', 'presentation-slide', 'whatsapp-preview',
  ];

  const existingIds = new Set(templates.map(t => t.id));
  let changed = false;

  const FREE_IDS = new Set(['void', 'chrome', 'paper', 'float', 'annotation', 'story']);
  RENDERER_IDS.forEach((id, idx) => {
    if (!existingIds.has(id)) {
      templates.push({
        id, name: id.charAt(0).toUpperCase() + id.slice(1).replace(/([0-9])/g, ' $1'),
        key: id, category: 'professional',
        plan: FREE_IDS.has(id) ? 'free' : 'starter',
        description: `Template ${id}`,
        active: true, order: FREE_IDS.has(id) ? idx : 100 + idx,
      });
      changed = true;
      console.log(`[syncTemplates] adicionado template ausente: ${id}`);
    }
  });

  // Garantir campo order em todos
  templates.forEach((t, i) => {
    if (t.order === undefined) { t.order = i; changed = true; }
  });

  if (changed) fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
}

// ── Limpeza de screenshots orphan (a cada 1h) ─────────────────────────────────
setInterval(() => {
  try {
    if (!fs.existsSync(SS)) return;
    const dirs = fs.readdirSync(SS);
    for (const dir of dirs) {
      const full = path.join(SS, dir);
      try {
        const stat = fs.statSync(full);
        if (!stat.isDirectory()) continue;
        // Remover se o jobId não existe mais no Map de jobs
        const { getJob } = require('./jobs');
        if (!getJob(dir)) {
          fs.rmSync(full, { recursive: true, force: true });
          console.log(`[cleanup] removido orphan: ${dir}`);
        }
      } catch {}
    }
  } catch (err) {
    console.error('[cleanup] erro ao limpar orphans:', err.message);
  }
}, 60 * 60 * 1000);

app.listen(PORT, async () => {
  console.log(`SnapShot.pro rodando em http://localhost:${PORT}`);
  syncTemplates();
  await initBrowserPool();
});
