(function () {
  const productRoots = Array.from(document.querySelectorAll('[data-limitpro-product-notice]'));
  const cartRoot = document.querySelector('[data-limitpro-cart-validator]');

  if (!productRoots.length && !cartRoot) {
    return;
  }

  const state = window.__limitproThemeState || {
    violations: [],
    invalid: false,
    blockCheckout: false,
    showCartWarning: true,
  };
  window.__limitproThemeState = state;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildApiUrl(base, pathname) {
    return new URL(pathname, `${base.replace(/\/$/, '')}/`).toString();
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || 'Request failed');
    }

    return data;
  }

  function currentShopifyRoot() {
    return (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
  }

  async function fetchCart() {
    const response = await fetch(`${currentShopifyRoot()}cart.js`, {
      credentials: 'same-origin',
    });

    if (!response.ok) {
      throw new Error('Failed to load cart');
    }

    return response.json();
  }

  function checkoutTargets() {
    return Array.from(document.querySelectorAll(
      'button[name="checkout"], input[name="checkout"], a[href*="/checkout"], button[data-testid*="checkout"]'
    ));
  }

  function applyCheckoutState() {
    checkoutTargets().forEach((element) => {
      const shouldDisable = state.invalid && state.blockCheckout;

      element.classList.toggle('limitpro-checkout-disabled', shouldDisable);

      if (element.tagName === 'BUTTON' || element.tagName === 'INPUT') {
        element.disabled = shouldDisable;
      } else {
        element.setAttribute('aria-disabled', shouldDisable ? 'true' : 'false');
      }
    });
  }

  function renderCartBanner() {
    if (!cartRoot) {
      return;
    }

    if (!state.violations.length || !state.showCartWarning) {
      cartRoot.hidden = true;
      cartRoot.innerHTML = '';
      return;
    }

    cartRoot.hidden = false;
    cartRoot.innerHTML = `
      <div class="limitpro-banner" role="status" aria-live="polite">
        <p class="limitpro-banner__title">Order limits need attention</p>
        <p class="limitpro-banner__summary">Update the cart before checkout can continue.</p>
        <ul class="limitpro-banner__list">
          ${state.violations.map((violation) => `<li>${escapeHtml(violation.message)}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  let pendingCartValidation = null;

  async function validateCart() {
    if (!cartRoot) {
      return;
    }

    pendingCartValidation = null;

    try {
      const cart = await fetchCart();
      const payload = {
        shop: cartRoot.dataset.shop,
        items: (cart.items || []).map((item) => ({
          title: item.product_title || item.title,
          quantity: item.quantity,
          product_id: item.product_id,
          variant_id: item.variant_id,
        })),
      };

      const result = await fetchJson(
        buildApiUrl(cartRoot.dataset.apiBase, 'api/validate-cart'),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }
      );

      state.violations = result.violations || [];
      state.invalid = !result.valid;
      state.blockCheckout = Boolean(result.blockCheckout);
      state.showCartWarning = result.showCartWarning !== false;
      applyCheckoutState();
      renderCartBanner();
    } catch (error) {
      console.error('LimitPro cart validation failed:', error);
    }
  }

  function scheduleCartValidation() {
    if (!cartRoot || pendingCartValidation) {
      return;
    }

    pendingCartValidation = window.setTimeout(validateCart, 180);
  }

  function patchCartRequests() {
    if (window.__limitproCartPatched || !cartRoot) {
      return;
    }
    window.__limitproCartPatched = true;

    const nativeFetch = window.fetch;
    window.fetch = async function patchedFetch(...args) {
      const response = await nativeFetch.apply(this, args);
      const requestUrl = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;

      if (requestUrl && /\/cart(\/|\.js|\?)/.test(requestUrl)) {
        scheduleCartValidation();
      }

      return response;
    };

    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__limitproUrl = url;
      return nativeOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function patchedSend() {
      this.addEventListener('loadend', () => {
        if (this.__limitproUrl && /\/cart(\/|\.js|\?)/.test(this.__limitproUrl)) {
          scheduleCartValidation();
        }
      });

      return nativeSend.apply(this, arguments);
    };
  }

  function initCartValidator() {
    if (!cartRoot) {
      return;
    }

    patchCartRequests();
    validateCart();
    window.addEventListener('pageshow', scheduleCartValidation);
    window.addEventListener('focus', scheduleCartValidation);

    const observer = new MutationObserver(() => {
      applyCheckoutState();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    document.addEventListener('click', (event) => {
      if (!state.invalid || !state.blockCheckout) {
        return;
      }

      const checkoutElement = event.target.closest('a[href*="/checkout"], button[name="checkout"], input[name="checkout"]');
      if (!checkoutElement) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      renderCartBanner();

      if (!cartRoot.hidden) {
        cartRoot.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, true);
  }

  async function initProductNotice(root) {
    const showEmpty = root.dataset.showEmpty === 'true';

    try {
      const result = await fetchJson(
        buildApiUrl(root.dataset.apiBase, `api/storefront/product-rules?shop=${encodeURIComponent(root.dataset.shop)}&productId=${encodeURIComponent(root.dataset.productId)}`)
      );

      if (!result.hasRules && !showEmpty) {
        root.hidden = true;
        return;
      }

      const minMarkup = result.minQuantity
        ? `
          <div class="limitpro-product-card__metric">
            <div class="limitpro-product-card__metric-label">Minimum</div>
            <div class="limitpro-product-card__metric-value">${escapeHtml(result.minQuantity)}</div>
          </div>
        `
        : '';
      const maxMarkup = result.maxQuantity
        ? `
          <div class="limitpro-product-card__metric">
            <div class="limitpro-product-card__metric-label">Maximum</div>
            <div class="limitpro-product-card__metric-value">${escapeHtml(result.maxQuantity)}</div>
          </div>
        `
        : '';
      const message = result.message
        || (result.hasRules
          ? 'These limits are checked again in the cart before checkout.'
          : 'No product-specific limit is saved for this item yet.');

      root.hidden = false;
      root.innerHTML = `
        <div class="limitpro-product-card">
          <div class="limitpro-product-card__eyebrow">Purchase guidance</div>
          <h3 class="limitpro-product-card__title">${escapeHtml(root.dataset.heading || 'Order limits')}</h3>
          ${(minMarkup || maxMarkup) ? `<div class="limitpro-product-card__grid">${minMarkup}${maxMarkup}</div>` : ''}
          <p class="limitpro-product-card__message">${escapeHtml(message)}</p>
        </div>
      `;
    } catch (error) {
      console.error('LimitPro product notice failed:', error);
      if (!showEmpty) {
        root.hidden = true;
      }
    }
  }

  initCartValidator();
  productRoots.forEach(initProductNotice);
})();
