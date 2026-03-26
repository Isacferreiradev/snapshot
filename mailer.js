'use strict';

/**
 * mailer.js — Emails transacionais via Resend SDK
 */

const { Resend } = require('resend');

let _resend = null;
function getResend() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      console.warn('[mailer] RESEND_API_KEY não configurada — emails desativados.');
      return null;
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

const FROM_MAIN    = () => `SnapDeck <${process.env.EMAIL_FROM_MAIN || 'contato@snapdeck.pro'}>`;
const FROM_NOREPLY = () => FROM_MAIN(); // usando o mesmo remetente verificado para todos os envios
const REPLY_TO     = () =>  process.env.EMAIL_FROM_MAIN || 'contato@snapdeck.pro';
const ADMIN_EMAIL  = () =>  process.env.ADMIN_ALERT_EMAIL;
const SITE_URL     = 'https://snapdeck.pro';

// ─── Send helper ──────────────────────────────────────────────────────────

async function _send(payload) {
  const resend = getResend();
  if (!resend) return { sent: false, reason: 'no_api_key' };

  const enriched = {
    reply_to: REPLY_TO(),
    headers: {
      'List-Unsubscribe':      `<mailto:${REPLY_TO()}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Entity-Ref-ID':       `sd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    },
    ...payload,
  };

  try {
    const { data, error } = await resend.emails.send(enriched);
    if (error) {
      console.error('[mailer] erro:', error);
      return { sent: false, reason: error.message || 'resend_error' };
    }
    console.log(`[mailer] sent id:${data?.id} to:${enriched.to}`);
    return { sent: true, id: data?.id };
  } catch (err) {
    console.error('[mailer] excecao:', err.message);
    return { sent: false, reason: err.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '–';
  try { return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }); }
  catch { return iso; }
}

function fn(name) { return name ? name.split(' ')[0] : null; }

function plain(lines) {
  return ['SnapDeck — snapdeck.pro', '─'.repeat(32), ...lines, '', '─'.repeat(32),
    `Acesse: ${SITE_URL}`, 'Suporte: suporte@snapdeck.pro'].join('\n');
}

// ─── Template ─────────────────────────────────────────────────────────────
// Design inspiration: Vercel / Linear / Stripe transactional emails
// Rules: no @import, no CSS vars, table-based, Outlook VML button, plain text version

const F = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;

// Shared inline styles (strings, not objects — safer across email clients)
const S = {
  outer:     `margin:0;padding:48px 16px 64px;background-color:#080808;`,
  card:      `max-width:520px;margin:0 auto;border-radius:20px;border:1px solid #1c1c1c;overflow:hidden;background-color:#0f0f0f;`,
  logoBar:   `padding:24px 36px;background-color:#0f0f0f;border-bottom:1px solid #1c1c1c;`,
  logoText:  `font-size:15px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;font-family:${F};`,
  logoDot:   `display:inline-block;width:8px;height:8px;border-radius:50%;background-color:#7c3aed;margin-right:8px;vertical-align:middle;`,
  body:      `padding:40px 36px 32px;background-color:#0f0f0f;`,
  h1:        `font-size:26px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;margin:0 0 6px;line-height:1.25;font-family:${F};`,
  sub:       `font-size:14px;color:#6b7280;margin:0 0 28px;line-height:1.5;font-family:${F};`,
  hr:        `height:1px;background-color:#1c1c1c;border:none;margin:0 0 28px;font-size:0;line-height:0;`,
  p:         `font-size:15px;line-height:1.7;color:#9ca3af;margin:0 0 16px;font-family:${F};`,
  pStrong:   `color:#e5e7eb;font-weight:600;`,
  codeWrap:  `background-color:#070707;border:1px dashed #2a2a2a;border-radius:14px;padding:24px 28px;margin:24px 0;text-align:center;`,
  codeLabel: `font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:#4b5563;margin:0 0 10px;font-family:${F};`,
  codeVal:   `font-size:20px;font-weight:700;letter-spacing:5px;color:#ffffff;font-family:'Courier New',Courier,monospace;margin:0 0 8px;`,
  codeHint:  `font-size:12px;color:#374151;margin:0;font-family:${F};`,
  chip:      `background-color:#0a0a0a;border:1px solid #1c1c1c;border-radius:12px;padding:18px 22px;margin:20px 0 24px;`,
  chipLbl:   `font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#5b21b6;margin:0 0 10px;font-family:${F};`,
  chipVal:   `font-size:14px;color:#9ca3af;line-height:1.8;margin:0;font-family:${F};`,
  amount:    `font-size:32px;font-weight:700;color:#ffffff;letter-spacing:-1px;margin:0 0 20px;text-align:center;font-family:${F};`,
  btnWrap:   `margin:28px 0 8px;text-align:center;`,
  btn:       `display:inline-block;padding:14px 32px;background-color:#7c3aed;color:#ffffff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:600;letter-spacing:0.2px;font-family:${F};`,
  muted:     `font-size:12px;color:#374151;text-align:center;margin:14px 0 0;font-family:${F};`,
  footer:    `padding:18px 36px 20px;background-color:#080808;border-top:1px solid #1c1c1c;text-align:center;`,
  fLink:     `font-size:12px;color:#5b21b6;text-decoration:none;margin:0 10px;font-family:${F};`,
  fTag:      `font-size:11px;color:#1f2937;margin:8px 0 0;font-family:${F};`,
};

