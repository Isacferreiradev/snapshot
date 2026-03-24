'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { generateSubscriptionCode } = require('./subscriptions');

const DATA_FILE  = path.join(__dirname, 'data', 'billing.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const API_BASE   = 'https://api.abacatepay.com';

const PLAN_NAMES = {
  starter: 'Plano Starter SnapShot.pro',
  pro:     'Plano Pro SnapShot.pro',
  agency:  'Plano Agency SnapShot.pro',
};

// ── Persistência ──────────────────────────────────────────────────────────────

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return { plans: {} }; }
}

function getPlanPrice(plan) {
  const cfg = getConfig();
  if (cfg.plans && cfg.plans[plan] && cfg.plans[plan].price) return cfg.plans[plan].price;
  // fallback para envvars
  const fallbacks = { starter: 1990, pro: 4990, agency: 12990 };
  return parseInt(process.env[`PRICE_${plan.toUpperCase()}_CENTS`] || fallbacks[plan] || 1990, 10);
}

// ── Criar QR Code PIX ─────────────────────────────────────────────────────────

/**
 * Cria um pagamento PIX transparente no AbacatePay.
 * @param {string} plan — 'starter' | 'pro' | 'agency'
 * @param {{ name?: string, email?: string, cpf?: string, phone?: string }} [customerData]
 * @returns {{ pixId, brCode, brCodeBase64, expiresAt, amount }}
 */
async function createPixPayment(plan, customerData) {
  if (!PLAN_NAMES[plan]) throw new Error(`Plano inválido: ${plan}`);

  const amount = getPlanPrice(plan);

  const body = {
    amount,
    description: PLAN_NAMES[plan],
    expiresIn:   3600,
    metadata:    { plan },
  };

  // Incluir dados do cliente se fornecidos
  if (customerData && (customerData.name || customerData.email)) {
    body.customer = {
      name:      customerData.name  || '',
      email:     customerData.email || '',
      taxId:     (customerData.cpf  || '').replace(/\D/g, '') || undefined,
      cellphone: (customerData.phone|| '').replace(/\D/g, '') || undefined,
    };
    // Remover campos undefined
    Object.keys(body.customer).forEach(k => body.customer[k] === undefined && delete body.customer[k]);
  }

  const res  = await fetch(`${API_BASE}/v1/pixQrCode/create`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.ABACATEPAY_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `AbacatePay HTTP ${res.status}`);

  const d = json.data;

  // Persistir estado pending
  const state = load();
  state[d.id] = {
    pixId:      d.id,
    plan,
    status:     'pending',
    accessCode: null,
    createdAt:  Date.now(),
    paidAt:     null,
    expiresAt:  d.expiresAt,
    customer:   customerData || null,
  };
  save(state);

  return {
    pixId:        d.id,
    brCode:       d.brCode,
    brCodeBase64: d.brCodeBase64,
    expiresAt:    d.expiresAt,
    amount:       d.amount || amount,
  };
}

// ── Verificar status do PIX ───────────────────────────────────────────────────

/**
 * Verifica status do PIX: estado local primeiro, depois API se ainda pending.
 * @param {string} pixId
 * @returns {{ status: 'pending'|'paid'|'expired', accessCode: string|null, plan: string|null }}
 */
async function checkPixStatus(pixId) {
  const state = load();
  const entry = state[pixId];

  // Se já está pago e temos código, retorna direto sem chamar API
  if (entry && entry.status === 'paid' && entry.accessCode) {
    return { status: 'paid', accessCode: entry.accessCode, plan: entry.plan };
  }

  // Consultar API AbacatePay
  let apiData = null;
  try {
    const res  = await fetch(`${API_BASE}/v1/pixQrCode/check?id=${encodeURIComponent(pixId)}`, {
      headers: { 'Authorization': `Bearer ${process.env.ABACATEPAY_API_KEY}` },
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && !json.error && json.data) apiData = json.data;
  } catch { /* ignora erros de rede — polling continua */ }

  if (!apiData) return { status: 'pending', accessCode: null, plan: entry ? entry.plan : null };

  const apiStatus = (apiData.status || '').toUpperCase();

  if (apiStatus === 'PAID') {
    const plan       = (entry && entry.plan) || 'starter';
    const accessCode = await activatePayment(pixId, plan);
    return { status: 'paid', accessCode, plan };
  }

  if (apiStatus === 'EXPIRED') {
    if (entry && entry.status !== 'expired') {
      const state2 = load();
      if (state2[pixId]) { state2[pixId].status = 'expired'; save(state2); }
    }
    return { status: 'expired', accessCode: null, plan: entry ? entry.plan : null };
  }

  return { status: 'pending', accessCode: null, plan: entry ? entry.plan : null };
}

// ── Ativar pagamento (idempotente) ────────────────────────────────────────────

/**
 * Gera código de acesso se ainda não foi gerado. Idempotente.
 * @param {string} pixId
 * @param {string} plan
 * @returns {string} código SNAP-XXXX-XXXX-XXXX
 */
async function activatePayment(pixId, plan) {
  const state = load();
  const entry = state[pixId];

  // Idempotência: se já gerou código, retorna
  if (entry && entry.accessCode) return entry.accessCode;

  const accessCode = generateSubscriptionCode(plan, pixId, null);

  state[pixId] = {
    ...(entry || { pixId, plan, createdAt: Date.now(), expiresAt: null }),
    plan,
    status:    'paid',
    accessCode,
    paidAt:    Date.now(),
  };
  save(state);

  return accessCode;
}

// ── Simular pagamento (apenas dev) ───────────────────────────────────────────

/**
 * Chama endpoint de simulação do AbacatePay (dev only).
 * @param {string} pixId
 * @returns {{ success: boolean, status: string, accessCode: string|null }}
 */
async function simulatePayment(pixId) {
  if (process.env.NODE_ENV === 'production') throw new Error('Simulação indisponível em produção.');

  const res  = await fetch(`${API_BASE}/v1/pixQrCode/simulate-payment?id=${encodeURIComponent(pixId)}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.ABACATEPAY_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({}),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.data) {
    // AbacatePay dev mode pode retornar erro mas ainda processar
    console.warn('[simulate-pix] resposta:', json);
  }

  // Confirmar via checkPixStatus (ativa o código independente da resposta da simulação)
  const statusResult = await checkPixStatus(pixId);
  return { success: statusResult.status === 'paid', ...statusResult };
}

// ── Verificar assinatura do webhook (camada secundária) ───────────────────────

/**
 * @param {Buffer|string} rawBody
 * @param {string} signatureFromHeader
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signatureFromHeader) {
  try {
    const secret = process.env.ABACATEPAY_WEBHOOK_SECRET;
    if (!secret || !signatureFromHeader) return false;
    const buf      = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const computed = crypto.createHmac('sha256', secret).update(buf).digest('base64');
    const a        = Buffer.from(computed, 'utf8');
    const b        = Buffer.from(signatureFromHeader, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// ── Limpeza automática de entradas expiradas ──────────────────────────────────

function cleanupOldBillings() {
  const state   = load();
  const cutoff  = Date.now() - 48 * 60 * 60 * 1000;
  let   changed = false;
  for (const [id, entry] of Object.entries(state)) {
    if (entry.status === 'pending' && entry.createdAt < cutoff) {
      delete state[id];
      changed = true;
    }
  }
  if (changed) save(state);
}

setInterval(cleanupOldBillings, 6 * 60 * 60 * 1000);

module.exports = {
  createPixPayment,
  checkPixStatus,
  activatePayment,
  simulatePayment,
  verifyWebhookSignature,
  cleanupOldBillings,
};
