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
const helmet   = require('helmet');
const { validateUrl: secValidateUrl, validateJobId, sanitizeFilename, hasPrototypePollution, sanitizeBody } = require('./security');

const {
  createJob, markPaid, markDownloaded, markReady, markFailed, markQueued,
  updateCrawlResult, updateSelectedPages, updateRenderConfig,
  updateCaptureProgress, appendCrawlLog, addGalleryItem,
  getJob, getJobByShareToken, getAllJobIds, countActiveJobsByIp,
  incrementCounter, getCounter, setJobCaptureInfo,
  updatePageStatus, setPageTemplate, setPageOrder, setPageSetting, incrementManualPages, getManualPagesCount,
} = require('./jobs');

const storage = require('./storage');

const { crawlSite, groupPages, rankPages, deduplicatePages }                     = require('./crawler');
const { captureJobPages, initBrowserPool }                                        = require('./screenshotter');
const { renderProfessional }                                                     = require('./renderer');
const { createPixPayment, checkPixStatus,
        activatePayment, simulatePayment,
        verifyWebhookToken, getBillingEntry,
        claimConfirmationEmail, claimPixReminder }                               = require('./asaas');
const { sendPaymentConfirmed, sendSnapCode, sendInternalPaymentAlert,
        sendFreeLimitReached, sendFirstCapture,
        sendPixReminder }                                                         = require('./mailer');
const { storeIpEmail, getIpEmail, claimFirstCaptureEmail }                       = require('./ip-email-store');
const { generateCode, validateCode, decrementCode }                              = require('./codes');
const { validateSubscription, canCapture, incrementCaptures,
        checkDailyFreeLimit, incrementDailyFreeUsage }                           = require('./subscriptions');
const { sendAlert }                                                              = require('./telegram');
const { getPlanConfig, getConfig, reloadConfig }                                 = require('./config');

const app  = express();
app.set('trust proxy', 1); // trust first proxy (nginx/caddy) — makes req.ip reliable

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // CSP desabilitado: app usa inline scripts/styles
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.removeHeader('X-Powered-By');
  next();
});

// ── Response time middleware ───────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    responseTimes.unshift({ ms, route: req.path, method: req.method, status: res.statusCode, ts: Date.now() });
    if (responseTimes.length > 50) responseTimes.pop();
  });
  next();
});

// ── Maintenance mode ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (!maintenanceMode) return next();
  if (req.path.startsWith('/admin') || req.path.startsWith('/screenshots')) return next();
  res.status(503).json({ error: maintenanceMessage });
});

// ── X-Robots-Tag on all /admin/* ─────────────────────────────────────────────
app.use('/admin', (_req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex');
  next();
});

const PORT = process.env.PORT || 3001;
const SS   = path.join(__dirname, 'screenshots');

fs.mkdirSync(SS, { recursive: true });
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

// Seed: copia arquivos de data-seed/ para data/ se ainda não existirem (Railway volume)
const SEED_DIR = path.join(__dirname, 'data-seed');
if (fs.existsSync(SEED_DIR)) {
  for (const f of fs.readdirSync(SEED_DIR)) {
    const dest = path.join(__dirname, 'data', f);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(SEED_DIR, f), dest);
      console.log(`[seed] copiado ${f} para data/`);
    }
  }
}

const TEMPLATES_FILE = path.join(__dirname, 'data', 'templates.json');
const ERRORS_FILE    = path.join(__dirname, 'data', 'errors.json');
const CONFIG_FILE    = path.join(__dirname, 'data', 'config.json');
const BILLING_FILE   = path.join(__dirname, 'data', 'billing.json');
const SUBS_FILE      = path.join(__dirname, 'data', 'subscriptions.json');

// ── Circular log/error arrays ─────────────────────────────────────────────────
const recentErrors  = [];
const recentLogs    = [];
const responseTimes = [];
const MAX_LOG       = 500;
let   maintenanceMode    = false;
let   maintenanceMessage = 'Sistema em manutenção. Volte em breve.';

// ── Fila de captura — controle de concorrência ────────────────────────────────
const MAX_CONCURRENT_CAPTURES = parseInt(process.env.MAX_CONCURRENT_CAPTURES || '2', 10);
const MAX_QUEUE_SIZE          = 20;
let   _captureRunning         = 0;
const _captureQueue           = [];

function _getQueueStats() {
  return { waiting: _captureQueue.length, running: _captureRunning, maxConcurrent: MAX_CONCURRENT_CAPTURES, maxQueueSize: MAX_QUEUE_SIZE };
}

function enqueueCapture(jobId, fn) {
  return new Promise((resolve, reject) => {
    if (_captureQueue.length >= MAX_QUEUE_SIZE) {
      const err = new Error('Servidor ocupado. Tente novamente em instantes.');
      err.queueFull = true;
      return reject(err);
    }
    const position = _captureRunning + _captureQueue.length + 1;
    if (jobId) {
      markQueued(jobId, position);
      appendCrawlLog(jobId, `[Queue] Job enfileirado — posição ${position}`);
    }
    _captureQueue.push({ jobId, fn, resolve, reject });
    _drainCaptureQueue();
  });
}

function _drainCaptureQueue() {
  if (_captureRunning >= MAX_CONCURRENT_CAPTURES || _captureQueue.length === 0) return;
  const { jobId, fn, resolve, reject } = _captureQueue.shift();
  _captureRunning++;
  // Atualizar posição de fila dos jobs restantes
  _captureQueue.forEach((item, i) => {
    if (item.jobId) {
      markQueued(item.jobId, _captureRunning + i + 1);
    }
  });
  if (jobId) {
    appendCrawlLog(jobId, `[Worker] Iniciando captura`);
    // Restaurar status 'capturing' — markQueued() sobrescreveu o status que updateRenderConfig() setou
    const _j = getJob(jobId);
    if (_j && _j.status === 'queued') _j.status = 'capturing';
  }
  Promise.resolve().then(fn).then(resolve, reject).finally(() => {
    _captureRunning--;
    _drainCaptureQueue();
  });
}

// ── Usuários ativos (sliding window de 5 minutos) ─────────────────────────────
const activeUsersMap = new Map(); // code → { ts, plan, ip, route }
const ACTIVE_WINDOW  = 5 * 60 * 1000; // 5 min

function touchActiveUser(code, plan, ip, route) {
  if (!code) return;
  activeUsersMap.set(code, { ts: Date.now(), plan: plan || 'unknown', ip, route });
}
function getActiveUsers() {
  const cutoff = Date.now() - ACTIVE_WINDOW;
  const alive  = [];
  for (const [code, e] of activeUsersMap) {
    if (e.ts >= cutoff) alive.push({ code, ...e });
    else activeUsersMap.delete(code);
  }
  return alive.sort((a, b) => b.ts - a.ts);
}
// Limpar entradas expiradas a cada minuto
setInterval(getActiveUsers, 60_000).unref();

function pushLog(level, message, meta = {}) {
  recentLogs.unshift({ level, message, meta, ts: Date.now() });
  if (recentLogs.length > MAX_LOG) recentLogs.pop();
}
function pushError(type, message, route = null) {
  const existing = recentErrors.find(e => e.type === type && e.message === message);
  if (existing) { existing.count++; existing.lastSeen = Date.now(); return; }
  const crypto = require('crypto');
  recentErrors.unshift({ id: crypto.randomUUID(), type, message, route, count: 1, firstSeen: Date.now(), lastSeen: Date.now() });
  if (recentErrors.length > MAX_LOG) recentErrors.pop();
}

// Intercept console → pushLog
const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);
console.log   = (...a) => { _log(...a);   pushLog('INFO',  a.join(' ')); };
console.warn  = (...a) => { _warn(...a);  pushLog('WARN',  a.join(' ')); };
console.error = (...a) => { _error(...a); pushLog('ERROR', a.join(' ')); pushError('SERVER_ERROR', a.join(' ').slice(0, 200)); };

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
const rlDownloadSample   = makeRateLimiter(10);