function buildHtml({ h1, sub, body, ctaText, ctaUrl, muted = '' }) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="dark"/>
<meta name="supported-color-schemes" content="dark"/>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style type="text/css">
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
body{margin:0;padding:0;background-color:#080808;}
table{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;}
@media only screen and (max-width:600px){
  .card{border-radius:0!important;border-left:none!important;border-right:none!important;}
  .body-td{padding:32px 24px 24px!important;}
  .logo-td{padding:20px 24px!important;}
  .foot-td{padding:16px 24px 18px!important;}
}
</style>
</head>
<body style="${S.outer}">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation">
<tr><td align="center">
<!--[if mso]><table width="520" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table class="card" width="100%" cellpadding="0" cellspacing="0" role="presentation" style="${S.card}">

  <!-- LOGO -->
  <tr><td class="logo-td" style="${S.logoBar}">
    <span style="${S.logoDot}"></span><span style="${S.logoText}">SnapDeck</span>
  </td></tr>

  <!-- BODY -->
  <tr><td class="body-td" style="${S.body}">
    <p style="${S.h1}">${h1}</p>
    <p style="${S.sub}">${sub}</p>
    <div style="${S.hr}"></div>
    ${body}
    <!-- CTA -->
    <div style="${S.btnWrap}">
      <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${ctaUrl}" style="height:44px;v-text-anchor:middle;width:210px;" arcsize="22%" stroke="f" fillcolor="#7c3aed"><w:anchorlock/><center style="color:#ffffff;font-family:${F};font-size:14px;font-weight:600;">${ctaText}</center></v:roundrect><![endif]-->
      <!--[if !mso]><!--><a href="${ctaUrl}" target="_blank" style="${S.btn}">${ctaText}</a><!--<![endif]-->
    </div>
    ${muted ? `<p style="${S.muted}">${muted}</p>` : ''}
  </td></tr>

  <!-- FOOTER -->
  <tr><td class="foot-td" style="${S.footer}">
    <a href="mailto:suporte@snapdeck.pro" style="${S.fLink}">Suporte</a><!--
    --><span style="color:#1c1c1c;">|</span><!--
    --><a href="mailto:contato@snapdeck.pro" style="${S.fLink}">Contato</a><!--
    --><span style="color:#1c1c1c;">|</span><!--
    --><a href="${SITE_URL}" target="_blank" style="${S.fLink}">snapdeck.pro</a>
    <p style="${S.fTag}">Transforme qualquer site em capturas profissionais</p>
  </td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
}

