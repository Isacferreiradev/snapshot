'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data', 'subscriptions.json');

// ── Limites por plano ─────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  starter: 100,
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
  const used  = sub.capturesThisMonth || 0;
  if (limit !== null) {
    const remaining = Math.max(0, limit - used);
    if (remaining === 0) {
      return { valid: false, isWatermarked: true, reason: `Limite mensal de ${limit} capturas atingido. Renova em ${new Date(sub.monthResetAt).toLocaleDateString('pt-BR')}.`, capturesThisMonth: used };
    }
    return { valid: true, plan: sub.plan, capturesRemaining: remaining, capturesThisMonth: used, isWatermarked: false };
  }

  return { valid: true, plan: sub.plan, capturesRemaining: null, capturesThisMonth: used, isWatermarked: false };
}

// ── Verificar se pode capturar ────────────────────────────────────────────────
/**
 * @param {string|null} code — código SNAP- (ou null para free)
 * @param {{ monthlyCaptures: number }} planObj — objeto do plano do config.json
 * @returns {{ allowed: boolean, used?: number, limit?: number }}
 */
function canCapture(code, planObj) {
  const limit = planObj && (planObj.capturesPerMonth !== undefined ? planObj.capturesPerMonth : planObj.monthlyCaptures);
  // Ilimitado (pro/agency/free) ou sem código
  if (!code || limit === undefined || limit === null || limit === -1) return { allowed: true };
  const norm = code.trim().toUpperCase();
  const data = load();
  const sub  = data[norm];
  if (!sub) return { allowed: true };
  const used = sub.capturesThisMonth || 0;
  if (used >= limit) return { allowed: false, used, limit };
  return { allowed: true, used, limit };
}

// ── Incrementar uso ───────────────────────────────────────────────────────────
function incrementCaptures(code, count = 1) {
  if (!code) return;
  const norm = code.trim().toUpperCase();
  const data = load();
  if (!data[norm]) return;
  data[norm].capturesThisMonth = (data[norm].capturesThisMonth || 0) + count;
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

// ── Limite diário free (por IP, persistido em disco) ─────────────────────────
const DAILY_FILE = path.join(__dirname, 'data', 'daily-usage.json');

function _midnightUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).getTime();
}

function _loadDaily() {
  try { return JSON.parse(fs.readFileSync(DAILY_FILE, 'utf8')); } catch { return {}; }
}
function _saveDaily(data) {
  fs.mkdirSync(path.dirname(DAILY_FILE), { recursive: true });
  fs.writeFileSync(DAILY_FILE, JSON.stringify(data));
}

/**
 * Verifica se o IP pode fazer mais capturas free hoje.
 * @param {string} ip
 * @param {number} limit — capturesPerDay do plano free (ex: 3)
 * @returns {{ allowed: boolean, used: number, limit: number }}
 */
function checkDailyFreeLimit(ip, limit) {
  const now   = Date.now();
  const data  = _loadDaily();
  const entry = data[ip];
  if (!entry || now >= entry.resetAt) return { allowed: true, used: 0, limit };
  const allowed = entry.count < limit;
  return { allowed, used: entry.count, limit };
}

/**
 * Incrementa o contador diário free para o IP.
 * @param {string} ip
 * @param {number} count — número de páginas capturadas
 */
function incrementDailyFreeUsage(ip, count = 1) {
  const now  = Date.now();
  const data = _loadDaily();
  const entry = data[ip];
  if (!entry || now >= entry.resetAt) {
    data[ip] = { count, resetAt: _midnightUTC() };
  } else {
    data[ip].count += count;
  }
  _saveDaily(data);
}

// Prune expired entries once an hour to keep the file small
setInterval(() => {
  const now  = Date.now();
  const data = _loadDaily();
  let changed = false;
  for (const ip of Object.keys(data)) {
    if (now >= data[ip].resetAt) { delete data[ip]; changed = true; }
  }
  if (changed) _saveDaily(data);
}, 60 * 60 * 1000);

module.exports = {
  generateSubscriptionCode,
  linkSessionToCode,
  getCodeBySession,
  validateSubscription,
  canCapture,
  incrementCaptures,
  isSubscriptionActive,
  cancelSubscription,
  renewSubscription,
  resetMonthlyCounters,
  checkDailyFreeLimit,
  incrementDailyFreeUsage,
};
