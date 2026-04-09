'use strict';

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────

function getBaseUrl() {
  return process.env.ASAAS_ENV === 'production'
    ? 'https://www.asaas.com'
    : 'https://sandbox.asaas.com';
}

function getApiKey() {
  const key = process.env.ASAAS_API_KEY;
  if (!key || key.trim() === '') throw new Error('[Asaas] ASAAS_API_KEY nao configurada');
  return key.trim();
}

// ── HTTP client ───────────────────────────────────────────────────────────

function asaasRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/v3${endpoint}`, getBaseUrl());
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        'access_token': getApiKey(),
        'Content-Type': 'application/json',
        'User-Agent':   'Snapdeck/1.0',
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { return reject(new Error(`[Asaas] Resposta invalida: ${data.slice(0,100)}`)); }
        if (res.statusCode >= 400) {
          const msg = (parsed?.errors?.[0]?.description) || parsed?.description || `HTTP ${res.statusCode}`;
          return reject(new Error(`[Asaas] ${msg}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('[Asaas] Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Persistência ──────────────────────────────────────────────────────────

const BILLING_FILE = path.join(__dirname, 'data', 'billing.json');

function loadBilling() {
  try { return JSON.parse(fs.readFileSync(BILLING_FILE, 'utf8')); } catch { return {}; }
}
function saveBilling(data) {
  fs.mkdirSync(path.dirname(BILLING_FILE), { recursive: true });
  fs.writeFileSync(BILLING_FILE, JSON.stringify(data, null, 2));
}
function getBillingEntry(paymentId) { return loadBilling()[paymentId] || null; }
function setBillingEntry(paymentId, entry) {
  const b = loadBilling();
  b[paymentId] = entry;
  saveBilling(b);
}

// claimConfirmationEmail and claimPixReminder (same interface as old billing.js)
function claimConfirmationEmail(paymentId) {
  const b = loadBilling();
  const e = b[paymentId];
  if (!e || e.confirmationEmailSent) return false;
  b[paymentId] = { ...e, confirmationEmailSent: true };
  saveBilling(b);
  return true;
}
function claimPixReminder(paymentId) {
  const b = loadBilling();
  const e = b[paymentId];
  if (!e || e.reminderSent) return false;
  b[paymentId] = { ...e, reminderSent: true };
  saveBilling(b);
  return true;
}

// ── Plan prices ───────────────────────────────────────────────────────────

const PLAN_PRICES = { starter: 19.90, pro: 49.90, agency: 129.90 };

function getPlanPrice(plan) {
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname,'data','config.json'),'utf8')); } catch { return {}; } })();
  if (cfg.plans && cfg.plans[plan] && cfg.plans[plan].price) return cfg.plans[plan].price / 100;
  return PLAN_PRICES[plan] || 19.90;
}

// ── Customer ──────────────────────────────────────────────────────────────

async function getOrCreateCustomer({ name, email, cpfCnpj, phone }) {
  const cpfClean = (cpfCnpj || '').replace(/\D/g, '');
  if (cpfClean) {
    try {
      const res = await asaasRequest('GET', `/customers?cpfCnpj=${cpfClean}`);
      if (res.data && res.data.length > 0) {
        console.log(`[Asaas] Customer existente: ${res.data[0].id}`);
        return res.data[0].id;
      }
    } catch (e) { console.warn('[Asaas] Busca customer falhou:', e.message); }
  }
  const payload = { name: name || email || 'Cliente Snapdeck' };
  if (email) payload.email = email;
  if (cpfClean) payload.cpfCnpj = cpfClean;
  if (phone) payload.mobilePhone = phone.replace(/\D/g, '');
  const created = await asaasRequest('POST', '/customers', payload);
  console.log(`[Asaas] Customer criado: ${created.id}`);
  return created.id;
}

// ── Criar cobrança PIX ────────────────────────────────────────────────────

async function createPixPayment(plan, customer = {}) {
  const amount = getPlanPrice(plan);

  const customerId = await getOrCreateCustomer(customer);

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 1);
  const dueDateStr = dueDate.toISOString().split('T')[0];

  const payment = await asaasRequest('POST', '/payments', {
    customer:          customerId,
    billingType:       'PIX',
    value:             amount,
    dueDate:           dueDateStr,
    description:       `Snapdeck — Plano ${plan.charAt(0).toUpperCase() + plan.slice(1)}`,
    externalReference: `snapdeck-${plan}-${Date.now()}`,
  });

  console.log(`[Asaas] Cobranca criada: ${payment.id} status:${payment.status}`);

  const qr = await asaasRequest('GET', `/payments/${payment.id}/pixQrCode`);

  setBillingEntry(payment.id, {
    paymentId:  payment.id,
    customerId,
    plan,
    amount,
    status:     'PENDING',
    accessCode: null,
    createdAt:  Date.now(),
    expiresAt:  qr.expirationDate ? new Date(qr.expirationDate).getTime() : (Date.now() + 3600000),
    customer: {
      name:    customer.name    || null,
      email:   customer.email   || null,
      cpfCnpj: customer.cpfCnpj || null,
    },
  });

  return {
    paymentId:     payment.id,
    qrCodeBase64:  qr.encodedImage,
    copyPasteCode: qr.payload,
    expiresAt:     qr.expirationDate,
    amount,
  };
}