// ─── Componentes reutilizáveis de body ────────────────────────────────────

function pHtml(text) {
  return `<p style="${S.p}">${text}</p>`;
}

function strongHtml(text) {
  return `<strong style="${S.pStrong}">${text}</strong>`;
}

function chipHtml(label, valueHtml) {
  return `<div style="${S.chip}">
    <p style="${S.chipLbl}">${label}</p>
    <p style="${S.chipVal}">${valueHtml}</p>
  </div>`;
}

function codeBoxHtml(code) {
  return `<div style="${S.codeWrap}">
    <p style="${S.codeLabel}">Seu código de acesso</p>
    <p style="${S.codeVal}">${code}</p>
    <p style="${S.codeHint}">Cole este código no SnapDeck para ativar seu plano</p>
  </div>`;
}

// ─── Email 1 — Pagamento confirmado ───────────────────────────────────────

async function sendPaymentConfirmed({ to, name, plan, amount } = {}) {
  if (!to) return { sent: false, reason: 'missing_to' };

  const first    = fn(name);
  const greeting = first ? `Obrigado, ${first}.` : 'Obrigado.';
  const amtBlock = amount ? `<p style="${S.amount}">${amount}</p>` : '';

  // Recibo minimalista — sem linguagem de marketing para não acionar filtros
  const body = [
    amtBlock,
    pHtml(`Plano ${strongHtml(plan)} registrado em ${new Date().toLocaleDateString('pt-BR')}.`),
    pHtml(`O código de uso chegará no próximo email, em instantes.`),
  ].join('');

  return _send({
    from: FROM_MAIN(), to,
    subject: `Recibo SnapDeck — ${plan}`,
    html: buildHtml({ h1: greeting, sub: `Plano ${plan} registrado.`, body, ctaText: 'Abrir o SnapDeck', ctaUrl: SITE_URL }),
    text: plain([greeting, `Plano: ${plan}`, amount ? `Valor: ${amount}` : '', `Data: ${new Date().toLocaleDateString('pt-BR')}`, '', `Abrir: ${SITE_URL}`].filter(Boolean)),
  });
}

// ─── Email 2 — Código SNAP ────────────────────────────────────────────────

async function sendSnapCode({ to, name, code, plan } = {}) {
  if (!to || !code) return { sent: false, reason: 'missing_to_or_code' };

  const greeting = fn(name) ? `${fn(name)}, aqui está seu código.` : 'Aqui está seu código de acesso.';

  const body = [
    codeBoxHtml(code),
    pHtml(`Este código ativa o plano ${strongHtml(plan || 'Pro')} no SnapDeck. Guarde-o — você precisará dele sempre que quiser usar o acesso premium.`),
    pHtml(`Para usar: abra o SnapDeck, clique em ${strongHtml('"Inserir código"')} e cole o código acima.`),
  ].join('');

  return _send({
    from: FROM_NOREPLY(), to,
    subject: `Seu acesso ao SnapDeck — ${code}`,
    html: buildHtml({ h1: greeting, sub: `Código de acesso ao plano ${plan || 'Pro'}.`, body, ctaText: 'Acessar o SnapDeck', ctaUrl: SITE_URL }),
    text: plain([
      `${greeting}`, '',
      `Código: ${code}`, '',
      `Plano: ${plan || 'Pro'}`,
      `Cole o código no SnapDeck para ativar seu acesso.`,
      `Acesse: ${SITE_URL}`,
    ]),
  });
}

// ─── Email 3 — Primeira captura ───────────────────────────────────────────

