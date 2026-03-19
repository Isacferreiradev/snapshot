'use strict';

require('dotenv').config();

const ABACATEPAY_API  = 'https://api.abacatepay.com/v1';
const API_KEY         = process.env.ABACATEPAY_API_KEY || '';

// ── Packages ──────────────────────────────────────────────────────────────────
const PACKAGES = {
  starter: { captures: 5,  priceCents: 990,  name: 'Starter — 5 capturas',  description: 'Pacote inicial: 5 capturas profissionais desktop + mobile.' },
  pro:     { captures: 15, priceCents: 2490, name: 'Pro — 15 capturas',      description: '15 capturas com todas as opções de template e exportação social.' },
  agency:  { captures: 50, priceCents: 5990, name: 'Agência — 50 capturas',  description: '50 capturas em alta resolução, ideal para agências e freelas.' },
};

const DEFAULT_PKG = 'starter';

// Track billingId → { jobId, pkg, ip } so we can resolve webhooks
const billingIndex = new Map();

// ── Helper: call AbacatePay API ──────────────────────────────────────────────
async function abacatePost(endpoint, body) {
  const res = await fetch(`${ABACATEPAY_API}${endpoint}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    const msg = json.error || `AbacatePay ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return json.data;
}

// ── Create Billing (checkout) ────────────────────────────────────────────────
async function createBilling(jobId, pkg, ip) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const pkgKey  = (pkg && PACKAGES[pkg]) ? pkg : DEFAULT_PKG;
  const pkgData = PACKAGES[pkgKey];

  // For credit purchases, completionUrl goes to homepage with credits flag
  const completionUrl = jobId
    ? `${baseUrl}/?success=true&jobId=${jobId}`
    : `${baseUrl}/?credits=purchased`;

  const data = await abacatePost('/billing/create', {
    frequency:     'ONE_TIME',
    methods:       ['PIX'],
    products:      [{
      externalId:  `snapshot-${pkgKey}`,
      name:        pkgData.name,
      description: pkgData.description,
      quantity:    1,
      price:       pkgData.priceCents,
    }],
    returnUrl:     `${baseUrl}/`,
    completionUrl,
    metadata:      { pkg: pkgKey },
  });

  const billingId   = data.id;
  const checkoutUrl = data.url;

  billingIndex.set(billingId, { jobId: jobId || null, pkg: pkgKey, ip: ip || null });
  console.log(`[abacatepay] billing created: ${billingId} (${pkgKey}) for IP ${ip}`);

  return { billingId, checkoutUrl };
}

// ── Handle Webhook ───────────────────────────────────────────────────────────
function handleWebhook(body) {
  if (!body || !body.event) return null;

  console.log(`[abacatepay] webhook event: ${body.event}`);

  if (body.event !== 'billing.paid') return null;

  const billingId = body.data && body.data.id;
  if (!billingId) {
    console.log('[abacatepay] webhook billing.paid without data.id');
    return null;
  }

  const entry = billingIndex.get(billingId);
  if (!entry) {
    console.log(`[abacatepay] webhook billing.paid for unknown billingId: ${billingId}`);
    return null;
  }

  console.log(`[abacatepay] payment confirmed: billing ${billingId} → job ${entry.jobId}`);
  billingIndex.delete(billingId);

  return { jobId: entry.jobId, pkg: entry.pkg, ip: entry.ip };
}

// ── Lookup billing by jobId (for polling fallback) ───────────────────────────
function getBillingByJobId(jobId) {
  for (const [billingId, entry] of billingIndex) {
    if (entry.jobId === jobId) return { billingId, ...entry };
  }
  return null;
}

// ── Package info (for frontend) ──────────────────────────────────────────────
function getPackages() {
  return Object.entries(PACKAGES).map(([key, p]) => ({
    key,
    name:        p.name,
    description: p.description,
    captures:    p.captures,
    priceCents:  p.priceCents,
    priceLabel:  `R$${(p.priceCents / 100).toFixed(2).replace('.', ',')}`,
  }));
}

module.exports = { createBilling, handleWebhook, getPackages, getBillingByJobId, PACKAGES };