// ── Progressive blocking for validate-code ────────────────────────────────────
// After 5 failed attempts, block the IP with exponential back-off (up to 1 hour)
const _validateFailures = new Map(); // ip → { count, blockedUntil }
function validateCodeBlocker(req, res, next) {
  const ip  = clientIp(req);
  const now = Date.now();
  const rec = _validateFailures.get(ip);
  if (rec && rec.blockedUntil && now < rec.blockedUntil) {
    const secs = Math.ceil((rec.blockedUntil - now) / 1000);
    return res.status(429).json({ error: `Muitas tentativas inválidas. Aguarde ${secs}s.` });
  }
  next();
}
function recordValidateFailure(ip) {
  const rec   = _validateFailures.get(ip) || { count: 0, blockedUntil: 0 };
  rec.count  += 1;
  if (rec.count >= 5) {
    // 30s, 60s, 2min, 5min, 10min, 30min, 60min cap
    const step    = Math.min(rec.count - 5, 6);
    const delays  = [30, 60, 120, 300, 600, 1800, 3600];
    rec.blockedUntil = Date.now() + delays[step] * 1000;
  }
  _validateFailures.set(ip, rec);
}
function resetValidateFailures(ip) {
  _validateFailures.delete(ip);
}
// Prune old records every 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _validateFailures) {
    if (rec.blockedUntil < now - 2 * 60 * 60 * 1000) _validateFailures.delete(ip);
  }
}, 2 * 60 * 60 * 1000);

function clientIp(req) {
  // req.ip is resolved correctly by Express when trust proxy is set
  return req.ip || req.socket.remoteAddress || 'unknown';
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

// ── Envio de emails de confirmação de pagamento (idempotente) ────────────────
// Chamado tanto pelo webhook quanto pelo polling de pix-status.
// claimConfirmationEmail garante que apenas UM dos dois disparará o email.
async function dispatchPaymentEmails(pixId, plan, webhookEventData) {
  if (!claimConfirmationEmail(pixId)) return; // já enviado por outro caminho

  try {
    const entry    = getBillingEntry(pixId);
    const cust     = (entry && entry.customer) || {};
    // Fallback: AbacatePay às vezes inclui customer no payload do webhook
    const evCust   = (webhookEventData && webhookEventData.customer) || {};
    const emailTo  = cust.email  || evCust.email  || evCust.email_address || null;
    const custName = cust.name   || evCust.name   || evCust.full_name    || null;

    // Webhook envia valor em centavos; billing entry guarda em reais
    const amountCents = webhookEventData && webhookEventData.amount;
    const amountReais = entry && entry.amount;
    const amountFmt   = amountCents
      ? `R$ ${(amountCents / 100).toFixed(2).replace('.', ',')}`
      : (amountReais ? `R$ ${Number(amountReais).toFixed(2).replace('.', ',')}` : null);

    console.log(`[mailer] dispatchPaymentEmails — pixId:${pixId} emailTo:${emailTo || '(nenhum)'} plano:${plan} valor:${amountFmt}`);

    if (emailTo) {
      const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);

      // Email 1: confirmação de pagamento
      const r1 = await sendPaymentConfirmed({
        to:     emailTo,
        name:   custName || undefined,
        plan:   planLabel,
        amount: amountFmt,
      });
      console.log(`[mailer] sendPaymentConfirmed result:`, JSON.stringify(r1));

      // Email 2: código SNAP — aguarda 4s para garantir entrega após o email 1
      const accessCode = entry && entry.accessCode;
      if (accessCode) {
        await new Promise(r => setTimeout(r, 800));
        const r2 = await sendSnapCode({
          to:   emailTo,
          name: custName || undefined,
          code: accessCode,
          plan: planLabel,
        });
        console.log(`[mailer] sendSnapCode result:`, JSON.stringify(r2));
      } else {
        console.warn(`[mailer] sendSnapCode ignorado — accessCode nao encontrado para pixId:${pixId}`);
      }
    } else {
      console.warn('[mailer] emails de confirmação ignorados — nenhum email encontrado para pixId:', pixId);
    }

    await sendInternalPaymentAlert({
      customerEmail: emailTo,
      plan,
      amount:      amountFmt,
      pixTxId:     pixId,
      activatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[mailer] erro em dispatchPaymentEmails:', err.message);
  }
}

// ── Webhook Asaas ─────────────────────────────────────────────────────────────
app.post('/api/webhook/asaas', express.json(), async (req, res) => {
  if (!verifyWebhookToken(req)) {
    console.warn('[Webhook Asaas] Token invalido');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { event, payment } = req.body || {};
  console.log(`[Webhook Asaas] evento:${event} paymentId:${payment?.id} status:${payment?.status}`);

  if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') {
    if (!payment?.id) return res.status(200).end();
    try {
      let plan = 'starter';
      if (payment.externalReference) {
        const m = payment.externalReference.match(/snapdeck-(\w+)-/);
        if (m) plan = m[1];
      }
      const { accessCode } = await activatePayment(payment.id, plan);
      sendAlert(`💰 Novo pagamento Asaas!\nPlano: ${plan}\nCódigo: ${accessCode}`);
      setImmediate(() => dispatchPaymentEmails(payment.id, plan, null));
    } catch (err) {
      console.error('[Webhook Asaas] Erro:', err.message);
    }
  }

  return res.status(200).json({ received: true });
});

// Rota antiga AbacatePay — descontinuada
app.post('/api/webhook/abacatepay', (_req, res) => res.status(410).json({ error: 'Descontinuado. Use /api/webhook/asaas' }));

// Compat: rota legada sem assinatura (aceita mas não verifica)
app.post('/api/webhook', express.json(), (_req, res) => res.status(200).json({ ok: true }));

app.use(express.json({ limit: '1mb', strict: true }));

// Bloquear prototype pollution em todos os bodies JSON
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    if (hasPrototypePollution(req.body)) {
      console.warn(`[Security] Prototype pollution attempt de ${clientIp(req)}`);
      return res.status(400).json({ error: 'Input inválido.' });
    }
    req.body = sanitizeBody(req.body);
  }
  next();
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));
// Serve screenshot assets only for jobs that exist in memory (prevents orphan file enumeration)
app.get('/screenshots/:jobId/*', (req, res) => {
  const { jobId } = req.params;
  if (!getJob(jobId)) return res.status(404).end();
  // Prevent path traversal: resolve and ensure it stays inside SS/jobId
  const jobBase = path.resolve(SS, jobId);
  const reqPath = path.resolve(SS, jobId, req.params[0]);
  if (!reqPath.startsWith(jobBase + path.sep) && reqPath !== jobBase) return res.status(403).end();
  res.sendFile(reqPath, err => { if (err && !res.headersSent) res.status(404).end(); });
});

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
    if (r.valid && r.norm) touchActiveUser(r.norm, planKey, clientIp(req), req.path);
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
  { key: 'starter', name: 'Starter', priceCents: 1990,  priceLabel: 'R$ 19,90/mês',  monthlyCaptures: 60,   crawlLimit: 10,  cssSelector: false, manualPagesLimit: 2,   description: 'Screenshots sem marca d\'água, até 60 capturas/mês' },
  { key: 'pro',     name: 'Pro',     priceCents: 4990,  priceLabel: 'R$ 49,90/mês',  monthlyCaptures: -1,   crawlLimit: 20,  cssSelector: true,  manualPagesLimit: 10,  description: 'Capturas ilimitadas, templates exclusivos e exportação social' },
  { key: 'agency',  name: 'Agency',  priceCents: 12990, priceLabel: 'R$ 129,90/mês', monthlyCaptures: -1,   crawlLimit: 999, cssSelector: true,  manualPagesLimit: -1,  description: 'Tudo do Pro + 3 códigos de acesso e crawl ilimitado' },
];
app.get('/api/plans',    (_req, res) => res.json({ plans:    PLAN_INFO }));
app.get('/api/packages', (_req, res) => res.json({ packages: PLAN_INFO }));