async function sendFirstCapture({ to, name } = {}) {
  if (!to) return { sent: false, reason: 'missing_to' };

  const greeting = fn(name) ? `Parabéns, ${fn(name)}.` : 'Parabéns.';

  const body = [
    pHtml(`Você acabou de transformar um site inteiro em visual profissional. Essa é sua primeira captura — e provavelmente não será a última.`),
    pHtml(`Explore o resultado, faça o download e veja o que mais o SnapDeck consegue fazer para o seu trabalho.`),
  ].join('');

  return _send({
    from: FROM_NOREPLY(), to,
    subject: `Sua primeira captura está pronta — SnapDeck`,
    html: buildHtml({
      h1: greeting,
      sub: 'Sua primeira captura está pronta.',
      body, ctaText: 'Ver resultado', ctaUrl: SITE_URL,
    }),
    text: plain([greeting, '', 'Sua primeira captura esta pronta.', 'Voce acabou de transformar um site em visual profissional.', `Ver resultado: ${SITE_URL}`]),
  });
}

// ─── Email 4 — Lembrete PIX pendente ─────────────────────────────────────

async function sendPixReminder({ to, name, plan, amount } = {}) {
  if (!to) return { sent: false, reason: 'missing_to' };

  const greeting = fn(name) ? `${fn(name)}, seu pagamento ainda está aberto.` : 'Seu pagamento ainda está aberto.';

  const detailLines = [
    plan   ? `${strongHtml('Plano:')} ${plan}` : null,
    amount ? `${strongHtml('Valor:')} ${amount}` : null,
  ].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  const body = [
    detailLines ? `<p style="${S.p}">${detailLines}</p>` : '',
    pHtml(`Assim que o PIX for confirmado, o acesso premium é ativado ${strongHtml('imediatamente')} — sem marca d'água, sem limite de capturas.`),
    pHtml(`O código QR expira em 1 hora. Se expirou, gere um novo acesso pelo site.`),
  ].join('');

  return _send({
    from: FROM_NOREPLY(), to,
    subject: `SnapDeck — você deixou algo em aberto`,
    html: buildHtml({
      h1: greeting, sub: 'Você iniciou um pagamento PIX que ainda não foi concluído.',
      body, ctaText: 'Concluir pagamento', ctaUrl: SITE_URL,
      muted: 'Este lembrete é enviado apenas uma vez.',
    }),
    text: plain([greeting, '', plan ? `Plano: ${plan}` : '', amount ? `Valor: ${amount}` : '', '', 'Conclua o pagamento para ativar seu acesso.', `${SITE_URL}`, '', 'Este lembrete e enviado apenas uma vez.']),
  });
}

// ─── Email 5 — Limite gratuito ────────────────────────────────────────────

async function sendFreeLimitReached({ to, name, limit } = {}) {
  if (!to) return { sent: false, reason: 'missing_to' };

  const limitStr = limit ? `${limit} capturas` : 'o limite diário';

  const body = [
    pHtml(`Você atingiu ${strongHtml(limitStr + ' gratuitas')} disponíveis hoje. O limite renova automaticamente à meia-noite.`),
    chipHtml('SnapDeck Pro inclui', [
      `${strongHtml('Capturas ilimitadas')}`,
      `Alta resolução · Templates premium`,
      `Sem marca d'água · Suporte prioritário`,
    ].join('<br/>')),
  ].join('');

  return _send({
    from: FROM_NOREPLY(), to,
    subject: `Limite diário atingido — SnapDeck`,
    html: buildHtml({ h1: 'Você usou todas as capturas de hoje.', sub: `Limite de ${limitStr} gratuitas atingido.`, body, ctaText: 'Ver planos Pro', ctaUrl: SITE_URL, muted: 'Limite gratuito renova todo dia à meia-noite (UTC).' }),
    text: plain([`Voce atingiu o limite de ${limitStr} gratuitas.`, '', 'Considere o SnapDeck Pro para capturas ilimitadas.', `${SITE_URL}`]),
  });
}

// ─── Email 6 — Plano expirando ────────────────────────────────────────────

