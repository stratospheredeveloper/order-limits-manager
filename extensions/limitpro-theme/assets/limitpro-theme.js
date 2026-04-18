(function () {
  function manualProductNoticeRoots() {
    return Array.from(document.querySelectorAll('[data-limitpro-product-notice]')).filter((root) => root.isConnected);
  }

  function currentCartRoot() {
    return document.querySelector('[data-limitpro-cart-validator]');
  }

  function currentPrimaryRoot() {
    return currentCartRoot() || manualProductNoticeRoots()[0] || null;
  }

  if (!currentPrimaryRoot()) {
    return;
  }

  const state = window.__limitproThemeState || {
    invalid: false,
    blockCheckout: false,
    violations: [],
  };
  window.__limitproThemeState = state;

  let cartFooterRoot = null;
  let pendingCartValidation = null;
  let rerunCartValidation = false;
  let productRuleCacheKey = null;
  let productRuleCache = [];
  let pendingProductWarningRefresh = null;
  let productStateWatchId = null;
  let lastProductStateSignature = '';

  const productFormSelectors = [
    'product-form',
    'form[action*="/cart/add"]',
    '.product-form',
  ];

  const productVariantFieldSelectors = [
    '[name="id"]',
    'select[name="id"]',
    'input[name="id"][form]',
  ];

  const productQuantityFieldSelectors = [
    'input[name="quantity"]',
    '.quantity__input',
    'quantity-input input[type="number"]',
    'input[type="number"][name*="quantity"]',
  ];

  const productContextSelectors = [
    '.product__info-container',
    '.product__info-wrapper',
    '.product__column-sticky',
    '.product',
    '.featured-product',
    '.shopify-section',
    'main',
  ];

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
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error('Failed to load cart');
    }

    return response.json();
  }

  function shopDomain() {
    return currentPrimaryRoot()?.dataset.shop || '';
  }

  function apiBase() {
    return currentPrimaryRoot()?.dataset.apiBase || window.location.origin;
  }

  function isVisibleElement(element) {
    return Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  }

  function firstActiveElement(selectors) {
    const candidates = Array.from(document.querySelectorAll(selectors.join(', ')));
    return candidates.find(isVisibleElement) || candidates[0] || null;
  }

  function firstActiveElementWithin(root, selectors) {
    if (!root) {
      return null;
    }

    const candidates = Array.from(root.querySelectorAll(selectors.join(', ')));
    return candidates.find(isVisibleElement) || candidates[0] || null;
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements.filter(Boolean)));
  }

  function warningMarkup(messages, options = {}) {
    const placeholderClass = options.placeholder ? ' limitpro-warning--placeholder' : '';

    return `
      <div class="limitpro-warning${placeholderClass}" role="status" aria-live="polite">
        ${messages.map((message) => `<p class="limitpro-warning__message">${escapeHtml(message)}</p>`).join('')}
      </div>
    `;
  }

  function renderWarningHost(host, messages, options = {}) {
    if (!host) {
      return;
    }

    if (!messages.length) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }

    host.hidden = false;
    host.innerHTML = warningMarkup(messages, options);
  }

  function isThemeEditor() {
    return Boolean(window.Shopify && window.Shopify.designMode);
  }

  function shouldShowProductPlaceholder(root) {
    return root?.dataset.showPlaceholder === 'true' && isThemeEditor();
  }

  function renderProductNoticeHost(root, messages) {
    if (messages.length) {
      renderWarningHost(root, messages);
      return;
    }

    if (shouldShowProductPlaceholder(root)) {
      renderWarningHost(
        root,
        ['limitpro will show the rule description here when the selected quantity violates a rule.'],
        { placeholder: true }
      );
      return;
    }

    renderWarningHost(root, []);
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

  function currentProductId(root = null) {
    const activeCartRoot = currentCartRoot();
    const productRoots = manualProductNoticeRoots();
    return root?.dataset.productId
      || activeCartRoot?.dataset.productId
      || productRoots[0]?.dataset.productId
      || window?.ShopifyAnalytics?.meta?.product?.id?.toString()
      || window?.meta?.product?.id?.toString()
      || null;
  }

  function activeProductForm() {
    const addButton = firstActiveElement([
      'form[action*="/cart/add"] button[name="add"]',
      'product-form button[name="add"]',
      'form[action*="/cart/add"] button[type="submit"]',
      'product-form button[type="submit"]',
      '.product-form button[name="add"]',
      '.product-form button[type="submit"]',
    ]);

    if (addButton) {
      return addButton.closest(productFormSelectors.join(', '));
    }

    return firstActiveElement(productFormSelectors);
  }

  function productContexts(root = null) {
    const form = activeProductForm();
    const mount = findProductNoticeMount();
    const rootContext = root?.closest(productContextSelectors.join(', '));
    const formContext = form?.closest(productContextSelectors.join(', '));
    const mountContext = mount?.closest(productContextSelectors.join(', '));

    return uniqueElements([
      root,
      form,
      mount,
      rootContext,
      formContext,
      mountContext,
      firstActiveElement(productContextSelectors),
    ]);
  }

  function findProductField(root, selectors, fallbackSelectors = selectors) {
    for (const context of productContexts(root)) {
      const field = firstActiveElementWithin(context, selectors);
      if (field) {
        return field;
      }
    }

    return firstActiveElement(fallbackSelectors);
  }

  function currentVariantId(root = null) {
    const variantInput = findProductField(root, productVariantFieldSelectors, [
      'form[action*="/cart/add"] [name="id"]',
      'product-form [name="id"]',
      'input[name="id"][form]',
      'select[name="id"]',
    ]);

    const activeCartRoot = currentCartRoot();
    const productRoots = manualProductNoticeRoots();
    return variantInput?.value || root?.dataset.variantId || activeCartRoot?.dataset.variantId || productRoots[0]?.dataset.variantId || null;
  }

  function currentProductQuantity(root = null) {
    const quantityInput = findProductField(root, productQuantityFieldSelectors, [
      'form[action*="/cart/add"] input[name="quantity"]',
      'form[action*="/cart/add"] .quantity__input',
      'product-form input[name="quantity"]',
      'product-form .quantity__input',
      'input[name="quantity"][form]',
    ]);

    return Math.max(1, Number(quantityInput?.value) || 1);
  }

  function scheduleProductWarningRefresh(runImmediately = false) {
    if (runImmediately) {
      renderProductWarnings();
    }

    if (pendingProductWarningRefresh) {
      window.clearTimeout(pendingProductWarningRefresh);
    }

    pendingProductWarningRefresh = window.setTimeout(() => {
      pendingProductWarningRefresh = null;
      renderProductWarnings();
    }, 140);
  }

  function productStateSignature() {
    const roots = productNoticeRoots();
    if (!roots.length) {
      return '';
    }

    return roots.map((root) => [
      currentProductId(root) || '',
      currentVariantId(root) || '',
      currentProductQuantity(root),
    ].join('::')).join('|');
  }

  function startProductStateWatch() {
    if (productStateWatchId) {
      return;
    }

    lastProductStateSignature = productStateSignature();

    productStateWatchId = window.setInterval(() => {
      const nextSignature = productStateSignature();
      if (nextSignature === lastProductStateSignature) {
        return;
      }

      lastProductStateSignature = nextSignature;
      renderProductWarnings();
    }, 250);
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

  function productNoticeRoots() {
    return manualProductNoticeRoots();
  }

  async function fetchProductRules(productId = currentProductId(), variantId = currentVariantId()) {
    if (!productId) {
      return [];
    }

    const normalizedVariantId = variantId || '';
    const cacheKey = `${shopDomain()}::${productId}::${normalizedVariantId}`;
    if (productRuleCacheKey === cacheKey) {
      return productRuleCache;
    }

    const params = new URLSearchParams({
      shop: shopDomain(),
      productId,
    });

    if (normalizedVariantId) {
      params.set('variantId', normalizedVariantId);
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

    const contexts = roots.map((root) => ({
      root,
      productId: currentProductId(root),
      variantId: currentVariantId(root) || '',
      quantity: currentProductQuantity(root),
    }));

    if (!contexts.some((context) => context.productId)) {
      roots.forEach((root) => renderProductNoticeHost(root, []));
      return;
    }

    try {
      const rulesByTarget = new Map();

      for (const context of contexts) {
        if (!context.productId) {
          continue;
        }

        const cacheKey = `${context.productId}::${context.variantId}`;
        if (!rulesByTarget.has(cacheKey)) {
          rulesByTarget.set(cacheKey, await fetchProductRules(context.productId, context.variantId));
        }
      }

      contexts.forEach((context) => {
        const rules = context.productId ? (rulesByTarget.get(`${context.productId}::${context.variantId}`) || []) : [];
        const messages = evaluateRuleMessages(rules, context.quantity);

        context.root.dataset.productId = context.productId || '';
        context.root.dataset.variantId = context.variantId;
        renderProductNoticeHost(context.root, messages);
      });
    } catch (error) {
      console.error('limitpro product warning failed:', error);
      roots.forEach((root) => renderProductNoticeHost(root, []));
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
    let anchor = input.closest([
      '.quantity',
      '.quantity-popover-container',
      '.cart-item__quantity-wrapper',
      '.cart-item__quantity',
      '.cart-drawer__quantity-selector',
      '.cart-item',
      'li',
      'tr',
    ].join(', ')) || input.parentElement || input;

    while (anchor.parentElement) {
      const parent = anchor.parentElement;
      const parentStyle = window.getComputedStyle(parent);
      const isHorizontalFlex = parentStyle.display === 'flex' && !parentStyle.flexDirection.startsWith('column');

      if (!isHorizontalFlex) {
        break;
      }

      anchor = parent;
    }

    return anchor;
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
    if (!currentCartRoot()) {
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
    if (!currentCartRoot()) {
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
    if (!currentCartRoot()) {
      return;
    }

    if (pendingCartValidation) {
      rerunCartValidation = true;
      return;
    }

    pendingCartValidation = window.setTimeout(validateCart, 180);
  }

  function patchCartRequests() {
    if (window.__limitproCartPatched || !currentCartRoot()) {
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
      if (event.target.matches('form[action*="/cart/add"] input[name="quantity"], form[action*="/cart/add"] .quantity__input, product-form input[name="quantity"], product-form .quantity__input, input[name="quantity"][form]')) {
        scheduleProductWarningRefresh(true);
      }
    }, true);

    document.addEventListener('change', (event) => {
      if (event.target.matches('form[action*="/cart/add"] [name="id"], product-form [name="id"], select[name="id"]')) {
        clearProductRuleCache();
        scheduleProductWarningRefresh(true);
      }

      if (event.target.matches('form[action*="/cart/add"] input[name="quantity"], form[action*="/cart/add"] .quantity__input, product-form input[name="quantity"], product-form .quantity__input, input[name="quantity"][form]')) {
        scheduleProductWarningRefresh(true);
      }
    }, true);

    document.addEventListener('click', (event) => {
      if (event.target.closest('form[action*="/cart/add"] .quantity__button, product-form .quantity__button, form[action*="/cart/add"] button[name="plus"], form[action*="/cart/add"] button[name="minus"], quantity-input button')) {
        scheduleProductWarningRefresh();
      }
    }, true);
  }

  function initCartListeners() {
    if (!currentCartRoot()) {
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

    document.addEventListener('input', (event) => {
      if (event.target.matches('input[name="updates[]"], cart-items .quantity__input, cart-drawer-items .quantity__input, .cart-drawer .quantity__input')) {
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
  startProductStateWatch();
})();
