'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data', 'subscriptions.json');

// ── Limites por plano ─────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  starter: 50,
  pro:     null, // ilimitado
  agency:  null, // ilimitado
};

// ── Persistência ──────────────────────────────────────────────────────────────
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Helpers de data ───────────────────────────────────────────────────────────
function thirtyDaysFromNow() {
  return Date.now() + 30 * 24 * 60 * 60 * 1000;
}
function startOfNextMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

// ── Geração de código ─────────────────────────────────────────────────────────
/**
 * Gera código no formato SNAP-XXXX-XXXX-XXXX.
 * Salva em data/subscriptions.json.
 * @returns {string} código gerado
 */
function generateSubscriptionCode(plan, stripeSubscriptionId, stripeCustomerId) {
  const data  = load();
  const part  = () => crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  const code  = `SNAP-${part()}-${part()}-${part()}`;
  const limit = PLAN_LIMITS[plan] !== undefined ? PLAN_LIMITS[plan] : 50;

  data[code] = {
    plan:                 plan || 'starter',
    stripeSubscriptionId: stripeSubscriptionId || null,
    stripeCustomerId:     stripeCustomerId || null,
    validUntil:           thirtyDaysFromNow(),
    capturesThisMonth:    0,
    capturesLimit:        limit,         // null = ilimitado
    active:               true,
    createdAt:            Date.now(),
    monthResetAt:         startOfNextMonth(),
    checkoutSessionId:    null,          // preenchido depois se necessário
  };
  save(data);
  return code;
}

/**
 * Vincula um checkoutSessionId a um código (para lookup na página de sucesso).
 */
function linkSessionToCode(code, checkoutSessionId) {
  const data = load();
  if (data[code]) {
    data[code].checkoutSessionId = checkoutSessionId;
    save(data);
  }
}

/**
 * Busca código pelo checkoutSessionId.
 * @returns {string|null}
 */
function getCodeBySession(checkoutSessionId) {
  const data = load();
  for (const [code, sub] of Object.entries(data)) {
    if (sub.checkoutSessionId === checkoutSessionId) return code;
  }
  return null;
}

// ── Validação ─────────────────────────────────────────────────────────────────
/**
 * @returns {{ valid: boolean, plan?: string, capturesRemaining?: number|null, isWatermarked: boolean, reason?: string }}
 */
function validateSubscription(code) {
  if (!code || typeof code !== 'string') return { valid: false, isWatermarked: true, reason: 'Código obrigatório.' };
  const norm = code.trim().toUpperCase();
  const data = load();
  const sub  = data[norm];

  if (!sub)          return { valid: false, isWatermarked: true, reason: 'Código não encontrado.' };
  if (!sub.active)   return { valid: false, isWatermarked: true, reason: 'Assinatura cancelada.' };
  if (Date.now() > sub.validUntil) return { valid: false, isWatermarked: true, reason: 'Assinatura expirada. Renove em snapshot.pro.' };

  const limit = sub.capturesLimit; // null = unlimited
  if (limit !== null) {
    const used      = sub.capturesThisMonth || 0;
    const remaining = Math.max(0, limit - used);
    if (remaining === 0) {
      return { valid: false, isWatermarked: true, reason: `Limite mensal de ${limit} capturas atingido. Renova em ${new Date(sub.monthResetAt).toLocaleDateString('pt-BR')}.` };
    }
    return { valid: true, plan: sub.plan, capturesRemaining: remaining, isWatermarked: false };
  }

  return { valid: true, plan: sub.plan, capturesRemaining: null, isWatermarked: false };
}

// ── Incrementar uso ───────────────────────────────────────────────────────────
function incrementCaptures(code) {
  if (!code) return;
  const norm = code.trim().toUpperCase();
  const data = load();
  if (!data[norm]) return;
  data[norm].capturesThisMonth = (data[norm].capturesThisMonth || 0) + 1;
  save(data);
}

// ── Status da assinatura ──────────────────────────────────────────────────────
function isSubscriptionActive(code) {
  if (!code) return false;
  const norm = code.trim().toUpperCase();
  const data = load();
  const sub  = data[norm];
  return !!(sub && sub.active && Date.now() <= sub.validUntil);
}

// ── Cancelar (webhook subscription.deleted) ───────────────────────────────────
function cancelSubscription(stripeSubscriptionId) {
  const data = load();
  let changed = false;
  for (const code of Object.keys(data)) {
    if (data[code].stripeSubscriptionId === stripeSubscriptionId) {
      data[code].active = false;
      changed = true;
    }
  }
  if (changed) save(data);
}

// ── Renovar (webhook subscription.updated / renewed) ─────────────────────────
function renewSubscription(stripeSubscriptionId) {
  const data = load();
  let changed = false;
  for (const code of Object.keys(data)) {
    if (data[code].stripeSubscriptionId === stripeSubscriptionId) {
      data[code].validUntil          = thirtyDaysFromNow();
      data[code].active              = true;
      data[code].capturesThisMonth   = 0;
      data[code].monthResetAt        = startOfNextMonth();
      changed = true;
    }
  }
  if (changed) save(data);
}

// ── Reset mensal automático ───────────────────────────────────────────────────
function resetMonthlyCounters() {
  const data = load();
  const now  = Date.now();
  let changed = false;
  for (const code of Object.keys(data)) {
    if (data[code].monthResetAt && now >= data[code].monthResetAt) {
      data[code].capturesThisMonth = 0;
      data[code].monthResetAt      = startOfNextMonth();
      changed = true;
    }
  }
  if (changed) save(data);
}

// Verificar reset a cada hora
setInterval(resetMonthlyCounters, 60 * 60 * 1000);

module.exports = {
  generateSubscriptionCode,
  linkSessionToCode,
  getCodeBySession,
  validateSubscription,
  incrementCaptures,
  isSubscriptionActive,
  cancelSubscription,
  renewSubscription,
  resetMonthlyCounters,
};
