/**
 * Snapdeck — Módulo central de rastreamento Meta Pixel
 * Pixel ID: 1343135307625371
 *
 * Uso: inclua este arquivo após o snippet do Pixel.
 * Todos os eventos são expostos via window.Track.*
 */
(function () {
  'use strict';

  const PLAN_VALUES = { starter: 19.90, pro: 49.90, agency: 97.90 };

  // ── Deduplicação por sessão ─────────────────────────────────────────────────
  // Usar sessionStorage para sobreviver a navegações dentro da mesma aba,
  // mas resetar ao fechar o browser.
  function _hasFired(key) {
    try { return sessionStorage.getItem('snap_track_' + key) === '1'; } catch { return false; }
  }
  function _markFired(key) {
    try { sessionStorage.setItem('snap_track_' + key, '1'); } catch {}
  }

  /** Dispara fn apenas uma vez por sessão (mesmo que o módulo seja recarregado) */
  function once(key, fn) {
    if (_hasFired(key)) {
      console.log('[TRACK] (já disparado, ignorando)', key);
      return false;
    }
    _markFired(key);
    fn();
    return true;
  }

  // ── Wrapper seguro do fbq ───────────────────────────────────────────────────
  function safe(method, event, data) {
    if (typeof fbq === 'undefined') {
      console.log('[TRACK] fbq não carregado —', method, event, data || '');
      return;
    }
    if (data) fbq(method, event, data);
    else      fbq(method, event);
    console.log('[TRACK]', event, data !== undefined ? data : '');
  }

  // ── Fonte da compra ─────────────────────────────────────────────────────────
  // 'landing_direct'  → usuário clicou em "Assinar" na landing
  // 'product_flow'    → usuário usou o produto antes de comprar
  function getPurchaseSource() {
    try { return sessionStorage.getItem('snap_purchase_source') || 'product_flow'; } catch { return 'product_flow'; }
  }
  function setPurchaseSource(src) {
    try { sessionStorage.setItem('snap_purchase_source', src); } catch {}
  }

  // ── API pública ─────────────────────────────────────────────────────────────
  window.Track = {

    /**
     * Landing page carregada.
     * Disparo: uma vez na landing.
     */
    viewContent() {
      once('ViewContent', () => safe('track', 'ViewContent'));
    },

    /**
     * Usuário clicou em CTA de exploração ("Capturar agora", "Testar grátis").
     * Marca a origem como 'product_flow'.
     * Disparo: uma vez por sessão.
     */
    startFlow() {
      once('StartFlow', () => {
        setPurchaseSource('product_flow');
        safe('trackCustom', 'StartFlow');
      });
    },

    /**
     * Usuário confirmou as páginas e iniciou a captura (step 4 → 5).
     * Disparo: uma vez por sessão.
     */
    selectPages() {
      once('SelectPages', () => safe('trackCustom', 'SelectPages'));
    },

    /**
     * Usuário selecionou ou trocou de template.
     * Pode disparar mais de uma vez (não usa once).
     * @param {string} templateId
     */
    selectTemplate(templateId) {
      safe('trackCustom', 'SelectTemplate', { template: templateId || 'void' });
    },

    /**
     * Tela de download exibida (captura concluída, step 6).
     * Disparo: uma vez por sessão.
     */
    viewDownload() {
      once('ViewDownload', () => safe('trackCustom', 'ViewDownload'));
    },

    /**
     * Usuário clicou no botão de download.
     * Pode disparar mais de uma vez (não usa once — o usuário pode baixar múltiplos formatos).
     */
    download() {
      safe('trackCustom', 'Download');
    },

    /**
     * Usuário clicou em "Assinar" / "Começar" diretamente na landing.
     * Marca origem como 'landing_direct'.
     * Disparo: uma vez por sessão.
     * @param {string} plan  ex: 'starter', 'pro'
     */
    initiateCheckout(plan) {
      once('InitiateCheckout', () => {
        setPurchaseSource('landing_direct');
        safe('track', 'InitiateCheckout', { content_name: plan });
      });
    },

    /**
     * Pagamento PIX confirmado — EVENTO CRÍTICO.
     * Diferencia origem: landing_direct vs product_flow.
     * Disparo: APENAS uma vez por sessão (never duplicado).
     * @param {string} planKey  ex: 'starter', 'pro'
     */
    purchase(planKey) {
      once('Purchase', () => {
        const value  = PLAN_VALUES[planKey] || PLAN_VALUES.starter;
        const source = getPurchaseSource();
        safe('track', 'Purchase', { value, currency: 'BRL', source });
        // Limpa a origem após a compra para evitar re-atribuição
        try { sessionStorage.removeItem('snap_purchase_source'); } catch {}
      });
    },
  };

  console.log('[TRACK] módulo carregado — pixel 1343135307625371');
})();
