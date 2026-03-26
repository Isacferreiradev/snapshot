'use strict';

const dns = require('dns').promises;
const net  = require('net');

// ─────────────────────────────────────────────────────────
// SSRF PROTECTION
// ─────────────────────────────────────────────────────────

const BLOCKED_IP_RANGES = [
  /^127\./,                                   // loopback IPv4
  /^::1$/,                                    // loopback IPv6
  /^0\.0\.0\.0$/,                             // meta
  /^169\.254\./,                              // link-local / AWS metadata
  /^fe80:/i,                                  // link-local IPv6
  /^10\./,                                    // RFC 1918
  /^172\.(1[6-9]|2[0-9]|3[01])\./,           // RFC 1918
  /^192\.168\./,                              // RFC 1918
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // RFC 6598 CG-NAT
  /^224\./,                                   // multicast
  /^255\.255\.255\.255$/,                     // broadcast
  /^fc00:/i,                                  // IPv6 unique local
  /^fd[0-9a-f]{2}:/i,                         // IPv6 unique local
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localtest.me', 'vcap.me', 'lvh.me',
  'metadata.google.internal',
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Verifica se um IP pertence a um range privado/reservado.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  return BLOCKED_IP_RANGES.some(re => re.test(ip));
}

/**
 * Valida uma URL fornecida pelo usuário antes de passar ao Puppeteer.
 * Fail-closed: qualquer dúvida retorna { valid: false }.
 * @param {string} rawUrl
 * @returns {Promise<{ valid: boolean, url?: string, reason?: string }>}
 */
async function validateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, reason: 'URL inválida.' };
  }

  if (rawUrl.length > 2000) {
    return { valid: false, reason: 'URL muito longa.' };
  }

  // Rejeitar qualquer protocolo diferente de http/https ANTES de normalizar
  // Previne: file://, data://, javascript://, ftp:// etc.
  const protoMatch = rawUrl.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (protoMatch) {
    const rawProto = protoMatch[1].toLowerCase() + ':';
    if (!ALLOWED_PROTOCOLS.has(rawProto)) {
      console.warn(`[Security] Protocolo bloqueado (pré-parse): ${rawProto} — ${rawUrl}`);
      return { valid: false, reason: 'Protocolo não permitido. Use http:// ou https://.' };
    }
  }

  let parsed;
  try {
    const urlToTest = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    parsed = new URL(urlToTest);
  } catch {
    return { valid: false, reason: 'URL malformada.' };
  }

  // Segunda checagem no protocolo parseado (defense in depth)
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    console.warn(`[Security] Protocolo bloqueado: ${parsed.protocol} — ${rawUrl}`);
    return { valid: false, reason: 'Protocolo não permitido. Use http:// ou https://.' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Bloquear hostnames reservados
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    console.warn(`[Security] Hostname bloqueado: ${hostname}`);
    return { valid: false, reason: 'URL não permitida.' };
  }

  // Bloquear IPs privados diretamente na URL
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      console.warn(`[Security] IP privado bloqueado: ${hostname}`);
      return { valid: false, reason: 'URL não permitida.' };
    }
  } else {
    // Resolver DNS e verificar IP resultante (proteção contra DNS rebinding)
    try {
      const [v4, v6] = await Promise.all([
        dns.resolve4(hostname).catch(() => []),
        dns.resolve6(hostname).catch(() => []),
      ]);
      for (const ip of [...v4, ...v6]) {
        if (isPrivateIp(ip)) {
          console.warn(`[Security] DNS rebind bloqueado: ${hostname} → ${ip}`);
          return { valid: false, reason: 'URL não permitida.' };
        }
      }
    } catch {
      // Se DNS falhar, o Puppeteer vai falhar naturalmente — não bloquear
    }
  }

  return { valid: true, url: parsed.href };
}

// ─────────────────────────────────────────────────────────
// PATH TRAVERSAL PROTECTION
// ─────────────────────────────────────────────────────────

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID  = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Valida que um jobId é um UUID v4 seguro.
 * Rejeita qualquer coisa com ../, null bytes, etc.
 */
function validateJobId(jobId) {
  if (!jobId || typeof jobId !== 'string') return false;
  return UUID_RE.test(jobId) || SAFE_ID.test(jobId);
}

/**
 * Sanitiza um nome de arquivo para uso em Content-Disposition.
 * Remove caracteres que poderiam causar header injection.
 */
function sanitizeFilename(name) {
  return String(name || 'snapshot')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '-')
    .substring(0, 100);
}

// ─────────────────────────────────────────────────────────
// INPUT SANITIZATION
// ─────────────────────────────────────────────────────────

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Detecta tentativa de prototype pollution em um objeto.
 */
function hasPrototypePollution(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return Object.keys(obj).some(k => PROTO_KEYS.has(k));
}

/**
 * Remove chaves perigosas recursivamente.
 * Preserva arrays como arrays.
 */
function sanitizeBody(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => sanitizeBody(item));
  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (PROTO_KEYS.has(key)) continue;
    clean[key] = typeof value === 'object' && value !== null ? sanitizeBody(value) : value;
  }
  return clean;
}

// ─────────────────────────────────────────────────────────
// PUPPETEER REQUEST INTERCEPTOR (SSRF mid-navigation)
// ─────────────────────────────────────────────────────────

/**
 * Instala interceptor de requests no Puppeteer que bloqueia:
 * - Protocolos não-HTTP(S) (exceto data: que páginas legítimas usam)
 * - Requisições para IPs privados mid-navigation (DNS rebinding)
 * - Tipos de recurso desnecessários (websocket)
 *
 * Deve ser chamado ANTES de setRequestInterception do caller,
 * ou o caller deve chamar esta função no lugar de setar interception manualmente.
 *
 * @param {import('puppeteer').Page} page
 * @param {(req: import('puppeteer').HTTPRequest) => void} continueHandler
 *   Função chamada para requests que passam na validação de segurança.
 *   Responsabilidade do caller de chamar req.continue() ou req.abort() nela.
 */
async function installSsrfInterceptor(page, continueHandler) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();

    try {
      const parsed = new URL(url);
      const proto  = parsed.protocol;

      // Bloquear protocolos perigosos (permitir data: e blob: que páginas legítimas usam)
      if (proto !== 'http:' && proto !== 'https:' && proto !== 'data:' && proto !== 'blob:') {
        console.warn(`[Puppeteer/SSRF] Protocolo bloqueado mid-nav: ${proto} — ${url.slice(0, 80)}`);
        return req.abort('blockedbyclient');
      }

      // Bloquear IPs privados mid-navigation (proteção contra DNS rebinding)
      if ((proto === 'http:' || proto === 'https:') && net.isIP(parsed.hostname) && isPrivateIp(parsed.hostname)) {
        console.warn(`[Puppeteer/SSRF] IP privado bloqueado mid-nav: ${parsed.hostname}`);
        return req.abort('blockedbyclient');
      }

      // Bloquear websockets — não necessários para screenshot
      if (req.resourceType() === 'websocket') {
        return req.abort('blockedbyclient');
      }

    } catch {
      return req.abort('blockedbyclient');
    }

    // Delegar ao handler original
    continueHandler(req);
  });
}

module.exports = {
  validateUrl,
  isPrivateIp,
  validateJobId,
  sanitizeFilename,
  hasPrototypePollution,
  sanitizeBody,
  installSsrfInterceptor,
};
