/**
 * Snapdeck — Módulo central de rastreamento Meta Pixel
 * Pixel ID: 1343135307625371
 *
 * Inclua APÓS o snippet do Pixel. Expõe window.Track.*
 * Nunca chame fbq() diretamente fora deste módulo.
 */
(function () {
  'use strict';

  const PIXEL_ID   = '1343135307625371'; // eslint-disable-line no-unused-vars
  const PLAN_PRICES = { starter: 19.90, pro: 49.90, agency: 97.90 };

  // ── Deduplicação ────────────────────────────────────────────────────────────
  // sessionStorage persiste em navegações na mesma aba, reseta ao fechar.
  function _fired(key) {
    try { return sessionStorage.getItem('_t_' + key) === '1'; } catch { return false; }
  }
  function _setFired(key) {
    try { sessionStorage.setItem('_t_' + key, '1'); } catch {}
  }

  /** Executa fn apenas uma vez por sessão. Retorna true se disparou. */
  function once(key, fn) {
    if (_fired(key)) { _log('(dedup) ' + key); return false; }
    _setFired(key);
    fn();
    return true;
  }

  /** Debounce simples: impede duplo-disparo em cliques acidentais (ex: dois eventos click). */
  const _debounceTs = {};
  function debounced(key, fn, ms) {
    ms = ms || 800;
    const now = Date.now();
    if (_debounceTs[key] && now - _debounceTs[key] < ms) { _log('(debounce) ' + key); return false; }
    _debounceTs[key] = now;
    fn();
    return true;
  }

  // ── Logger ───────────────────────────────────────────────────────────────────
  function _log(event, data) {
    if (data !== undefined) {
      console.log('[TRACK]', event, data);
    } else {
      console.log('[TRACK]', event);
    }
  }

  // ── Wrapper fbq seguro ───────────────────────────────────────────────────────
  function _fbq(method, event, data) {
    if (typeof fbq === 'undefined') {
      _log('fbq não disponível —', event + (data ? ' ' + JSON.stringify(data) : ''));
      return;
    }
    if (data !== undefined) {
      fbq(method, event, data);
    } else {
      fbq(method, event);
    }
    _log(event, data);
  }

  // ── Fonte da compra ──────────────────────────────────────────────────────────
  // Persiste para sobreviver ao redirect landing → /app
  function _getSource() {
    try { return sessionStorage.getItem('_snap_src') || 'product_flow'; } catch { return 'product_flow'; }
  }
  function _setSource(src) {
    try { sessionStorage.setItem('_snap_src', src); } catch {}
  }

  // ── API pública ──────────────────────────────────────────────────────────────
  window.Track = {

    /**
     * PageView — disparado automaticamente pelo snippet do Pixel.
     * Exposto aqui apenas para completude (não precisa ser chamado manualmente).
     */
    trackPageView() {
      _fbq('track', 'PageView');
    },

    /**
     * Landing carregada — usuário viu o conteúdo comercial.
     * Disparo: uma vez por sessão, apenas na landing.
     */
    trackViewContent() {
      once('ViewContent', () => _fbq('track', 'ViewContent'));
    },

    /**
     * Usuário clicou em CTA de exploração ("Capturar agora", "Testar grátis").
     * Marca origem como product_flow.
     * Disparo: uma vez por sessão.
     */
    trackStartFlow() {
      once('StartFlow', () => {
        _setSource('product_flow');
        _fbq('trackCustom', 'StartFlow');
      });
    },

    /**
     * Usuário confirmou páginas e iniciou captura.
     * Disparo: uma vez por sessão.
     */
    trackSelectPages() {
      once('SelectPages', () => _fbq('trackCustom', 'SelectPages'));
    },

    /**
     * Usuário selecionou ou trocou de template.
     * Pode disparar múltiplas vezes (sem once).
     * @param {string} templateId
     */
    trackSelectTemplate(templateId) {
      _fbq('trackCustom', 'SelectTemplate', { template: templateId || 'void' });
    },

    /**
     * Tela de download exibida (captura concluída).
     * Disparo: uma vez por sessão.
     */
    trackViewDownload() {
      once('ViewDownload', () => _fbq('trackCustom', 'ViewDownload'));
    },

    /**
     * Usuário clicou em um botão de download.
     * Pode disparar múltiplas vezes (usuário pode re-baixar).
     */
    trackDownload() {
      _fbq('trackCustom', 'Download');
    },

    /**
     * Usuário clicou em "Assinar" / "Começar" — antes de abrir o modal de pagamento.
     * source: 'landing' | 'app'
     * Marca origem para o evento Purchase posterior.
     * Debounce de 800ms para evitar duplo-disparo no mesmo clique.
     * @param {string} source  'landing' | 'app'
     * @param {string} plan    ex: 'starter', 'pro'
     */
    trackInitiateCheckout(source, plan) {
      debounced('InitiateCheckout', () => {
        // Marca a origem da compra
        _setSource(source === 'landing' ? 'landing_direct' : 'product_flow');
        _fbq('track', 'InitiateCheckout', { source: source, plan: plan || '' });
      });
    },

    /**
     * Pagamento PIX confirmado — evento CRÍTICO.
     * Nunca duplicado: once() por sessão + flag no servidor.
     * @param {number|string} value   valor pago (ex: 19.90)
     * @param {string}        plan    planKey (ex: 'starter')
     */
    trackPurchase(value, plan) {
      once('Purchase', () => {
        const amount = parseFloat(value) || PLAN_PRICES[plan] || PLAN_PRICES.starter;
        const source = _getSource();
        _fbq('track', 'Purchase', {
          value:    amount,
          currency: 'BRL',
          source:   source,
          plan:     plan || '',
        });
        try { sessionStorage.removeItem('_snap_src'); } catch {}
      });
    },
  };

  _log('módulo carregado');
})();
