'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const CODES_FILE  = path.join(__dirname, 'data', 'codes.json');
const CODE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

// ── Persistence ───────────────────────────────────────────────────────────────
let store = {}; // { [code]: { captures: number, usedCaptures: number, createdAt, expiresAt, pkg } }

function load() {
  try {
    const raw = fs.readFileSync(CODES_FILE, 'utf8');
    store = JSON.parse(raw) || {};
  } catch { store = {}; }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(CODES_FILE), { recursive: true });
    fs.writeFileSync(CODES_FILE, JSON.stringify(store, null, 2));
  } catch {}
}

load();

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase(); // 16 chars
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a new access code with `captureCount` captures.
 * pkg: 'starter' | 'pro' | 'agency'
 */
function generateCode(captureCount, pkg) {
  const code = makeCode();
  store[code] = {
    captures:     captureCount,
    usedCaptures: 0,
    pkg:          pkg || 'starter',
    createdAt:    Date.now(),
    expiresAt:    Date.now() + CODE_TTL_MS,
  };
  save();
  return code;
}

/**
 * Validate code — returns { valid, reason, info }
 */
function validateCode(code) {
  if (!code || typeof code !== 'string') return { valid: false, reason: 'Código inválido.' };
  const entry = store[code.toUpperCase().trim()];
  if (!entry) return { valid: false, reason: 'Código não encontrado.' };
  if (Date.now() > entry.expiresAt) return { valid: false, reason: 'Código expirado.' };
  const remaining = entry.captures - entry.usedCaptures;
  if (remaining <= 0) return { valid: false, reason: 'Créditos esgotados neste código.' };
  return { valid: true, reason: null, info: { ...entry, remaining } };
}

/**
 * Consume one capture from a code. Returns remaining count.
 */
function decrementCode(code) {
  const upper = (code || '').toUpperCase().trim();
  const entry = store[upper];
  if (!entry) throw new Error('Código não encontrado.');
  if (entry.usedCaptures >= entry.captures) throw new Error('Créditos esgotados.');
  entry.usedCaptures += 1;
  save();
  return entry.captures - entry.usedCaptures;
}

/**
 * Get info for display.
 */
function getCodeInfo(code) {
  const entry = store[(code || '').toUpperCase().trim()];
  if (!entry) return null;
  return { ...entry, remaining: entry.captures - entry.usedCaptures };
}

module.exports = { generateCode, validateCode, decrementCode, getCodeInfo };
