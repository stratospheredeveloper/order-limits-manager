(function () {
  const productRoots = Array.from(document.querySelectorAll('[data-limitpro-product-notice]'));
  const cartRoot = document.querySelector('[data-limitpro-cart-validator]');
  let inlineCartRoot = null;
  let autoProductRoot = null;

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
      [
        'button[name="checkout"]',
        'input[name="checkout"]',
        'a[href*="/checkout"]',
        'button[data-testid*="checkout"]',
        'button[class*="checkout"]',
        '.shopify-payment-button__button',
      ].join(', ')
    ));
  }

  function findInlineCartBannerMount() {
    const checkoutTarget = checkoutTargets()[0];
    if (!checkoutTarget) {
      return null;
    }

    return checkoutTarget.closest(
      [
        '.cart__footer',
        '.cart-drawer__footer',
        '.drawer__footer',
        '.ajaxcart__footer',
        '.mini-cart__footer',
        'form[action*="/cart"]',
      ].join(', ')
    ) || checkoutTarget.parentElement;
  }

  function ensureInlineCartBannerRoot() {
    const mount = findInlineCartBannerMount();

    if (!mount) {
      if (inlineCartRoot && !inlineCartRoot.isConnected) {
        inlineCartRoot = null;
      }
      return null;
    }

    if (inlineCartRoot && inlineCartRoot.isConnected) {
      return inlineCartRoot;
    }

    inlineCartRoot = document.createElement('div');
    inlineCartRoot.setAttribute('data-limitpro-inline-cart-validator', '');
    mount.prepend(inlineCartRoot);
    return inlineCartRoot;
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

    const inlineHost = ensureInlineCartBannerRoot();
    const hosts = inlineHost ? [inlineHost] : [cartRoot];
    const bannerMarkup = `
      <div class="limitpro-banner" role="status" aria-live="polite">
        <p class="limitpro-banner__title">Order limits need attention</p>
        <p class="limitpro-banner__summary">Update the cart before checkout can continue.</p>
        <ul class="limitpro-banner__list">
          ${state.violations.map((violation) => `<li>${escapeHtml(violation.message)}</li>`).join('')}
        </ul>
      </div>
    `;

    if (!state.violations.length || !state.showCartWarning) {
      hosts.forEach((host) => {
        host.hidden = true;
        host.innerHTML = '';
      });
      if (inlineHost && cartRoot) {
        cartRoot.hidden = true;
        cartRoot.innerHTML = '';
      }
      return;
    }

    hosts.forEach((host) => {
      host.hidden = false;
      host.innerHTML = bannerMarkup;
    });

    if (inlineHost && cartRoot) {
      cartRoot.hidden = true;
      cartRoot.innerHTML = '';
    }
  }

  let pendingCartValidation = null;
  let rerunCartValidation = false;

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
    } finally {
      if (rerunCartValidation) {
        rerunCartValidation = false;
        scheduleCartValidation();
      }
    }
  }

  function scheduleCartValidation() {
    if (!cartRoot) {
      return;
    }

    if (pendingCartValidation) {
      rerunCartValidation = true;
      return;
    }

    pendingCartValidation = window.setTimeout(validateCart, 180);
  }

  function currentVariantId() {
    const variantInput = document.querySelector(
      [
        'form[action*="/cart/add"] [name="id"]',
        'product-form [name="id"]',
        'input[name="id"][form]',
        'select[name="id"]',
      ].join(', ')
    );

    return variantInput?.value || cartRoot?.dataset.variantId || null;
  }

  function currentProductId() {
    return cartRoot?.dataset.productId
      || window?.ShopifyAnalytics?.meta?.product?.id?.toString()
      || window?.meta?.product?.id?.toString()
      || null;
  }

  function findProductNoticeMount() {
    return document.querySelector(
      [
        '.product__info-container',
        '.product__info-wrapper',
        '.product__column-sticky',
        '.product-form',
        'product-form',
        'form[action*="/cart/add"]',
      ].join(', ')
    );
  }

  function hasManualProductNoticeRoot() {
    return productRoots.some((root) => root.dataset.autoInjected !== 'true');
  }

  function ensureAutoProductNoticeRoot() {
    if (!cartRoot || hasManualProductNoticeRoot()) {
      return {
        root: null,
        created: false,
      };
    }

    const productId = currentProductId();
    const mount = findProductNoticeMount();

    if (!productId || !mount) {
      return {
        root: null,
        created: false,
      };
    }

    if (autoProductRoot && autoProductRoot.isConnected) {
      autoProductRoot.dataset.productId = productId;
      autoProductRoot.dataset.variantId = currentVariantId() || '';
      return {
        root: autoProductRoot,
        created: false,
      };
    }

    autoProductRoot = document.createElement('div');
    autoProductRoot.setAttribute('data-limitpro-product-notice', '');
    autoProductRoot.dataset.shop = cartRoot.dataset.shop;
    autoProductRoot.dataset.productId = productId;
    autoProductRoot.dataset.variantId = currentVariantId() || '';
    autoProductRoot.dataset.apiBase = cartRoot.dataset.apiBase;
    autoProductRoot.dataset.heading = 'Order limits';
    autoProductRoot.dataset.showEmpty = 'false';
    autoProductRoot.dataset.autoInjected = 'true';

    if (mount.matches('form[action*="/cart/add"], product-form, .product-form')) {
      mount.insertAdjacentElement('afterend', autoProductRoot);
    } else {
      mount.appendChild(autoProductRoot);
    }

    productRoots.push(autoProductRoot);
    return {
      root: autoProductRoot,
      created: true,
    };
  }

  async function renderProductNotice(root) {
    if (!root) {
      return;
    }

    root.dataset.variantId = currentVariantId() || root.dataset.variantId || '';
    await initProductNotice(root);
  }

  async function syncProductNotice(force = false) {
    const { root, created } = ensureAutoProductNoticeRoot();

    if (root && (force || created)) {
      await renderProductNotice(root);
    }
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
    ensureInlineCartBannerRoot();
    validateCart();
    window.addEventListener('pageshow', scheduleCartValidation);
    window.addEventListener('focus', scheduleCartValidation);
    window.addEventListener('load', () => {
      ensureInlineCartBannerRoot();
      syncProductNotice(true);
    });

    let pendingUiSync = false;
    const observer = new MutationObserver(() => {
      if (pendingUiSync) {
        return;
      }

      pendingUiSync = true;
      window.requestAnimationFrame(() => {
        pendingUiSync = false;
        ensureInlineCartBannerRoot();
        applyCheckoutState();
        renderCartBanner();
        syncProductNotice();
      });
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

      const activeBannerRoot = inlineCartRoot && !inlineCartRoot.hidden
        ? inlineCartRoot
        : cartRoot;

      if (activeBannerRoot && !activeBannerRoot.hidden) {
        activeBannerRoot.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, true);

    document.addEventListener('change', (event) => {
      if (event.target.closest('form[action*="/cart"]')) {
        scheduleCartValidation();
      }

      if (event.target.matches('form[action*="/cart/add"] [name="id"], product-form [name="id"], select[name="id"]')) {
        syncProductNotice(true);
      }
    }, true);

    document.addEventListener('submit', (event) => {
      if (event.target.matches('form[action*="/cart"]')) {
        scheduleCartValidation();
      }
    }, true);
  }

  async function initProductNotice(root) {
    const showEmpty = root.dataset.showEmpty === 'true';
    const params = new URLSearchParams({
      shop: root.dataset.shop,
      productId: root.dataset.productId,
    });

    if (root.dataset.variantId) {
      params.set('variantId', root.dataset.variantId);
    }

    try {
      const result = await fetchJson(
        buildApiUrl(root.dataset.apiBase, `api/storefront/product-rules?${params.toString()}`)
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
  syncProductNotice(true);
  productRoots
    .filter((root) => root.dataset.autoInjected !== 'true')
    .forEach(renderProductNotice);
})();
