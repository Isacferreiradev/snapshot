'use strict';

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'data', 'config.json');

let _config = {};
try { _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { _config = { plans: {} }; }

function getConfig() { return _config; }

function getPlanConfig(planName) {
  return (_config.plans && _config.plans[planName]) || _config.plans.free || {};
}

function reloadConfig() {
  try { _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  return _config;
}

function isFeatureAllowed(planName, feature) {
  const plan = getPlanConfig(planName);
  return !!plan[feature];
}

function getLimit(planName, limitName) {
  const plan = getPlanConfig(planName);
  return plan[limitName] !== undefined ? plan[limitName] : 0;
}

function isTemplateUnlocked(planName, templateId) {
  const plan = getPlanConfig(planName);
  if (!plan.templatesUnlocked) return false;
  if (plan.templatesUnlocked === 'all') return true;
  return Array.isArray(plan.templatesUnlocked) && plan.templatesUnlocked.includes(templateId);
}

module.exports = { getConfig, getPlanConfig, reloadConfig, isFeatureAllowed, getLimit, isTemplateUnlocked };