// ── Verificar status (polling) ────────────────────────────────────────────

async function checkPixStatus(paymentId) {
  const local = getBillingEntry(paymentId);
  if (local && (local.status === 'RECEIVED' || local.status === 'CONFIRMED') && local.accessCode) {
    return { status: 'paid', accessCode: local.accessCode, plan: local.plan };
  }
  let payment;
  try { payment = await asaasRequest('GET', `/payments/${paymentId}`); }
  catch (e) {
    console.error('[Asaas] Erro ao consultar pagamento:', e.message);
    return { status: 'pending', accessCode: null, plan: local?.plan || null };
  }
  const s = payment.status;
  if ((s === 'RECEIVED' || s === 'CONFIRMED') && !(local?.accessCode)) {
    const result = await activatePayment(paymentId, local?.plan || 'starter');
    return { status: 'paid', accessCode: result.accessCode, plan: result.plan };
  }
  if (s === 'OVERDUE' || s === 'REFUNDED' || s === 'REFUND_REQUESTED') {
    return { status: 'expired', accessCode: null, plan: local?.plan || null };
  }
  return { status: 'pending', accessCode: null, plan: local?.plan || null };
}

// ── Ativar pagamento (idempotente) ────────────────────────────────────────

async function activatePayment(paymentId, plan) {
  const entry = getBillingEntry(paymentId);
  if (entry?.accessCode) {
    console.log(`[Asaas] Ja ativado: ${paymentId} -> ${entry.accessCode}`);
    return { accessCode: entry.accessCode, plan: entry.plan || plan };
  }
  const { generateSubscriptionCode } = require('./subscriptions');
  const accessCode = generateSubscriptionCode(plan, paymentId, null);
  setBillingEntry(paymentId, {
    ...(entry || {}),
    paymentId, plan,
    status:      'RECEIVED',
    accessCode,
    activatedAt: Date.now(),
  });
  console.log(`[Asaas] Plano ativado: ${plan} -> ${accessCode}`);
  return { accessCode, plan };
}

// ── Simular pagamento (sandbox only) ─────────────────────────────────────

async function simulatePayment(paymentId) {
  const plan = getBillingEntry(paymentId)?.plan || 'starter';
  if (process.env.ASAAS_ENV !== 'production') {
    // Sandbox: chamar API Asaas para marcar como pago
    try {
      await asaasRequest('POST', `/payments/${paymentId}/receiveInCash`, { value: null, notifyCustomer: false });
    } catch (_) { /* ignora — ativa localmente de qualquer forma */ }
  }
  // Produção ou sandbox: sempre ativa localmente (escrita no JSON local, sem chamada externa)
  const result = await activatePayment(paymentId, plan);
  return { success: true, status: 'RECEIVED', accessCode: result.accessCode, plan: result.plan };
}

// ── Verificar token do webhook ────────────────────────────────────────────

function verifyWebhookToken(req) {
  const token    = req.headers['asaas-access-token'];
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!expected || expected.trim() === '') {
    console.warn('[Asaas Webhook] ASAAS_WEBHOOK_TOKEN nao configurado — modo dev, aceitando');
    return process.env.NODE_ENV !== 'production';
  }
  if (!token) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token.trim()), Buffer.from(expected.trim()));
  } catch { return false; }
}

// ── Cleanup ───────────────────────────────────────────────────────────────

function cleanupOldBillings() {
  const b    = loadBilling();
  const now  = Date.now();
  const AGE  = 7 * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [id, e] of Object.entries(b)) {
    if ((now - (e.createdAt || 0)) > AGE && e.status !== 'RECEIVED' && e.status !== 'CONFIRMED') {
      delete b[id];
      removed++;
    }
  }
  if (removed > 0) { saveBilling(b); console.log(`[Asaas] Cleanup: ${removed} entradas removidas`); }
}
setInterval(cleanupOldBillings, 24 * 60 * 60 * 1000).unref();

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  createPixPayment,
  checkPixStatus,
  activatePayment,
  simulatePayment,
  verifyWebhookToken,
  getBillingEntry,
  claimConfirmationEmail,
  claimPixReminder,
  getOrCreateCustomer,
};