async function sendPlanExpiringSoon({ to, name, expiresAt, plan } = {}) {
  if (!to) return { sent: false, reason: 'missing_to' };

  const planName = plan || 'Pro';
  const greeting = fn(name) ? `${fn(name)}, seu plano expira em breve.` : 'Seu plano expira em breve.';

  const body = [
    pHtml(`O plano ${strongHtml(planName)} vence em ${strongHtml(fmtDate(expiresAt))}.`),
    pHtml(`Renove via PIX — a ativação é imediata assim que o pagamento for confirmado.`),
    pHtml(`Após o vencimento, sua conta volta ao plano gratuito automaticamente.`),
  ].join('');

  return _send({
    from: FROM_MAIN(), to,
    subject: `Seu plano ${planName} expira em breve — SnapDeck`,
    html: buildHtml({ h1: greeting, sub: `${planName} — vence em ${fmtDate(expiresAt)}.`, body, ctaText: 'Renovar agora', ctaUrl: SITE_URL }),
    text: plain([greeting, '', `Plano ${planName} vence em ${fmtDate(expiresAt)}.`, `Renovar: ${SITE_URL}`]),
  });
}

// ─── Email 7 — Boas-vindas ────────────────────────────────────────────────

async function sendWelcomeFree({ to, name, dailyLimit } = {}) {
  if (!to) return { sent: false, reason: 'missing_to' };

  const limitStr = dailyLimit ? `${dailyLimit} capturas por dia` : 'capturas gratuitas por dia';
  const greeting = fn(name) ? `${fn(name)}, bem-vindo ao SnapDeck.` : 'Bem-vindo ao SnapDeck.';

  const body = [
    chipHtml('Plano Gratuito', [`${strongHtml(limitStr)}`, `Múltiplas páginas por captura · Download em ZIP`].join('<br/>')),
    pHtml(`Quando precisar de mais, o ${strongHtml('SnapDeck Pro')} desbloqueia capturas ilimitadas com um pagamento único via PIX.`),
  ].join('');

  return _send({
    from: FROM_NOREPLY(), to,
    subject: `Bem-vindo ao SnapDeck`,
    html: buildHtml({ h1: greeting, sub: 'Você está pronto para começar.', body, ctaText: 'Fazer minha primeira captura', ctaUrl: SITE_URL }),
    text: plain([greeting, '', `Plano gratuito: ${limitStr}`, `Comecar: ${SITE_URL}`]),
  });
}

// ─── Email 8 — Alerta interno ─────────────────────────────────────────────

async function sendInternalPaymentAlert({ customerEmail, plan, amount, pixTxId, activatedAt } = {}) {
  const adminEmail = ADMIN_EMAIL();
  if (!adminEmail) return { sent: false, reason: 'no_admin_email' };

  const ts   = activatedAt ? fmtDate(activatedAt) : new Date().toLocaleDateString('pt-BR');
  const txId = pixTxId || '–';

  const body = chipHtml('Detalhes da transação', [
    `${strongHtml('Cliente:')} ${customerEmail || '–'}`,
    `${strongHtml('Plano:')} ${plan}`,
    `${strongHtml('Valor:')} ${amount || '–'}`,
    `${strongHtml('TX ID:')} <span style="font-family:'Courier New',monospace;font-size:12px;">${txId}</span>`,
    `${strongHtml('Data:')} ${ts}`,
  ].join('<br/>'));

  return _send({
    from: FROM_NOREPLY(), to: adminEmail,
    subject: `[SnapDeck] Pagamento — ${plan} ${amount || ''}`.trim(),
    html: buildHtml({ h1: 'Novo pagamento confirmado.', sub: `${plan} · ${ts}`, body, ctaText: 'Ver painel', ctaUrl: SITE_URL }),
    text: plain([`Novo pagamento: ${plan}`, `Cliente: ${customerEmail || '–'}`, `Valor: ${amount || '–'}`, `TX ID: ${txId}`, `Data: ${ts}`]),
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  sendPaymentConfirmed,
  sendSnapCode,
  sendFirstCapture,
  sendPixReminder,
  sendFreeLimitReached,
  sendPlanExpiringSoon,
  sendWelcomeFree,
  sendInternalPaymentAlert,
};
