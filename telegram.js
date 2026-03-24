'use strict';

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID   || '';

/**
 * Envia mensagem de texto para o chat configurado.
 * Falha silenciosamente — nunca lança exceção.
 */
async function sendAlert(message) {
  if (!TOKEN || !CHAT_ID) return; // não configurado
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' }),
    });
  } catch {}
}

module.exports = { sendAlert };
