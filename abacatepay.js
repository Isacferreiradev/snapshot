'use strict';

const crypto = require('crypto');

const API_BASE = 'https://api.abacatepay.com';

const PLAN_PRICES = {
  starter: parseInt(process.env.PRICE_STARTER_CENTS || '1990', 10),
  pro:     parseInt(process.env.PRICE_PRO_CENTS     || '4990', 10),
  agency:  parseInt(process.env.PRICE_AGENCY_CENTS  || '12990', 10),
};

const PLAN_NAMES = {
  starter: 'Plano Starter SnapShot.pro',
  pro:     'Plano Pro SnapShot.pro',
  agency:  'Plano Agency SnapShot.pro',
};

const PLAN_DESCS = {
  starter: 'Screenshots profissionais sem marca d\'água — R$ 19,90/mês',
  pro:     'Capturas ilimitadas com todos os templates — R$ 49,90/mês',
  agency:  'Para agências com volume alto — R$ 129,90/mês',
};

/**
 * Cria uma cobrança recorrente mensal no AbacatePay.
 * @param {string} plan — 'starter' | 'pro' | 'agency'
 * @param {object|null} customerData — { name, email, cellphone, taxId } (todos opcionais)
 * @returns {{ id: string, url: string }}
 */
async function createBilling(plan, customerData) {
  const price = PLAN_PRICES[plan];
  if (!price) throw new Error(`Plano inválido: ${plan}`);

  const base = process.env.BASE_URL || 'https://snapdeck.pro';

  const body = {
    frequency:     'MULTIPLE_PAYMENTS',
    methods:       ['PIX', 'CARD'],
    products:      [{
      externalId:  `snapshot-${plan}`,
      name:        PLAN_NAMES[plan],
      description: PLAN_DESCS[plan],
      quantity:    1,
      price,
    }],
    returnUrl:     `${base}/planos`,
    completionUrl: `${base}/pagamento-confirmado?plan=${plan}`,
  };

  // AbacatePay sempre exige customer com name, email, cellphone e taxId.
  // Se o usuário não preencheu, usa placeholder — o billing é criado mesmo assim.
  body.customer = {
    name:      (customerData && customerData.name)      || 'Assinante',
    email:     (customerData && customerData.email)     || 'pagamento@snapshot.pro',
    cellphone: (customerData && customerData.cellphone) || '00000000000',
    taxId:     (customerData && customerData.taxId)     || '94378754568',
  };

  const res  = await fetch(`${API_BASE}/v1/billing/create`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.ABACATEPAY_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `AbacatePay HTTP ${res.status}`);

  // Reavaliar preços em runtime (dotenv carrega antes do main process)
  PLAN_PRICES.starter = parseInt(process.env.PRICE_STARTER_CENTS || '1990', 10);
  PLAN_PRICES.pro     = parseInt(process.env.PRICE_PRO_CENTS     || '4990', 10);
  PLAN_PRICES.agency  = parseInt(process.env.PRICE_AGENCY_CENTS  || '12990', 10);

  return { id: json.data.id, url: json.data.url };
}

/**
 * Consulta o status de uma cobrança pelo ID.
 * @param {string} billingId
 * @returns {{ id, status, amount, customer }}
 */
async function getBillingStatus(billingId) {
  const res  = await fetch(`${API_BASE}/v1/billing/get?id=${encodeURIComponent(billingId)}`, {
    headers: { 'Authorization': `Bearer ${process.env.ABACATEPAY_API_KEY}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `AbacatePay HTTP ${res.status}`);
  return json.data;
}

/**
 * Verifica assinatura HMAC SHA256 do webhook AbacatePay.
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

/**
 * Processa evento de webhook já parseado.
 * @param {object} event
 * @returns {{ plan: string, billingId: string }|null}
 */
function processWebhookEvent(event) {
  if (!event || event.event !== 'billing.paid') return null;

  const billingId = event.data && event.data.id;
  let   plan      = null;

  // Tentar extrair plano do externalId do produto
  try {
    const products = event.data.products || event.data.billing?.products || [];
    for (const p of products) {
      const ext = (p.externalId || p.external_id || '').toLowerCase();
      if (ext.includes('starter')) { plan = 'starter'; break; }
      if (ext.includes('agency'))  { plan = 'agency';  break; }
      if (ext.includes('pro'))     { plan = 'pro';     break; }
    }
  } catch {}

  // Fallback: extrair do completionUrl
  if (!plan) {
    try {
      const url = event.data.completionUrl || event.data.completion_url || '';
      const m   = url.match(/[?&]plan=([^&]+)/);
      if (m) plan = m[1].toLowerCase();
    } catch {}
  }

  if (!plan || !billingId) return null;
  return { plan, billingId };
}

module.exports = { createBilling, getBillingStatus, verifyWebhookSignature, processWebhookEvent };
