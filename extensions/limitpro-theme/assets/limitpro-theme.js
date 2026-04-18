(function () {
  const manualProductRoots = Array.from(document.querySelectorAll('[data-limitpro-product-notice]'));
  const cartRoot = document.querySelector('[data-limitpro-cart-validator]');
  const primaryRoot = cartRoot || manualProductRoots[0];

  if (!primaryRoot) {
    return;
  }

  const state = window.__limitproThemeState || {
    invalid: false,
    blockCheckout: false,
    violations: [],
  };
  window.__limitproThemeState = state;

  let autoProductRoot = null;
  let cartFooterRoot = null;
  let pendingCartValidation = null;
  let rerunCartValidation = false;
  let productRuleCacheKey = null;
  let productRuleCache = [];

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

  function shopDomain() {
    return primaryRoot?.dataset.shop || '';
  }

  function apiBase() {
    return primaryRoot?.dataset.apiBase || window.location.origin;
  }

  function warningMarkup(messages) {
    return `
      <div class="limitpro-warning" role="status" aria-live="polite">
        ${messages.map((message) => `<p class="limitpro-warning__message">${escapeHtml(message)}</p>`).join('')}
      </div>
    `;
  }

  function renderWarningHost(host, messages) {
    if (!host) {
      return;
    }

    if (!messages.length) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }

    host.hidden = false;
    host.innerHTML = warningMarkup(messages);
  }

  function checkoutTargets() {
    return Array.from(document.querySelectorAll([
      'button[name="checkout"]',
      'input[name="checkout"]',
      'a[href*="/checkout"]',
      'button[data-testid*="checkout"]',
      'button[class*="checkout"]',
      '.shopify-payment-button__button',
    ].join(', ')));
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

  function currentProductId() {
    return cartRoot?.dataset.productId
      || manualProductRoots[0]?.dataset.productId
      || window?.ShopifyAnalytics?.meta?.product?.id?.toString()
      || window?.meta?.product?.id?.toString()
      || null;
  }

  function currentVariantId() {
    const variantInput = document.querySelector([
      'form[action*="/cart/add"] [name="id"]',
      'product-form [name="id"]',
      'input[name="id"][form]',
      'select[name="id"]',
    ].join(', '));

    return variantInput?.value || cartRoot?.dataset.variantId || manualProductRoots[0]?.dataset.variantId || null;
  }

  function currentProductQuantity() {
    const quantityInput = document.querySelector([
      'form[action*="/cart/add"] input[name="quantity"]',
      'product-form input[name="quantity"]',
      'input[name="quantity"][form]',
    ].join(', '));

    return Math.max(1, Number(quantityInput?.value) || 1);
  }

  function findProductNoticeMount() {
    const buyButtons = document.querySelector([
      'form[action*="/cart/add"] .shopify-payment-button',
      'product-form .shopify-payment-button',
      'form[action*="/cart/add"] button[name="add"]',
      'product-form button[name="add"]',
    ].join(', '));

    if (buyButtons) {
      return buyButtons.closest('form[action*="/cart/add"], product-form, .product-form') || buyButtons.parentElement;
    }

    return document.querySelector([
      '.product__info-container',
      '.product__info-wrapper',
      '.product__column-sticky',
      '.product-form',
      'product-form',
      'form[action*="/cart/add"]',
    ].join(', '));
  }

  function ensureAutoProductRoot() {
    if (manualProductRoots.length) {
      return null;
    }

    const productId = currentProductId();
    const mount = findProductNoticeMount();

    if (!productId || !mount) {
      return null;
    }

    if (autoProductRoot && autoProductRoot.isConnected) {
      autoProductRoot.dataset.productId = productId;
      autoProductRoot.dataset.variantId = currentVariantId() || '';
      return autoProductRoot;
    }

    autoProductRoot = document.createElement('div');
    autoProductRoot.setAttribute('data-limitpro-product-notice', '');
    autoProductRoot.dataset.shop = shopDomain();
    autoProductRoot.dataset.apiBase = apiBase();
    autoProductRoot.dataset.productId = productId;
    autoProductRoot.dataset.variantId = currentVariantId() || '';

    mount.insertAdjacentElement('afterend', autoProductRoot);
    return autoProductRoot;
  }

  function productNoticeRoots() {
    const roots = [...manualProductRoots];
    const autoRoot = ensureAutoProductRoot();

    if (autoRoot) {
      roots.push(autoRoot);
    }

    return roots;
  }

  async function fetchProductRules() {
    const productId = currentProductId();
    if (!productId) {
      return [];
    }

    const variantId = currentVariantId() || '';
    const cacheKey = `${shopDomain()}::${productId}::${variantId}`;
    if (productRuleCacheKey === cacheKey) {
      return productRuleCache;
    }

    const params = new URLSearchParams({
      shop: shopDomain(),
      productId,
    });

    if (variantId) {
      params.set('variantId', variantId);
    }

    const result = await fetchJson(buildApiUrl(apiBase(), `api/storefront/product-rules?${params.toString()}`));
    productRuleCacheKey = cacheKey;
    productRuleCache = Array.isArray(result.rules) ? result.rules : [];
    return productRuleCache;
  }

  function evaluateRuleMessages(rules, quantity) {
    const messages = [];

    for (const rule of rules) {
      if (rule.minQuantity && quantity < rule.minQuantity) {
        messages.push(rule.message || `Minimum quantity is ${rule.minQuantity}`);
      }

      if (rule.maxQuantity && quantity > rule.maxQuantity) {
        messages.push(rule.message || `Maximum quantity is ${rule.maxQuantity}`);
      }
    }

    return Array.from(new Set(messages));
  }

  async function renderProductWarnings() {
    const roots = productNoticeRoots();

    if (!roots.length) {
      return;
    }

    const productId = currentProductId();
    if (!productId) {
      roots.forEach((root) => renderWarningHost(root, []));
      return;
    }

    try {
      const rules = await fetchProductRules();
      const messages = evaluateRuleMessages(rules, currentProductQuantity());

      roots.forEach((root) => {
        root.dataset.productId = productId;
        root.dataset.variantId = currentVariantId() || '';
        renderWarningHost(root, messages);
      });
    } catch (error) {
      console.error('limitpro product warning failed:', error);
      roots.forEach((root) => renderWarningHost(root, []));
    }
  }

  function cartQuantityInputs() {
    const seen = new Set();
    const inputs = Array.from(document.querySelectorAll([
      'input[name="updates[]"]',
      'cart-items .quantity__input',
      'cart-drawer-items .quantity__input',
      '.cart-drawer .quantity__input',
      '.ajaxcart input[name="updates[]"]',
      '.mini-cart input[name="updates[]"]',
    ].join(', ')));

    return inputs.filter((input) => {
      if (!input || seen.has(input)) {
        return false;
      }

      const inCartUi = input.closest([
        'form[action*="/cart"]',
        'cart-items',
        'cart-drawer-items',
        '.cart-drawer',
        '.drawer',
        '.ajaxcart',
        '.mini-cart',
      ].join(', '));

      if (!inCartUi) {
        return false;
      }

      seen.add(input);
      return true;
    });
  }

  function cartWarningAnchor(input) {
    return input.closest([
      '.quantity',
      '.quantity-popover-container',
      '.cart-item__quantity',
      '.cart-drawer__quantity-selector',
      '.cart-item',
      'li',
      'tr',
    ].join(', ')) || input.parentElement || input;
  }

  function ensureHostAfter(anchor, attributeName) {
    if (!anchor) {
      return null;
    }

    let host = anchor.nextElementSibling;
    if (host && host.hasAttribute(attributeName)) {
      return host;
    }

    host = document.createElement('div');
    host.setAttribute(attributeName, '');
    anchor.insertAdjacentElement('afterend', host);
    return host;
  }

  function findCartFooterMount() {
    const checkoutTarget = checkoutTargets()[0];
    if (!checkoutTarget) {
      return null;
    }

    return checkoutTarget.closest([
      '.cart__footer',
      '.cart-drawer__footer',
      '.drawer__footer',
      '.ajaxcart__footer',
      '.mini-cart__footer',
      'form[action*="/cart"]',
    ].join(', ')) || checkoutTarget.parentElement;
  }

  function ensureCartFooterRoot() {
    const mount = findCartFooterMount();
    if (!mount) {
      if (cartFooterRoot && !cartFooterRoot.isConnected) {
        cartFooterRoot = null;
      }
      return null;
    }

    if (cartFooterRoot && cartFooterRoot.isConnected) {
      return cartFooterRoot;
    }

    cartFooterRoot = document.createElement('div');
    cartFooterRoot.setAttribute('data-limitpro-cart-footer-warning', '');
    mount.prepend(cartFooterRoot);
    return cartFooterRoot;
  }

  function renderCartWarnings() {
    if (!cartRoot) {
      return;
    }

    const itemMessages = new Map();
    const cartMessages = [];

    for (const violation of state.violations || []) {
      if (Number.isInteger(violation.itemIndex)) {
        if (!itemMessages.has(violation.itemIndex)) {
          itemMessages.set(violation.itemIndex, []);
        }
        itemMessages.get(violation.itemIndex).push(violation.message);
      } else {
        cartMessages.push(violation.message);
      }
    }

    const activeHosts = new Set();
    cartQuantityInputs().forEach((input, index) => {
      const host = ensureHostAfter(cartWarningAnchor(input), 'data-limitpro-cart-item-warning');
      activeHosts.add(host);
      renderWarningHost(host, Array.from(new Set(itemMessages.get(index) || [])));
    });

    document.querySelectorAll('[data-limitpro-cart-item-warning]').forEach((host) => {
      if (!activeHosts.has(host)) {
        renderWarningHost(host, []);
      }
    });

    renderWarningHost(ensureCartFooterRoot(), Array.from(new Set(cartMessages)));
  }

  async function validateCart() {
    if (!cartRoot) {
      return;
    }

    pendingCartValidation = null;

    try {
      const cart = await fetchCart();
      const payload = {
        shop: shopDomain(),
        items: (cart.items || []).map((item) => ({
          title: item.product_title || item.title,
          quantity: item.quantity,
          product_id: item.product_id,
          variant_id: item.variant_id,
        })),
      };

      const result = await fetchJson(buildApiUrl(apiBase(), 'api/validate-cart'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      state.violations = Array.isArray(result.violations) ? result.violations : [];
      state.invalid = !result.valid;
      state.blockCheckout = Boolean(result.blockCheckout);

      applyCheckoutState();
      renderCartWarnings();
      renderProductWarnings();
    } catch (error) {
      console.error('limitpro cart validation failed:', error);
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

  function clearProductRuleCache() {
    productRuleCacheKey = null;
    productRuleCache = [];
  }

  function initProductListeners() {
    document.addEventListener('input', (event) => {
      if (event.target.matches('form[action*="/cart/add"] input[name="quantity"], product-form input[name="quantity"], input[name="quantity"][form]')) {
        renderProductWarnings();
      }
    }, true);

    document.addEventListener('change', (event) => {
      if (event.target.matches('form[action*="/cart/add"] [name="id"], product-form [name="id"], select[name="id"]')) {
        clearProductRuleCache();
        renderProductWarnings();
      }
    }, true);

    document.addEventListener('click', (event) => {
      if (event.target.closest('form[action*="/cart/add"] .quantity__button, product-form .quantity__button, form[action*="/cart/add"] button[name="plus"], form[action*="/cart/add"] button[name="minus"]')) {
        window.setTimeout(renderProductWarnings, 0);
      }
    }, true);
  }

  function initCartListeners() {
    if (!cartRoot) {
      return;
    }

    patchCartRequests();
    validateCart();

    window.addEventListener('pageshow', scheduleCartValidation);
    window.addEventListener('focus', scheduleCartValidation);
    window.addEventListener('load', scheduleCartValidation);

    document.addEventListener('change', (event) => {
      if (event.target.closest('form[action*="/cart"]')) {
        scheduleCartValidation();
      }
    }, true);

    document.addEventListener('submit', (event) => {
      if (event.target.matches('form[action*="/cart"]')) {
        scheduleCartValidation();
      }
    }, true);

    document.addEventListener('click', (event) => {
      if (event.target.closest('.cart-drawer .quantity__button, cart-drawer-items .quantity__button, form[action*="/cart"] .quantity__button')) {
        window.setTimeout(scheduleCartValidation, 0);
      }
    }, true);

    document.addEventListener('click', (event) => {
      if (!state.invalid || !state.blockCheckout) {
        return;
      }

      const checkoutElement = event.target.closest('a[href*="/checkout"], button[name="checkout"], input[name="checkout"], .shopify-payment-button__button');
      if (!checkoutElement) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      renderCartWarnings();

      const target = document.querySelector('[data-limitpro-cart-item-warning]:not([hidden])')
        || document.querySelector('[data-limitpro-cart-footer-warning]:not([hidden])');

      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, true);
  }

  let pendingUiRefresh = false;
  const observer = new MutationObserver(() => {
    if (pendingUiRefresh) {
      return;
    }

    pendingUiRefresh = true;
    window.requestAnimationFrame(() => {
      pendingUiRefresh = false;
      renderProductWarnings();
      renderCartWarnings();
      applyCheckoutState();
    });
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  initProductListeners();
  initCartListeners();
  renderProductWarnings();
})();
