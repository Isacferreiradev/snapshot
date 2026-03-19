'use strict';

const fs   = require('fs');
const path = require('path');

const QUOTA_FILE  = path.join(__dirname, 'data', 'quota.json');
const FREE_DAILY  = 5;
const DAY_MS      = 24 * 60 * 60 * 1000;
const CLEANUP_INT = 60 * 60 * 1000; // 1 h

// ── Persistence ───────────────────────────────────────────────────────────────
let store = {}; // { [ip]: { count: number, resetAt: timestamp } }

function load() {
  try {
    const raw = fs.readFileSync(QUOTA_FILE, 'utf8');
    store = JSON.parse(raw) || {};
  } catch { store = {}; }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(store));
  } catch {}
}

load();

// ── Cleanup expired entries ───────────────────────────────────────────────────
function resetExpired() {
  const now = Date.now();
  let changed = false;
  for (const ip of Object.keys(store)) {
    if (store[ip].resetAt && now >= store[ip].resetAt) {
      delete store[ip];
      changed = true;
    }
  }
  if (changed) save();
}

setInterval(resetExpired, CLEANUP_INT);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns { allowed: boolean, remaining: number, resetAt: timestamp }
 */
function checkQuota(ip) {
  resetExpired();
  const entry = store[ip];
  if (!entry) return { allowed: true, remaining: FREE_DAILY, resetAt: null };
  if (entry.count >= FREE_DAILY) return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  return { allowed: true, remaining: FREE_DAILY - entry.count, resetAt: entry.resetAt };
}

/**
 * Decrements the free quota for an IP. Returns remaining count.
 */
function decrementFree(ip) {
  resetExpired();
  if (!store[ip]) {
    store[ip] = { count: 1, resetAt: Date.now() + DAY_MS };
  } else {
    store[ip].count += 1;
  }
  save();
  return Math.max(0, FREE_DAILY - store[ip].count);
}

/**
 * Returns the current quota state for the header indicator.
 */
function getQuotaInfo(ip) {
  resetExpired();
  const entry = store[ip];
  const used  = entry ? entry.count : 0;
  return {
    used,
    total:     FREE_DAILY,
    remaining: Math.max(0, FREE_DAILY - used),
    resetAt:   entry ? entry.resetAt : null,
  };
}

function resetQuota(ip) {
  if (store[ip]) {
    delete store[ip];
    save();
  }
}

module.exports = { checkQuota, decrementFree, getQuotaInfo, resetExpired, resetQuota };
