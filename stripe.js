'use strict';

require('dotenv').config();
const Stripe = require('stripe');
const {
  generateSubscriptionCode,
  linkSessionToCode,
  cancelSubscription,
  renewSubscription,
} = require('./subscriptions');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// ── Planos ────────────────────────────────────────────────────────────────────
const PLANS = {
  starter: {
    priceId:    () => process.env.STRIPE_PRICE_STARTER,
    name:       'Starter',
    priceLabel: 'R$ 19,90/mês',
    priceCents: 1990,
    captures:   50,
    popular:    false,
    benefits:   ['Sem marca d\'água', 'Todos os 12 templates', 'Até 50 capturas/mês'],
  },
  pro: {
    priceId:    () => process.env.STRIPE_PRICE_PRO,
    name:       'Pro',
    priceLabel: 'R$ 49,90/mês',
    priceCents: 4990,
    captures:   null,
    popular:    true,
    benefits:   ['Capturas ilimitadas', 'Modo comparação A/B', 'Todos os templates', 'Sem marca d\'água'],
  },
  agency: {
    priceId:    () => process.env.STRIPE_PRICE_AGENCY,
    name:       'Agency',
    priceLabel: 'R$ 129,90/mês',
    priceCents: 12990,
    captures:   null,
    popular:    false,
    benefits:   ['Tudo do Pro', 'API REST direta', 'Múltiplos códigos de acesso', 'Sem marca d\'água'],
  },
};

// ── Create Subscription Checkout ──────────────────────────────────────────────
async function createCheckoutSession(plan) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const planKey = PLANS[plan] ? plan : 'starter';
  const planData = PLANS[planKey];
  const priceId  = planData.priceId();

  if (!priceId || priceId === 'price_placeholder') {
    throw new Error(`Price ID não configurado para plano "${planKey}". Adicione STRIPE_PRICE_${planKey.toUpperCase()} ao .env`);
  }

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode:                 'subscription',
    line_items:           [{ price: priceId, quantity: 1 }],
    success_url:          `${baseUrl}/plano-ativo?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:           `${baseUrl}/`,
    metadata:             { plan: planKey },
  });

  return session.url;
}

// ── Webhook ───────────────────────────────────────────────────────────────────
/**
 * Trata eventos Stripe de assinatura.
 * Retorna objeto com resultado ou null para eventos ignorados.
 */
function handleWebhook(rawBody, signature) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET não configurado.');

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    throw new Error(`Falha na verificação do webhook: ${err.message}`);
  }

  const obj = event.data.object;

  // Checkout concluído — gera código de acesso
  if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
    const plan           = (obj.metadata && obj.metadata.plan) ? obj.metadata.plan : 'starter';
    const subscriptionId = obj.subscription;
    const customerId     = obj.customer;
    const sessionId      = obj.id;

    const code = generateSubscriptionCode(plan, subscriptionId, customerId);
    linkSessionToCode(code, sessionId);
    console.log(`[stripe] Assinatura criada — plano: ${plan}, código: ${code}`);
    return { event: 'checkout_completed', code, plan, stripeSubscriptionId: subscriptionId, sessionId };
  }

  // Assinatura renovada
  if (event.type === 'customer.subscription.updated') {
    renewSubscription(obj.id);
    console.log(`[stripe] Assinatura renovada: ${obj.id}`);
    return { event: 'renewed', stripeSubscriptionId: obj.id };
  }

  // Assinatura cancelada
  if (event.type === 'customer.subscription.deleted') {
    cancelSubscription(obj.id);
    console.log(`[stripe] Assinatura cancelada: ${obj.id}`);
    return { event: 'cancelled', stripeSubscriptionId: obj.id };
  }

  return null;
}

// ── Dados dos planos para o frontend ─────────────────────────────────────────
function getPlans() {
  return Object.entries(PLANS).map(([key, p]) => ({
    key,
    name:       p.name,
    priceLabel: p.priceLabel,
    priceCents: p.priceCents,
    captures:   p.captures,
    popular:    p.popular,
    benefits:   p.benefits,
  }));
}

module.exports = { createCheckoutSession, handleWebhook, getPlans, PLANS };