// ── Validar código de acesso ──────────────────────────────────────────────────
app.post('/api/validate-code', rlValidateCode, validateCodeBlocker, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ valid: false, reason: 'Código obrigatório.' });
  const norm = code.trim().toUpperCase();
  const ip   = clientIp(req);
  if (norm.startsWith('SNAP-')) {
    const result = validateSubscription(norm);
    if (!result.valid) { recordValidateFailure(ip); return res.status(400).json(result); }
    resetValidateFailures(ip);
    return res.json({
      valid: true,
      info:  { plan: result.plan, remaining: result.capturesRemaining, isWatermarked: false },
    });
  }
  // Legado: códigos hex (codes.js)
  const result = validateCode(norm);
  if (!result.valid) { recordValidateFailure(ip); return res.status(400).json(result); }
  resetValidateFailures(ip);
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

  const cust = customer || {};

  // Validação CPF/CNPJ
  const cpfRaw    = typeof cust.cpfCnpj === 'string' ? cust.cpfCnpj : (typeof cust.cpf === 'string' ? cust.cpf : '');
  const cpfDigits = cpfRaw.replace(/\D/g, '');
  if (!cpfDigits || (cpfDigits.length !== 11 && cpfDigits.length !== 14)) {
    return res.status(400).json({ error: 'CPF ou CNPJ inválido.', field: 'cpfCnpj' });
  }

  // Validação telefone
  const phoneRaw    = typeof cust.cellphone === 'string' ? cust.cellphone : (typeof cust.phone === 'string' ? cust.phone : '');
  const phoneDigits = phoneRaw.replace(/\D/g, '');
  if (!phoneDigits || phoneDigits.length < 10 || phoneDigits.length > 11) {
    return res.status(400).json({ error: 'Número de telefone inválido.', field: 'cellphone' });
  }

  const apiKey = process.env.ASAAS_API_KEY || '';
  if (!apiKey || apiKey.length < 5) {
    return res.status(503).json({ error: 'Pagamento temporariamente indisponível.' });
  }

  const normalizedCustomer = {
    name:     cust.name   || '',
    email:    cust.email  || '',
    cpfCnpj:  cpfDigits,
    phone:    phoneDigits,
  };

  try {
    const result = await createPixPayment(plan, normalizedCustomer);

    // Store IP→email for first-capture email
    if (normalizedCustomer.email) {
      storeIpEmail(clientIp(req), normalizedCustomer.email, normalizedCustomer.name || null);
    }

    // Schedule PIX reminder (15 min)
    const _rPaymentId = result.paymentId;
    const _rEmail     = normalizedCustomer.email;
    const _rName      = normalizedCustomer.name || null;
    const _rPlan      = plan;
    const _rAmount    = result.amount ? `R$ ${Number(result.amount).toFixed(2).replace('.', ',')}` : null;
    if (_rEmail) {
      setTimeout(async () => {
        try {
          const entry = getBillingEntry(_rPaymentId);
          if (entry && entry.status === 'paid') return;
          if (!claimPixReminder(_rPaymentId)) return;
          await sendPixReminder({ to: _rEmail, name: _rName, plan: _rPlan, amount: _rAmount });
        } catch (e) { console.error('[pix-reminder]', e.message); }
      }, 15 * 60 * 1000);
    }

    const config  = readJsonFile(CONFIG_FILE, { plans: {} });
    const planName = (config.plans && config.plans[plan] && config.plans[plan].name) || plan;
    return res.json({ ...result, planName, devMode: process.env.ASAAS_ENV !== 'production' });
  } catch (err) {
    console.error('[create-pix] erro:', err.message);
    const msg = err.message || '';
    if (/cpf|cnpj|cpfCnpj/i.test(msg)) return res.status(400).json({ error: 'CPF ou CNPJ inválido.', field: 'taxId' });
    if (/api.*key|access_token|unauthorized/i.test(msg)) return res.status(503).json({ error: 'Pagamento temporariamente indisponível.' });
    if (/timeout/i.test(msg)) return res.status(503).json({ error: 'Asaas não respondeu a tempo. Tente novamente.' });
    return res.status(500).json({ error: 'Erro ao gerar PIX. Tente novamente.', _detail: msg.slice(0, 120) });
  }
});

// ── GET /api/pix-status — polling de status do PIX (nunca retorna 4xx/5xx) ───
app.get('/api/pix-status', async (req, res) => {
  const { paymentId } = req.query;
  if (!paymentId) return res.json({ status: 'pending', accessCode: null });
  try {
    const result = await checkPixStatus(paymentId);
    if (result.status === 'paid') {
      setImmediate(() => dispatchPaymentEmails(paymentId, result.plan || 'starter', null));
    }
    return res.json(result);
  } catch {
    return res.json({ status: 'pending', accessCode: null });
  }
});

// ── POST /api/simulate-pix — simula pagamento PIX (dev/admin only) ───────────
app.post('/api/simulate-pix', express.json(), async (req, res) => {
  const { paymentId } = req.body || {};
  if (!paymentId) return res.status(400).json({ error: 'paymentId obrigatório.' });
  try {
    const result = await simulatePayment(paymentId);
    if (result.accessCode) {
      sendAlert(`💰 Simulação Asaas confirmada!\nPlano: ${result.plan}\nCódigo: ${result.accessCode}`);
      setImmediate(() => dispatchPaymentEmails(paymentId, result.plan || 'starter', null));
    }
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
  const reqOut = lib.request({ method: 'HEAD', hostname: parsed.hostname, path: parsed.pathname + parsed.search, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 SnapDeck-Validator/1.0' } }, rsp => {
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
  createJob(jobId, { subscriptionCode: validatedCode, creatorIp: clientIp(req) });

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
  const rankedPages = deduplicatePages(rankPages(job.pages || []));
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
      const rp = deduplicatePages(rankPages(j.pages || []));
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
  const uniqueUrls = [...new Set(selectedUrls)];
  if (uniqueUrls.length > 12) return res.status(400).json({ error: 'Máximo de 12 páginas.' });
  const discovered = new Set(job.pages.map(p => p.url));
  for (const u of uniqueUrls) {
    if (!discovered.has(u)) return res.status(400).json({ error: `URL desconhecida: ${u}` });
  }
  updateSelectedPages(jobId, uniqueUrls);
  return res.json({ jobId, status: 'configuring' });
});

// ── POST /api/start-capture ───────────────────────────────────────────────────
app.post('/api/start-capture', rlStartCapture, (req, res) => {
  const { jobId, renderConfig, notifyEmail } = req.body || {};
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
      if (notifyEmail && notifyEmail.includes('@')) {
        setImmediate(() => {
          sendFreeLimitReached({ to: notifyEmail, limit: dayLimit })
            .catch(e => console.error('[start-capture] erro email limite:', e.message));
        });
      }
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
  const reqTemplate    = cfg.template;
  const unlocked       = req.plan.templatesUnlocked;
  const _tplAllowed    = (t) => !t || t === 'void' || unlocked === 'all' || (Array.isArray(unlocked) && unlocked.includes(t));
  // 'void' and empty = no preference; renderer picks default-dark. Always allowed.
  if (!_tplAllowed(reqTemplate)) {
    return res.status(403).json({ error: 'Template não disponível no seu plano atual.', requiredPlan: 'starter' });
  }
  // Also check per-page template overrides
  if (cfg.pageTemplates && typeof cfg.pageTemplates === 'object') {
    for (const tplId of Object.values(cfg.pageTemplates)) {
      if (!_tplAllowed(tplId)) {
        return res.status(403).json({ error: 'Template não disponível no seu plano atual.', requiredPlan: 'starter' });
      }
    }
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
  // Free plan always gets watermark; paid plans explicitly have watermark:false in config
  const applyWatermark = req.planKey === 'free' ? true : (req.plan && req.plan.watermark === true);
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

  // Verificar capacidade da fila ANTES de enfileirar (para poder responder 503 imediatamente)
  if (_captureQueue.length >= MAX_QUEUE_SIZE) {
    markFailed(jobId, 'Sistema ocupado. Tente novamente em instantes.');
    return res.status(503)
      .set('Retry-After', '30')
      .json({ error: 'Sistema ocupado. Tente novamente em alguns instantes.', retryAfter: 30 });
  }

  enqueueCapture(jobId, async () => {
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
            sendAlert(`⚠️ <b>SnapDeck.pro</b> — 3 falhas consecutivas\nURL: ${pageUrl}\nJob: ${jobId}`);
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

    // Email de primeira captura (fire-and-forget, enviado apenas uma vez por usuário)
    setImmediate(async () => {
      try {
        const identifier = subCode || `ip:${reqIp}`;
        if (!claimFirstCaptureEmail(identifier)) return;
        const ipData = getIpEmail(reqIp);
        if (!ipData || !ipData.email) return;
        await sendFirstCapture({ to: ipData.email, name: ipData.name || undefined });
      } catch (e) {
        console.error('[first-capture-email] erro:', e.message);
      }
    });
  }).catch(err => {
    console.error('[capture] queue error:', err.message);
    markFailed(jobId, err.message);
  });

  return res.status(202).json({ jobId, status: 'queued' });
});

// ── GET /api/capture-progress/:jobId ─────────────────────────────────────────
app.get('/api/capture-progress/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  const cp = job.captureProgress || {};
  return res.json({
    status:          job.status,
    captureProgress: cp,
    gallery:         job.gallery || [],
    applyWatermark:  job.applyWatermark !== undefined ? job.applyWatermark : true,
    queuePosition:   job.status === 'queued' ? cp.queuePosition : null,
    queueStats:      _getQueueStats(),
    // Aliases semânticos para o frontend (mais legíveis que cp.completed/total/current)
    currentPage: cp.completed || 0,
    totalPages:  cp.total     || 0,
    currentUrl:  cp.current   || '',
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

// ── HEAD /api/download/:jobId — preflight check (frontend usa antes do GET) ───
app.head('/api/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!validateJobId(jobId)) return res.status(400).end();
  const job = getJob(jobId);
  if (!job) return res.status(404).end();
  if (job.status !== 'ready' && job.status !== 'paid')
    return res.status(409).end();
  const jobDir = path.join(SS, jobId);
  if (!fs.existsSync(jobDir)) return res.status(410).end();
  const dlMode = (req.query.mode === 'desktop' || req.query.mode === 'mobile') ? req.query.mode : 'full';
  if (dlMode === 'mobile') {
    const anyMobile = (job.selectedPages || []).some((_, i) =>
      fs.existsSync(path.join(jobDir, `page-${String(i).padStart(2,'0')}`, 'mobile-professional.png'))
    );
    if (!anyMobile) return res.status(400).end();
  }
  res.status(200).end();
});

// ── GET /api/download/:jobId ──────────────────────────────────────────────────
// Sem paywall — imagens já têm ou não têm watermark queimada pelo renderer
app.get('/api/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!validateJobId(jobId)) return res.status(400).json({ error: 'ID de job inválido.' });
  const job = getJob(jobId);
  if (!job)   return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.status === 'downloaded') return res.status(410).json({ error: 'Arquivo já baixado anteriormente.' });
  if (job.status !== 'ready' && job.status !== 'paid')
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
  const rootDir = sanitizeFilename(`${domainName}-${dateTag}-${tmpl}`);

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
    markDownloaded(jobId);
    storage.deleteJobDirAsync(jobId);
  });

  archive.pipe(res);

  // ── Determinar modo e construir ZIP ──────────────────────────────────────────
  console.log(`[Download] jobId=${jobId} | mode=${dlMode} | pages=${(job.selectedPages||[]).length}`);

  const DESKTOP_NAMES = ['desktop-professional.png', 'desktop.png'];
  const MOBILE_NAMES  = ['mobile-professional.png',  'mobile.png'];

  function findFile(dir, names) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  const includeDesktop = dlMode === 'full' || dlMode === 'desktop';
  const includeMobile  = dlMode === 'full' || dlMode === 'mobile';

  let filesAdded = 0;

  for (let i = 0; i < (job.selectedPages || []).length; i++) {
    const pageUrl = job.selectedPages[i];
    const pDir    = path.join(jobDir, `page-${String(i).padStart(2, '0')}`);

    const slug = (() => {
      try {
        const p = new URL(pageUrl).pathname;
        return (p === '/' || !p) ? 'homepage' : p.replace(/^\//, '').replace(/\//g, '-').slice(0, 40) || 'page';
      } catch { return `page-${i + 1}`; }
    })();
    const folder = `${rootDir}/${String(i + 1).padStart(2, '0')}-${slug}`;

    const desktopFile = findFile(pDir, DESKTOP_NAMES);
    const mobileFile  = findFile(pDir, MOBILE_NAMES);

    console.log(`[Download] page-${String(i).padStart(2,'0')}: desktop=${desktopFile ? path.basename(desktopFile) : 'AUSENTE'} | mobile=${mobileFile ? path.basename(mobileFile) : 'AUSENTE'}`);

    if (includeDesktop && desktopFile) {
      archive.file(desktopFile, { name: `${folder}/desktop.png` });
      filesAdded++;
    }
    if (includeMobile && mobileFile) {
      archive.file(mobileFile, { name: `${folder}/mobile.png` });
      filesAdded++;
    }

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

  console.log(`[Download] Total arquivos no ZIP: ${filesAdded}`);

  if (filesAdded === 0) {
    return res.status(404).json({
      error: dlMode === 'mobile'
        ? 'Capturas mobile não disponíveis. Seu plano pode não incluir mobile.'
        : 'Nenhum arquivo encontrado. Tente fazer uma nova captura.'
    });
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

  // Capturas usadas este mês (para SNAP- codes)
  let capturesUsed = 0;
  let capturesRemaining = -1; // -1 = unlimited
  const _monthly = planCfg.capturesPerMonth !== undefined ? planCfg.capturesPerMonth : (planCfg.monthlyCaptures !== undefined ? planCfg.monthlyCaptures : -1);
  let capturesPerMonth = _monthly;

  if (req.accessCode && req.accessCode.startsWith('SNAP-')) {
    try {
      const r = validateSubscription(req.accessCode);
      if (r.valid) {
        // Usar capturesThisMonth real vs limite do config.json (não o limite gravado na assinatura)
        capturesUsed = r.capturesThisMonth || 0;
        if (_monthly !== null && _monthly !== -1) {
          capturesRemaining = Math.max(0, _monthly - capturesUsed);
        }
        // se _monthly === -1 (ilimitado), capturesRemaining permanece -1
      }
    } catch {}
  }

  // Capturas diárias usadas (para plano free — rastreadas por IP)
  let capturesUsedToday = 0;
  let capturesPerDay    = planCfg.capturesPerDay || 3;
  if (planKey === 'free') {
    const reqIp   = clientIp(req);
    const dayCheck = checkDailyFreeLimit(reqIp, capturesPerDay);
    capturesUsedToday = dayCheck.used;
    capturesRemaining = Math.max(0, capturesPerDay - capturesUsedToday);
  }

  res.json({
    plan:              planKey,
    planName:          planCfg.name || planKey,
    watermark:         planCfg.watermark !== false,
    templatesUnlocked: planCfg.templatesUnlocked || [],
    crawlLimit:        planCfg.crawlLimit || 6,
    monthlyCaptures:   capturesPerMonth,
    capturesPerMonth,
    capturesPerDay:    planKey === 'free' ? capturesPerDay : -1,
    capturesUsed,
    capturesUsedToday,
    capturesRemaining,
    cssSelector:       !!planCfg.cssSelector,
    apiAccess:         !!planCfg.apiAccess,
    manualPagesLimit:  planCfg.manualPagesLimit !== undefined ? planCfg.manualPagesLimit : 0,
    mobileCapture:     planCfg.mobileCapture !== false,
    deviceScaleFactor: planCfg.deviceScaleFactor || 1,
  });
});



// ── GET /share/:token ─────────────────────────────────────────────────────────
app.get('/share/:token', (req, res) => {
  const job = getJobByShareToken(req.params.token);
  if (!job) return res.status(404).send(`<!DOCTYPE html><html><head><title>Link Expirado</title><style>body{background:#0a0a0a;color:rgba(255,255,255,.6);font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}</style></head><body><div><div style="font-size:48px;font-weight:900;color:#fff;margin-bottom:12px;">SNAPDECK.PRO</div><p>Este link de prévia expirou ou não existe.</p></div></body></html>`);

  const domainName = (() => { try { return new URL(job.selectedPages[0] || '').hostname.replace('www.', ''); } catch { return 'snapshot'; } })();
  const cards = job.selectedPages.map((u, i) => {
        const pg      = job.pages.find(p => p.url === u);
        const preview = `/screenshots/${job.jobId}/page-${String(i).padStart(2, '0')}/preview.png`;
        return `<div style="background:#0f0f0f;border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden;">
          <div style="position:relative;"><img src="${preview}" style="width:100%;display:block;" onerror="this.style.display='none'">
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;"><span style="font-family:monospace;font-size:22px;font-weight:900;color:rgba(255,255,255,.4);letter-spacing:.1em;transform:rotate(-15deg);">SNAPDECK.PRO</span></div></div>
          <div style="padding:14px 16px;"><div style="font-size:14px;font-weight:600;color:rgba(255,255,255,.85);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${pg ? pg.title : u}</div><div style="font-size:12px;color:rgba(255,255,255,.35);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${u}</div></div>
        </div>`;
      }).join('');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>SnapDeck.pro — ${domainName}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0a0a0a;color:rgba(255,255,255,.92);font-family:'Outfit',sans-serif;min-height:100vh;padding:48px 24px;}
  .wrap{max-width:900px;margin:0 auto;}.logo{font-size:28px;font-weight:800;color:#fff;letter-spacing:-.02em;margin-bottom:8px;}
  .meta{font-size:13px;color:rgba(255,255,255,.35);margin-bottom:48px;}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;}
  .notice{margin-top:40px;font-size:13px;color:rgba(255,255,255,.25);text-align:center;}</style></head>
  <body><div class="wrap">
    <div class="logo">SnapDeck.pro</div>
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
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    // fallback para Windows quando rename falha (arquivo em uso)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── GET /admin ────────────────────────────────────────────────────────────────
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── GET /admin/api/queue — stats da fila de captura ──────────────────────────
app.get('/admin/api/queue', requireAdmin, (_req, res) => {
  res.json(_getQueueStats());
});

// ── GET /admin/storage ────────────────────────────────────────────────────────
app.get('/admin/storage', requireAdmin, (_req, res) => {
  const onDisk     = storage.listJobDirsOnDisk();
  const totalBytes = storage.getTotalStorageSize();
  const activeJobs = getAllJobIds();

  const details = onDisk.map(jobId => {
    const sizeBytes = storage.getJobDirSize(jobId);
    const dir = path.join(storage.SCREENSHOTS_BASE, jobId);
    let ageMin = null;
    try {
      const stat = fs.statSync(dir);
      ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);
    } catch {}
    return {
      jobId,
      sizeMB:       (sizeBytes / 1024 / 1024).toFixed(2),
      ageMinutes:   ageMin,
      inMemory:     activeJobs.includes(jobId),
      willExpireIn: ageMin !== null
        ? Math.max(0, Math.round(storage.MAX_AGE_MS / 60000) - ageMin)
        : null,
    };
  });

  res.json({
    summary: {
      jobsOnDisk:   onDisk.length,
      jobsInMemory: activeJobs.length,
      orphans:      onDisk.filter(id => !activeJobs.includes(id)).length,
      totalMB:      (totalBytes / 1024 / 1024).toFixed(2),
      maxAgeMinutes: storage.MAX_AGE_MS / 60000,
    },
    jobs: details,
  });
});

// ── POST /admin/storage/cleanup ───────────────────────────────────────────────
app.post('/admin/storage/cleanup', requireAdmin, (_req, res) => {
  storage.runCleanup(() => getAllJobIds());
  res.json({ ok: true, message: 'Cleanup executado.' });
});

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
  const subsData = (() => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'subscriptions.json'), 'utf8'));
      return Object.values(s).filter(x => x.active && Date.now() <= x.validUntil).length;
    } catch { return 0; }
  })();
  const dailyData = (() => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'daily-usage.json'), 'utf8'));
      return Object.values(d).reduce((sum, e) => sum + (e.count || 0), 0);
    } catch { return 0; }
  })();
  res.json({
    jobsActive:           getAllJobIds().length,
    capturesToday:        dailyData,
    capturesTotal:        getCounter(),
    diskUsageMB:          diskMB,
    activeSubscriptions:  subsData,
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
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Política de Privacidade — SnapDeck.pro</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:720px;margin:48px auto;padding:0 24px;background:#0a0a0a;color:rgba(255,255,255,0.85);line-height:1.7;}h1{font-size:28px;margin-bottom:8px;}h2{font-size:18px;margin-top:32px;color:rgba(255,255,255,0.7);}p,li{font-size:15px;color:rgba(255,255,255,0.65);}a{color:#fff;}header{margin-bottom:40px;}.back{font-size:13px;color:rgba(255,255,255,0.4);text-decoration:none;}</style>
  </head><body>
  <a class="back" href="/">← Voltar</a>
  <header><h1>Política de Privacidade</h1><p style="font-size:13px;color:rgba(255,255,255,0.35);">Última atualização: ${new Date().toLocaleDateString('pt-BR')}</p></header>
  <h2>1. Quem somos</h2><p>SnapDeck.pro é um serviço de captura de screenshots profissionais de sites. Contato: contato@snapshot.pro</p>
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
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Termos de Uso — SnapDeck.pro</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:720px;margin:48px auto;padding:0 24px;background:#0a0a0a;color:rgba(255,255,255,0.85);line-height:1.7;}h1{font-size:28px;margin-bottom:8px;}h2{font-size:18px;margin-top:32px;color:rgba(255,255,255,0.7);}p,li{font-size:15px;color:rgba(255,255,255,0.65);}a{color:#fff;}header{margin-bottom:40px;}.back{font-size:13px;color:rgba(255,255,255,0.4);text-decoration:none;}</style>
  </head><body>
  <a class="back" href="/">← Voltar</a>
  <header><h1>Termos de Uso</h1><p style="font-size:13px;color:rgba(255,255,255,0.35);">Última atualização: ${new Date().toLocaleDateString('pt-BR')}</p></header>
  <h2>1. Aceitação</h2><p>Ao utilizar o SnapDeck.pro você concorda com estes termos. Se não concordar, não utilize o serviço.</p>
  <h2>2. Uso permitido</h2><p>O serviço destina-se exclusivamente à captura de screenshots de sites públicos para fins legítimos (portfólio, documentação, apresentações). É proibido capturar conteúdo que viole direitos de terceiros.</p>
  <h2>3. Uso proibido</h2><ul><li>Capturar sites com conteúdo ilegal</li><li>Tentar contornar limites do plano</li><li>Revender ou redistribuir o serviço sem autorização</li><li>Uso automatizado sem contratar o plano Agency com acesso à API</li></ul>
  <h2>4. Planos e pagamentos</h2><p>Os pagamentos são processados pelo AbacatePay via PIX. Planos mensais expiram após 30 dias. Não há reembolso após a ativação do código de acesso.</p>
  <h2>5. Disponibilidade</h2><p>O serviço é fornecido "como está". Não garantimos disponibilidade contínua nem resultados específicos na captura de screenshots.</p>
  <h2>6. Limitação de responsabilidade</h2><p>O SnapDeck.pro não se responsabiliza por danos decorrentes do uso ou impossibilidade de uso do serviço.</p>
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
      headers: { 'User-Agent': 'Mozilla/5.0 SnapDeck-Detector/1.0' },
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
app.get('/api/download-sample/:jobId', rlDownloadSample, async (req, res) => {
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
    throw new Error('Teste do Sentry — SnapDeck.pro funcionando corretamente');
  });
}

// ── Global error handler (Sentry + fallback) ──────────────────────────────────
Sentry.setupExpressErrorHandler(app);
app.use((err, _req, res, _next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Algo deu errado. Por favor, tente novamente.' });
});

// ── syncTemplates — garante que somente os 32 templates autorizados existem no JSON ───────
function syncTemplates() {
  let templates;
  try { templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')); }
  catch { templates = []; }

  // Lista autoritativa dos 32 IDs permitidos
  const TEMPLATE_IDS_AUTORIZADOS = [
    // BÁSICO — free
    'browser-clean', 'minimal-clean', 'social-basic', 'mobile-simple', 'gradient-basic', 'default-dark',
    // SOCIAL — starter
    'instagram-post', 'instagram-story', 'twitter-post', 'linkedin-post', 'whatsapp-share', 'carousel-post', 'ad-style', 'viral-frame',
    // PROFISSIONAL — starter
    'presentation-slide', 'pitch-deck', 'proposal-clean', 'case-study', 'portfolio-showcase', 'corporate-clean',
    // DISPOSITIVOS — starter
    'macbook-realistic', 'macbook-clean', 'iphone-pro', 'iphone-dark', 'multi-device', 'browser-premium',
    // MARKETING — starter
    'hero-section', 'landing-highlight', 'feature-showcase', 'comparison-before-after', 'gradient-premium', 'spotlight-product',
  ];

  const whitelist = new Set(TEMPLATE_IDS_AUTORIZADOS);

  // Remover templates que não estão na whitelist
  const before = templates.length;
  templates = templates.filter(t => whitelist.has(t.id));
  if (templates.length !== before) {
    console.log(`[syncTemplates] removidos ${before - templates.length} templates não autorizados`);
  }

  const existingIds = new Set(templates.map(t => t.id));
  let changed = (templates.length !== before);

  const FREE_IDS = new Set(['browser-clean', 'minimal-clean', 'social-basic', 'mobile-simple', 'gradient-basic', 'default-dark']);

  TEMPLATE_IDS_AUTORIZADOS.forEach((id, idx) => {
    if (!existingIds.has(id)) {
      templates.push({
        id, name: id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' '),
        key: id, category: FREE_IDS.has(id) ? 'basico' : 'starter',
        plan: FREE_IDS.has(id) ? 'free' : 'starter',
        description: `Template ${id}`,
        active: true, order: idx,
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

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN API v2 — todas as rotas usam x-admin-key para autenticação
// ══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

function adminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || '';
  const pw  = process.env.ADMIN_PASSWORD || '';
  if (!key || !pw) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const a = Buffer.from(key.padEnd(64).slice(0, 64));
    const b = Buffer.from(pw.padEnd(64).slice(0, 64));
    if (!crypto.timingSafeEqual(a, b)) throw new Error();
  } catch { return res.status(401).json({ error: 'Unauthorized' }); }
  next();
}

const adminRouter = express.Router();
adminRouter.use(express.json());
adminRouter.use(adminKey);
adminRouter.use((req, _res, next) => {
  pushLog('ADMIN', `${req.method} ${req.path}`, { ip: clientIp(req) });
  next();
});

// helpers
function readSubs()    { return readJsonFile(SUBS_FILE, {}); }
function writeSubs(d)  { writeJsonFile(SUBS_FILE, d); }
function readBilling() { return readJsonFile(BILLING_FILE, {}); }
function writeBilling(d) { writeJsonFile(BILLING_FILE, d); }

function subsStats() {
  const subs   = readSubs();
  const now    = Date.now();
  const prices = { starter: 1990, pro: 4990, agency: 12990 };
  let mrr = 0, paying = 0;
  const byPlan = { free: 0, starter: 0, pro: 0, agency: 0 };
  for (const s of Object.values(subs)) {
    const active = s.active && now <= s.validUntil;
    const plan   = s.plan || 'free';
    if (active) {
      byPlan[plan] = (byPlan[plan] || 0) + 1;
      if (prices[plan]) { mrr += prices[plan]; paying++; }
    }
  }
  return { mrr, paying, byPlan };
}

function dailyTotal() {
  try {
    const d = readJsonFile(path.join(__dirname, 'data', 'daily-usage.json'), {});
    return Object.values(d).reduce((s, e) => s + (e.count || 0), 0);
  } catch { return 0; }
}

// ── GET /admin/api/overview ────────────────────────────────────────────────────
adminRouter.get('/overview', (_req, res) => {
  const { mrr, paying, byPlan } = subsStats();
  const billing   = readBilling();
  const subs      = readSubs();
  const now       = Date.now();
  const freeUsers = Object.values(subs).filter(s => !s.active || now > s.validUntil).length;
  const totalUsers = Object.keys(subs).length;
  const conversion = totalUsers > 0 ? Math.round((paying / totalUsers) * 100) : 0;
  const lastPays  = Object.values(billing)
    .filter(b => b.status === 'paid' || b.status === 'RECEIVED')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 5)
    .map(b => ({ id: b.pixId || b.id, plan: b.plan, status: b.status, createdAt: b.createdAt, email: b.email }));
  res.json({ mrr, paying, byPlan, freeUsers, totalUsers, conversion, capturesToday: dailyTotal(), capturesTotal: getCounter(), uptime: Math.floor(process.uptime()), lastPayments: lastPays });
});

// ── GET /admin/api/users ───────────────────────────────────────────────────────
adminRouter.get('/users', (_req, res) => {
  const subs = readSubs();
  const now  = Date.now();
  const list = Object.entries(subs).map(([code, s]) => ({
    code, plan: s.plan, active: s.active && now <= s.validUntil,
    capturesThisMonth: s.capturesThisMonth || 0,
    capturesLimit: s.capturesLimit,
    validUntil: s.validUntil,
    createdAt: s.createdAt,
    lastUsed: s.lastUsed || null,
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(list);
});

adminRouter.post('/users/:code/revoke', (req, res) => {
  const subs = readSubs(); const code = req.params.code.toUpperCase();
  if (!subs[code]) return res.status(404).json({ error: 'Código não encontrado' });
  subs[code].active = false;
  writeSubs(subs);
  pushLog('ADMIN', `revoked user ${code}`, { ip: clientIp(req) });
  res.json({ ok: true });
});

adminRouter.post('/users/:code/extend', (req, res) => {
  const subs = readSubs(); const code = req.params.code.toUpperCase();
  if (!subs[code]) return res.status(404).json({ error: 'Código não encontrado' });
  const days = parseInt(req.body.days || 30, 10);
  subs[code].validUntil = Math.max(subs[code].validUntil || Date.now(), Date.now()) + days * 86400000;
  subs[code].active = true;
  writeSubs(subs);
  pushLog('ADMIN', `extended user ${code} by ${days}d`);
  res.json({ ok: true, validUntil: subs[code].validUntil });
});

adminRouter.post('/users/:code/reset-captures', (req, res) => {
  const subs = readSubs(); const code = req.params.code.toUpperCase();
  if (!subs[code]) return res.status(404).json({ error: 'Código não encontrado' });
  subs[code].capturesThisMonth = 0;
  writeSubs(subs);
  pushLog('ADMIN', `reset captures for ${code}`);
  res.json({ ok: true });
});

adminRouter.post('/users/:code/change-plan', (req, res) => {
  const subs = readSubs(); const code = req.params.code.toUpperCase();
  if (!subs[code]) return res.status(404).json({ error: 'Código não encontrado' });
  const { plan } = req.body;
  if (!['starter','pro','agency'].includes(plan)) return res.status(400).json({ error: 'Plano inválido' });
  subs[code].plan = plan;
  writeSubs(subs);
  pushLog('ADMIN', `changed plan of ${code} to ${plan}`);
  res.json({ ok: true });
});

// ── GET /admin/api/payments ────────────────────────────────────────────────────
adminRouter.get('/payments', (_req, res) => {
  const billing = readBilling();
  const list = Object.values(billing)
    .map(b => ({ id: b.pixId || b.id, plan: b.plan, status: b.status, createdAt: b.createdAt, email: b.email, accessCode: b.accessCode, value: b.value }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(list);
});

adminRouter.post('/payments/:id/activate', async (req, res) => {
  const billing = readBilling();
  const entry   = Object.values(billing).find(b => (b.pixId || b.id) === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Pagamento não encontrado' });
  try {
    const { plan } = entry;
    const code = generateCode(999999, plan);
    entry.accessCode = code; entry.status = 'paid';
    writeBilling(billing);
    pushLog('ADMIN', `manually activated payment ${req.params.id} → ${code}`);
    res.json({ ok: true, code });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.post('/payments/:id/resend-email', async (req, res) => {
  const billing = readBilling();
  const entry   = Object.values(billing).find(b => (b.pixId || b.id) === req.params.id);
  if (!entry || !entry.accessCode) return res.status(400).json({ error: 'Sem código para reenviar' });
  try {
    await dispatchPaymentEmails(entry.pixId || entry.id, entry.plan, null);
    pushLog('ADMIN', `resent email for payment ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.post('/payments/:id/refund', (req, res) => {
  const billing = readBilling();
  const entry   = Object.values(billing).find(b => (b.pixId || b.id) === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Pagamento não encontrado' });
  entry.status = 'refunded';
  writeBilling(billing);
  pushLog('ADMIN', `marked payment ${req.params.id} as refunded`);
  res.json({ ok: true });
});

// ── GET /admin/api/plans ────────────────────────────────────────────────────
adminRouter.get('/plans', (_req, res) => {
  const cfg = readJsonFile(CONFIG_FILE, { plans: {} });
  res.json(cfg.plans || {});
});

adminRouter.post('/plans/:plan/update', (req, res) => {
  const cfg  = readJsonFile(CONFIG_FILE, { plans: {} });
  const plan = req.params.plan;
  if (!cfg.plans[plan]) return res.status(404).json({ error: 'Plano não encontrado' });
  Object.assign(cfg.plans[plan], req.body);
  writeJsonFile(CONFIG_FILE, cfg);
  reloadConfig();
  pushLog('ADMIN', `updated plan ${plan}`, { changes: req.body });
  res.json(cfg.plans[plan]);
});

// ── GET /admin/api/usage ────────────────────────────────────────────────────
adminRouter.get('/usage', (_req, res) => {
  const daily = readJsonFile(path.join(__dirname, 'data', 'daily-usage.json'), {});
  const subs  = readSubs();
  const top   = Object.entries(subs)
    .map(([code, s]) => ({ code, total: s.capturesThisMonth || 0 }))
    .sort((a, b) => b.total - a.total).slice(0, 10);
  const active = Object.values(subs).filter(s => (s.capturesThisMonth || 0) > 0);
  const avg    = active.length ? Math.round(active.reduce((s, x) => s + x.capturesThisMonth, 0) / active.length) : 0;
  res.json({ daily, topUsers: top, avgCapturesPerUser: avg, totalToday: dailyTotal() });
});

// ── GET /admin/api/jobs ──────────────────────────────────────────────────────
adminRouter.get('/jobs', (req, res) => {
  const filter = req.query.status;
  const ids    = getAllJobIds();
  const list   = ids.map(id => {
    const j = getJob(id);
    return {
      jobId: id, url: j.url || (j.pages && j.pages[0] && j.pages[0].url) || '—',
      status: j.status, template: j.renderConfig && j.renderConfig.template,
      plan: j.capturedWithPlan || j.planKey || 'free',
      pages: j.selectedPages ? j.selectedPages.length : 0,
      ts: j.createdAt || 0,
      duration: j.completedAt && j.createdAt ? Math.round((j.completedAt - j.createdAt) / 1000) : null,
    };
  }).filter(j => !filter || filter === 'all' || j.status === filter)
    .sort((a, b) => b.ts - a.ts).slice(0, 50);
  res.json(list);
});

adminRouter.post('/jobs/:jobId/cancel', (req, res) => {
  const { jobId } = req.params;
  if (!validateJobId(jobId)) return res.status(400).json({ error: 'jobId inválido' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  markFailed(jobId, 'Cancelado pelo admin');
  storage.deleteJobDirAsync && storage.deleteJobDirAsync(jobId);
  pushLog('ADMIN', `cancelled job ${jobId}`);
  res.json({ ok: true });
});

adminRouter.get('/jobs/:jobId/inspect', (req, res) => {
  const { jobId } = req.params;
  if (!validateJobId(jobId)) return res.status(400).json({ error: 'jobId inválido' });
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  res.json(job);
});

// ── GET /admin/api/errors ────────────────────────────────────────────────────
adminRouter.get('/errors', (req, res) => {
  const type = req.query.type;
  const list = type ? recentErrors.filter(e => e.type === type) : recentErrors;
  res.json(list);
});

adminRouter.post('/errors/clear', (_req, res) => {
  recentErrors.length = 0;
  writeJsonFile(ERRORS_FILE, []);
  pushLog('ADMIN', 'cleared all errors');
  res.json({ ok: true });
});

// ── GET /admin/api/logs ──────────────────────────────────────────────────────
adminRouter.get('/logs', (req, res) => {
  const level  = req.query.level;
  const limit  = Math.min(parseInt(req.query.limit || 200, 10), 500);
  const list   = level ? recentLogs.filter(l => l.level === level) : recentLogs;
  res.json(list.slice(0, limit));
});

// ── GET /admin/api/status ────────────────────────────────────────────────────
adminRouter.get('/status', (_req, res) => {
  const diskMB = (() => {
    try {
      let total = 0;
      const walk = dir => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); try { const s = fs.statSync(p); if (s.isDirectory()) walk(p); else total += s.size; } catch {} } };
      walk(SS); return Math.round(total / 1024 / 1024);
    } catch { return 0; }
  })();
  const avgResponseMs = responseTimes.length
    ? Math.round(responseTimes.slice(0, 10).reduce((s, r) => s + r.ms, 0) / Math.min(responseTimes.length, 10))
    : 0;
  const lastWebhook = Object.values(readBilling()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  res.json({
    api:         { status: 'ok', avgResponseMs },
    browserPool: { active: getAllJobIds().filter(id => { const j = getJob(id); return j && j.status === 'capturing'; }).length },
    storage:     { diskMB, jobsOnDisk: storage.listJobDirsOnDisk ? storage.listJobDirsOnDisk().length : 0 },
    uptime:      Math.floor(process.uptime()),
    lastWebhook: lastWebhook ? { ts: lastWebhook.createdAt, plan: lastWebhook.plan } : null,
    recentErrors: recentErrors.length,
    recentLogs:   recentLogs.length,
    responseTimes: responseTimes.slice(0, 10),
  });
});

adminRouter.post('/status/ping', async (_req, res) => {
  const start = Date.now();
  res.json({ ok: true, ms: Date.now() - start, ts: Date.now() });
});

// ── Controles ────────────────────────────────────────────────────────────────
adminRouter.post('/controls/clear-jobs', (_req, res) => {
  const ids = getAllJobIds();
  ids.forEach(id => markFailed(id, 'Limpo pelo admin'));
  pushLog('ADMIN', `cleared ${ids.length} jobs from memory`);
  res.json({ ok: true, cleared: ids.length });
});

adminRouter.post('/controls/cleanup-storage', (_req, res) => {
  storage.runCleanup(() => getAllJobIds());
  pushLog('ADMIN', 'ran storage cleanup');
  res.json({ ok: true, message: 'Cleanup executado.' });
});

adminRouter.post('/controls/reload-config', (_req, res) => {
  reloadConfig();
  pushLog('ADMIN', 'reloaded config.json');
  res.json({ ok: true });
});

adminRouter.get('/controls/export-backup', (_req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="snapdeck-backup-${new Date().toISOString().slice(0,10)}.zip"`);
  const arch = archiver('zip', { zlib: { level: 6 } });
  arch.on('error', err => { if (!res.headersSent) res.status(500).end(); console.error('[backup]', err.message); });
  arch.pipe(res);
  const dataDir = path.join(__dirname, 'data');
  for (const f of fs.readdirSync(dataDir)) {
    if (f.endsWith('.json')) arch.file(path.join(dataDir, f), { name: f });
  }
  arch.finalize();
  pushLog('ADMIN', 'exported backup ZIP');
});

adminRouter.post('/controls/generate-code', (req, res) => {
  const { plan, captures } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'Plano obrigatório' });
  const count = captures ? parseInt(captures, 10) : 999999;
  try {
    const code = generateCode(count, plan);
    pushLog('ADMIN', `generated code ${code} for plan ${plan}`);
    res.json({ code, plan, captures: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.post('/controls/maintenance-mode', (req, res) => {
  const { enabled, message } = req.body || {};
  maintenanceMode    = !!enabled;
  if (message) maintenanceMessage = String(message);
  pushLog('ADMIN', `maintenance mode ${maintenanceMode ? 'ON' : 'OFF'}`, { message: maintenanceMessage });
  res.json({ ok: true, maintenanceMode, maintenanceMessage });
});

adminRouter.get('/controls/maintenance-status', (_req, res) => {
  res.json({ maintenanceMode, maintenanceMessage });
});

// ── GET /admin/api/active-users ────────────────────────────────────────────
adminRouter.get('/active-users', (_req, res) => {
  const users = getActiveUsers();
  res.json({ count: users.length, users, windowMs: ACTIVE_WINDOW });
});

// ── Asaas proxy (admin-only) ──────────────────────────────────────────────────
function adminAsaasReq(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const base = process.env.ASAAS_ENV === 'production'
      ? 'https://www.asaas.com'
      : 'https://sandbox.asaas.com';
    const url  = new URL(`/api/v3${endpoint}`, base);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        'access_token': process.env.ASAAS_API_KEY || '',
        'Content-Type': 'application/json',
        'User-Agent':   'SnapDeck-Admin/2.0',
      },
    };
    const req = https.request(opts, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: r.statusCode, body: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Asaas timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

adminRouter.get('/asaas/balance', async (_req, res) => {
  try {
    const r = await adminAsaasReq('GET', '/finance/getCurrentBalance');
    res.json(r.body);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.get('/asaas/diagnose', async (_req, res) => {
  const key = process.env.ASAAS_API_KEY || '';
  const env = process.env.ASAAS_ENV    || '';
  const base = env === 'production' ? 'https://www.asaas.com' : 'https://sandbox.asaas.com';
  let balanceResult = null, balanceError = null;
  try {
    const r = await adminAsaasReq('GET', '/finance/getCurrentBalance');
    balanceResult = r;
  } catch (e) { balanceError = e.message; }
  res.json({
    ASAAS_ENV:       env || '(não definida — usando sandbox)',
    ASAAS_API_KEY:   key ? `${key.slice(0,8)}…${key.slice(-4)} (${key.length} chars)` : '(não definida)',
    baseUrl:         base,
    balanceStatus:   balanceResult ? balanceResult.status : 'ERRO',
    balanceBody:     balanceResult ? balanceResult.body   : null,
    balanceError,
  });
});

adminRouter.get('/asaas/customers', async (req, res) => {
  try {
    const qs = new URLSearchParams({
      limit:  req.query.limit  || 20,
      offset: req.query.offset || 0,
      ...(req.query.name  && { name:  req.query.name }),
      ...(req.query.email && { email: req.query.email }),
    });
    const r = await adminAsaasReq('GET', `/customers?${qs}`);
    res.json(r.body);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.get('/asaas/charges', async (req, res) => {
  try {
    const qs = new URLSearchParams({
      limit:  req.query.limit  || 20,
      offset: req.query.offset || 0,
      ...(req.query.status   && { status:   req.query.status }),
      ...(req.query.customer && { customer: req.query.customer }),
      ...(req.query.dueDateGe && { dueDateGe: req.query.dueDateGe }),
      ...(req.query.dueDateLe && { dueDateLe: req.query.dueDateLe }),
    });
    const r = await adminAsaasReq('GET', `/payments?${qs}`);
    res.json(r.body);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.get('/asaas/charges/:id', async (req, res) => {
  try {
    const r = await adminAsaasReq('GET', `/payments/${req.params.id}`);
    res.json(r.body);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.get('/asaas/stats', async (_req, res) => {
  try {
    const [bal, recv, pend] = await Promise.all([
      adminAsaasReq('GET', '/finance/getCurrentBalance'),
      adminAsaasReq('GET', '/payments?status=RECEIVED&limit=100'),
      adminAsaasReq('GET', '/payments?status=PENDING&limit=100'),
    ]);
    res.json({
      balance:       bal.body.balance  || 0,
      totalReceived: recv.body.totalCount || 0,
      totalPending:  pend.body.totalCount || 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.use('/admin/api', adminRouter);

// ── Reconciliação de pagamentos PENDING ───────────────────────────────────────
// Escaneia billing.json a cada 3 minutos buscando pagamentos PENDING há > 2 min
// e consulta o Asaas para ver se já foram pagos. Garante que nenhum cliente
// pague e fique sem código por falha/atraso de webhook.
let _reconcileRunning = false;
async function reconcilePayments() {
  if (_reconcileRunning) return; // evita sobreposição de ciclos
  _reconcileRunning = true;
  const billing = readBilling();
  const now     = Date.now();
  const TWO_MIN = 2 * 60 * 1000;
  let activated = 0;

  for (const [id, entry] of Object.entries(billing)) {
    if (entry.status === 'RECEIVED' || entry.status === 'CONFIRMED' || entry.status === 'paid') continue;
    if (entry.status === 'REFUNDED' || entry.status === 'OVERDUE') continue;
    if (!entry.createdAt || (now - entry.createdAt) < TWO_MIN) continue;

    try {
      const result = await checkPixStatus(id);
      if (result.status === 'paid' && result.accessCode) {
        activated++;
        console.log(`[reconcile] ✓ ativado: ${id} → ${result.accessCode}`);
        setImmediate(() => dispatchPaymentEmails(id, result.plan || entry.plan || 'starter', null));
      }
    } catch (e) {
      // ignora erros individuais — tenta novamente no próximo ciclo
    }
  }

  if (activated > 0) {
    pushLog('INFO', `[reconcile] ${activated} pagamento(s) ativados`);
    sendAlert(`✅ Reconciliação: ${activated} pagamento(s) ativados automaticamente`).catch(() => {});
  }
  _reconcileRunning = false;
}

// ── Backup automático dos dados a cada 6h ────────────────────────────────────
function autoBackup() {
  try {
    const backupDir = path.join(__dirname, 'data', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const files = ['subscriptions.json', 'billing.json', 'config.json', 'daily-usage.json'];
    let copied  = 0;
    for (const f of files) {
      const src = path.join(__dirname, 'data', f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, `${ts}__${f}`));
        copied++;
      }
    }
    // Manter apenas os últimos 48 backups por arquivo (12 dias a cada 6h)
    const all = fs.readdirSync(backupDir).sort();
    const byFile = {};
    for (const f of all) {
      const key = f.split('__')[1] || f;
      if (!byFile[key]) byFile[key] = [];
      byFile[key].push(f);
    }
    for (const [, list] of Object.entries(byFile)) {
      if (list.length > 48) {
        list.slice(0, list.length - 48).forEach(old => {
          try { fs.unlinkSync(path.join(backupDir, old)); } catch {}
        });
      }
    }
    pushLog('INFO', `[backup] ${copied} arquivo(s) copiados`);
  } catch (e) {
    console.error('[backup] erro:', e.message);
  }
}

// ── Verificação de integridade na startup ────────────────────────────────────
function verifyDataIntegrity() {
  const critical = [SUBS_FILE, BILLING_FILE];
  for (const f of critical) {
    if (!fs.existsSync(f)) {
      console.warn(`[integrity] AVISO: ${path.basename(f)} não encontrado — criando vazio.`);
      fs.writeFileSync(f, '{}');
      continue;
    }
    try {
      const raw = fs.readFileSync(f, 'utf8');
      JSON.parse(raw); // valida JSON
    } catch (e) {
      const backup = f + '.corrupt.' + Date.now();
      console.error(`[integrity] CRÍTICO: ${path.basename(f)} corrompido — salvo como ${path.basename(backup)}`);
      try { fs.renameSync(f, backup); } catch {}
      fs.writeFileSync(f, '{}');
      sendAlert(`🚨 <b>CRÍTICO</b> — ${path.basename(f)} corrompido! Backup em ${path.basename(backup)}`).catch(() => {});
    }
  }
  console.log('[integrity] verificação concluída.');
}

app.listen(PORT, async () => {
  console.log(`SnapDeck.pro rodando em http://localhost:${PORT}`);
  verifyDataIntegrity();
  autoBackup(); // backup imediato na startup
  syncTemplates();
  await initBrowserPool();
  storage.startCleanupScheduler(() => getAllJobIds());
  setInterval(reconcilePayments, 3 * 60 * 1000).unref();  // a cada 3 min
  setInterval(autoBackup,        6 * 60 * 60 * 1000).unref(); // a cada 6h
  console.log('[scheduler] reconciliação de pagamentos e backup automático iniciados.');
});
