import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Session } from '@shopify/shopify-api';
import shopify from './shopify.js';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOP_POLICY_CACHE_TTL_MS = Number(process.env.SHOP_POLICY_CACHE_TTL_MS || 15000);
const SHOPIFY_CALLBACK_PATH = '/api/auth/callback';
const THEME_EMBED_HANDLE = 'cart-validator';
const THEME_BLOCK_HANDLE = 'product-limit-notice';
const DEFAULT_APP_URL = 'https://order-limits-manager-production.up.railway.app';
const shopPolicyCache = new Map();

function resolvePublicAppUrl(rawValue) {
  const candidate = typeof rawValue === 'string' ? rawValue.trim() : '';
  const match = candidate.match(/https?:\/\/[^\s]+/);
  const normalized = (match ? match[0] : DEFAULT_APP_URL).replace(/\/$/, '');

  try {
    return new URL(normalized).toString().replace(/\/$/, '');
  } catch (error) {
    console.warn(`Invalid SHOPIFY_APP_URL value "${candidate}". Falling back to ${DEFAULT_APP_URL}.`);
    return DEFAULT_APP_URL;
  }
}

const PUBLIC_APP_URL = resolvePublicAppUrl(process.env.SHOPIFY_APP_URL);

const SEARCH_PRODUCTS_QUERY = `
  query LimitProProductSearch($query: String!) {
    products(first: 12, query: $query) {
      nodes {
        id
        title
        featuredImage {
          url
        }
        variants(first: 20) {
          nodes {
            id
            title
            displayName
            image {
              url
            }
          }
        }
      }
    }
  }
`;

const PRODUCT_CATALOG_QUERY = `
  query LimitProProductCatalog($after: String) {
    products(first: 100, after: $after, sortKey: TITLE) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        featuredImage {
          url
        }
        variants(first: 100) {
          nodes {
            id
            title
            displayName
          }
        }
      }
    }
  }
`;

const THEME_SETUP_QUERY = `
  query LimitProThemeSetup {
    themes(first: 20) {
      nodes {
        id
        name
        role
      }
    }
  }
`;

function invalidateShopPolicyCache(shopId) {
  if (shopId) {
    shopPolicyCache.delete(shopId);
  }
}

function buildRuleBuckets(rules) {
  const productRules = new Map();
  const variantRules = new Map();
  const cartRules = [];

  for (const rule of rules) {
    if (rule.ruleType === 'product' && rule.targetId) {
      for (const key of normalizeRuleTargetIds(rule.targetId)) {
        if (!productRules.has(key)) productRules.set(key, []);
        productRules.get(key).push(rule);
      }
      continue;
    }

    if (rule.ruleType === 'variant' && rule.targetId) {
      for (const key of normalizeRuleTargetIds(rule.targetId)) {
        if (!variantRules.has(key)) variantRules.set(key, []);
        variantRules.get(key).push(rule);
      }
      continue;
    }

    if (rule.ruleType === 'cart') {
      cartRules.push(rule);
    }
  }

  return { productRules, variantRules, cartRules };
}

async function getShopPolicy(shop) {
  const now = Date.now();
  const cached = shopPolicyCache.get(shop);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const [rules, settings] = await Promise.all([
    prisma.rule.findMany({
      where: {
        shopId: shop,
        enabled: true,
      },
      select: {
        id: true,
        ruleType: true,
        targetId: true,
        minQuantity: true,
        maxQuantity: true,
        message: true,
      },
    }),
    prisma.settings.findUnique({
      where: { shopId: shop },
      select: {
        globalMinCart: true,
        globalMaxCart: true,
        showCartWarning: true,
        blockCheckout: true,
      },
    }),
  ]);

  const data = {
    settings,
    ...buildRuleBuckets(rules),
  };

  shopPolicyCache.set(shop, {
    expiresAt: now + SHOP_POLICY_CACHE_TTL_MS,
    data,
  });

  return data;
}

function sanitizeShop(shop, throwOnInvalid = false) {
  if (!shop || typeof shop !== 'string') return null;

  try {
    return shopify.utils.sanitizeShop(shop, throwOnInvalid);
  } catch (error) {
    if (throwOnInvalid) {
      throw error;
    }

    return null;
  }
}

function extractNumericId(gid) {
  if (!gid || typeof gid !== 'string') return null;
  return gid.split('/').pop() || null;
}

function normalizeRuleTargetIds(value) {
  const rawValue = value?.toString().trim();
  if (!rawValue) return [];

  const ids = new Set([rawValue]);
  const numericId = extractNumericId(rawValue);

  if (numericId) {
    ids.add(numericId);
  }

  return Array.from(ids);
}

function setResponseHeaders(res, headers = {}) {
  Object.entries(headers).forEach(([header, value]) => {
    if (value !== undefined) {
      res.setHeader(header, value);
    }
  });
}

async function getOfflineSession(shop) {
  const normalizedShop = sanitizeShop(shop);
  if (!normalizedShop) return null;

  const shopRecord = await prisma.shop.findUnique({
    where: { id: normalizedShop },
    select: {
      id: true,
      accessToken: true,
      grantedScopes: true,
    },
  });

  if (!shopRecord?.accessToken) {
    return null;
  }

  return new Session({
    id: shopify.session.getOfflineId(shopRecord.id),
    shop: shopRecord.id,
    state: 'offline',
    isOnline: false,
    scope: shopRecord.grantedScopes || shopify.config.scopes.toString(),
    accessToken: shopRecord.accessToken,
  });
}

async function runAdminQuery(session, query, variables = {}) {
  const client = new shopify.clients.Graphql({ session });
  const response = await client.query({
    data: { query, variables },
  });
  const payload = response.body;

  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join(', '));
  }

  return payload?.data || {};
}

function buildThemeSetupLinks(shop, themeNumericId = 'current') {
  const editorTarget = themeNumericId || 'current';
  const embedBase = `https://${shop}/admin/themes/${editorTarget}/editor`;
  const apiKey = process.env.SHOPIFY_API_KEY || shopify.config.apiKey;

  return {
    auth: `/api/auth?shop=${encodeURIComponent(shop)}`,
    embed: `${embedBase}?context=apps&template=product&activateAppId=${encodeURIComponent(`${apiKey}/${THEME_EMBED_HANDLE}`)}`,
    block: `${embedBase}?template=product&addAppBlockId=${encodeURIComponent(`${apiKey}/${THEME_BLOCK_HANDLE}`)}&target=mainSection`,
    themeEditor: `${embedBase}`,
    storefront: `https://${shop}`,
    cart: `https://${shop}/cart`,
  };
}

function buildProductSearchResults(products, ruleType, rawQuery) {
  const normalizedQuery = rawQuery.trim().toLowerCase();

  if (ruleType === 'variant') {
    return products
      .flatMap((product) => {
        const productId = extractNumericId(product.id);
        const productImage = product.featuredImage?.url || null;

        return (product.variants?.nodes || [])
          .filter((variant) => {
            const label = `${product.title} ${variant.displayName || variant.title || ''}`.toLowerCase();
            return label.includes(normalizedQuery);
          })
          .map((variant) => {
            const variantTitle = variant.displayName || variant.title || 'Default variant';
            const title = variantTitle === 'Default Title'
              ? product.title
              : `${product.title} - ${variantTitle}`;

            return {
              id: extractNumericId(variant.id),
              title,
              subtitle: `Product ID: ${productId}`,
              image: variant.image?.url || productImage,
            };
          });
      })
      .slice(0, 12);
  }

  return products.map((product) => ({
    id: extractNumericId(product.id),
    title: product.title,
    image: product.featuredImage?.url || null,
  }));
}

function aggregateProductRuleSummary(rules) {
  const minQuantity = rules
    .map((rule) => rule.minQuantity)
    .filter((value) => Number.isInteger(value))
    .reduce((highest, current) => Math.max(highest, current), 0);
  const maxValues = rules
    .map((rule) => rule.maxQuantity)
    .filter((value) => Number.isInteger(value));
  const maxQuantity = maxValues.length > 0 ? Math.min(...maxValues) : null;
  const messages = rules
    .map((rule) => rule.message)
    .filter(Boolean);

  return {
    hasRules: rules.length > 0,
    minQuantity: minQuantity || null,
    maxQuantity,
    message: messages[0] || null,
  };
}

function buildCatalogEntries(products, ruleType) {
  if (ruleType === 'variant') {
    return products.flatMap((product) => (
      (product.variants?.nodes || []).map((variant) => {
        const variantTitle = variant.displayName || variant.title || 'Default variant';
        const title = variantTitle === 'Default Title'
          ? product.title
          : `${product.title} - ${variantTitle}`;

        return {
          id: extractNumericId(variant.id),
          title,
        };
      })
    ));
  }

  return products.map((product) => ({
    id: extractNumericId(product.id),
    title: product.title,
  }));
}

async function loadCatalogProducts(session, maxProducts = 250) {
  const products = [];
  let after = null;

  while (products.length < maxProducts) {
    const data = await runAdminQuery(session, PRODUCT_CATALOG_QUERY, { after });
    const connection = data.products;
    const nodes = connection?.nodes || [];

    products.push(...nodes);

    if (!connection?.pageInfo?.hasNextPage || !connection?.pageInfo?.endCursor) {
      break;
    }

    after = connection.pageInfo.endCursor;
  }

  return products.slice(0, maxProducts);
}

// Middleware
app.use(cors({
  origin: '*',
  credentials: true,
}));
app.use(express.json());
app.use(express.static('public'));

// Auth: begin OAuth
app.get('/api/auth', async (req, res) => {
  const shop = sanitizeShop(req.query.shop, false);

  if (!shop) {
    return res.status(400).send('Missing or invalid shop parameter');
  }

  try {
    await shopify.auth.begin({
      rawRequest: req,
      rawResponse: res,
      shop,
      callbackPath: SHOPIFY_CALLBACK_PATH,
      isOnline: false,
    });
  } catch (error) {
    console.error('Error starting Shopify auth:', error);
    res.status(500).send('Unable to start Shopify authentication');
  }
});

// Auth: callback
app.get(SHOPIFY_CALLBACK_PATH, async (req, res) => {
  try {
    const { session, headers } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    setResponseHeaders(res, headers);

    await prisma.shop.upsert({
      where: { id: session.shop },
      update: {
        name: session.shop,
        accessToken: session.accessToken,
        grantedScopes: session.scope,
        installedAt: new Date(),
      },
      create: {
        id: session.shop,
        name: session.shop,
        accessToken: session.accessToken,
        grantedScopes: session.scope,
        installedAt: new Date(),
      },
    });

    const redirectParams = new URLSearchParams({
      shop: session.shop,
    });

    if (typeof req.query.host === 'string' && req.query.host) {
      redirectParams.set('host', req.query.host);
    }

    res.redirect(`/?${redirectParams.toString()}`);
  } catch (error) {
    console.error('Error completing Shopify auth:', error);
    res.status(500).send('Shopify authentication failed');
  }
});

// Simple health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Home route
app.get('/', async (req, res) => {
  try {
    const shop = sanitizeShop(req.query.shop, false);

    if (shop) {
      const shopRecord = await prisma.shop.findUnique({
        where: { id: shop },
        select: { accessToken: true },
      });

      if (!shopRecord?.accessToken) {
        return res.redirect(`/api/auth?shop=${encodeURIComponent(shop)}`);
      }
    }

    res.sendFile(path.join(__dirname, 'admin-dashboard-with-search.html'));
  } catch (error) {
    console.error('Error loading home page:', error);
    res.status(500).send('Failed to load app dashboard');
  }
});

// API: Get theme setup links and onboarding context
app.get('/api/theme/setup', async (req, res) => {
  const shop = sanitizeShop(req.query.shop, false);

  if (!shop) {
    return res.status(400).json({
      success: false,
      error: 'Missing or invalid shop parameter',
    });
  }

  const session = await getOfflineSession(shop);

  if (!session) {
    return res.status(401).json({
      success: false,
      error: 'Shop authentication required',
      authUrl: `/api/auth?shop=${encodeURIComponent(shop)}`,
    });
  }

  let theme = null;

  try {
    const data = await runAdminQuery(session, THEME_SETUP_QUERY);
    const liveTheme = (data.themes?.nodes || []).find((candidate) => candidate.role === 'MAIN');

    if (liveTheme) {
      theme = {
        id: liveTheme.id,
        numericId: extractNumericId(liveTheme.id),
        name: liveTheme.name,
        role: liveTheme.role,
      };
    }
  } catch (error) {
    console.error(`Error loading theme setup for ${shop}:`, error);
  }

  res.json({
    success: true,
    shop,
    theme,
    publicAppUrl: PUBLIC_APP_URL,
    links: buildThemeSetupLinks(shop, theme?.numericId || 'current'),
  });
});

// API: Search products/variants for admin dashboard
app.get('/api/products/search', async (req, res) => {
  try {
    const shop = sanitizeShop(req.query.shop, false);
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const ruleType = req.query.type === 'variant' ? 'variant' : 'product';

    if (!shop) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid shop parameter',
      });
    }

    if (query.length < 2) {
      return res.json({ success: true, products: [] });
    }

    const session = await getOfflineSession(shop);

    if (!session) {
      return res.status(401).json({
        success: false,
        error: 'Shop authentication required',
        authUrl: `/api/auth?shop=${encodeURIComponent(shop)}`,
      });
    }

    const data = await runAdminQuery(session, SEARCH_PRODUCTS_QUERY, {
      query,
    });

    const products = buildProductSearchResults(data.products?.nodes || [], ruleType, query);

    res.json({ success: true, products });
  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({ success: false, error: 'Failed to search products' });
  }
});

// API: Load product catalog for dropdowns
app.get('/api/products/catalog', async (req, res) => {
  try {
    const shop = sanitizeShop(req.query.shop, false);
    const ruleType = req.query.type === 'variant' ? 'variant' : 'product';

    if (!shop) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid shop parameter',
      });
    }

    const session = await getOfflineSession(shop);

    if (!session) {
      return res.status(401).json({
        success: false,
        error: 'Shop authentication required',
        authUrl: `/api/auth?shop=${encodeURIComponent(shop)}`,
      });
    }

    const products = await loadCatalogProducts(session);

    res.json({
      success: true,
      products: buildCatalogEntries(products, ruleType),
    });
  } catch (error) {
    console.error('Error loading product catalog:', error);
    res.status(500).json({ success: false, error: 'Failed to load product catalog' });
  }
});

// API: Get all rules for a shop
app.get('/api/rules', async (req, res) => {
  try {
    const shop = req.query.shop || 'test-shop';

    const rules = await prisma.rule.findMany({
      where: { shopId: shop },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, rules });
  } catch (error) {
    console.error('Error fetching rules:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch rules' });
  }
});

// API: Create a new rule
app.post('/api/rules', async (req, res) => {
  try {
    const shop = req.body.shop || 'test-shop';
    const { ruleType, targetId, targetTitle, minQuantity, maxQuantity, message } = req.body;

    await prisma.shop.upsert({
      where: { id: shop },
      update: {},
      create: { id: shop, name: shop },
    });

    const rule = await prisma.rule.create({
      data: {
        shopId: shop,
        ruleType,
        targetId,
        targetTitle,
        minQuantity: minQuantity ? parseInt(minQuantity, 10) : null,
        maxQuantity: maxQuantity ? parseInt(maxQuantity, 10) : null,
        message,
        enabled: true,
      },
    });
    invalidateShopPolicyCache(shop);

    res.json({ success: true, rule });
  } catch (error) {
    console.error('Error creating rule:', error);
    res.status(500).json({ success: false, error: 'Failed to create rule' });
  }
});

// API: Update a rule
app.put('/api/rules/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { minQuantity, maxQuantity, enabled, message } = req.body;

    const rule = await prisma.rule.update({
      where: { id },
      data: {
        minQuantity: minQuantity ? parseInt(minQuantity, 10) : null,
        maxQuantity: maxQuantity ? parseInt(maxQuantity, 10) : null,
        enabled,
        message,
      },
      select: {
        id: true,
        shopId: true,
        minQuantity: true,
        maxQuantity: true,
        enabled: true,
        message: true,
      },
    });
    invalidateShopPolicyCache(rule.shopId);

    res.json({ success: true, rule });
  } catch (error) {
    console.error('Error updating rule:', error);
    res.status(500).json({ success: false, error: 'Failed to update rule' });
  }
});

// API: Delete a rule
app.delete('/api/rules/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const deletedRule = await prisma.rule.delete({
      where: { id },
      select: { shopId: true },
    });
    invalidateShopPolicyCache(deletedRule.shopId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting rule:', error);
    res.status(500).json({ success: false, error: 'Failed to delete rule' });
  }
});

// API: Get settings
app.get('/api/settings', async (req, res) => {
  try {
    const shop = req.query.shop || 'test-shop';

    await prisma.shop.upsert({
      where: { id: shop },
      update: {},
      create: { id: shop, name: shop },
    });

    let settings = await prisma.settings.findUnique({
      where: { shopId: shop },
    });

    if (!settings) {
      settings = await prisma.settings.create({
        data: { shopId: shop },
      });
    }

    res.json({ success: true, settings });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

// API: Update settings
app.put('/api/settings', async (req, res) => {
  try {
    const shop = req.body.shop || 'test-shop';
    const {
      globalMinCart,
      globalMaxCart,
      showCartWarning,
      blockCheckout,
      customMessageEnabled,
    } = req.body;

    await prisma.shop.upsert({
      where: { id: shop },
      update: {},
      create: { id: shop, name: shop },
    });

    const settings = await prisma.settings.upsert({
      where: { shopId: shop },
      update: {
        globalMinCart: globalMinCart ? parseInt(globalMinCart, 10) : null,
        globalMaxCart: globalMaxCart ? parseInt(globalMaxCart, 10) : null,
        showCartWarning,
        blockCheckout,
        customMessageEnabled,
      },
      create: {
        shopId: shop,
        globalMinCart: globalMinCart ? parseInt(globalMinCart, 10) : null,
        globalMaxCart: globalMaxCart ? parseInt(globalMaxCart, 10) : null,
        showCartWarning,
        blockCheckout,
        customMessageEnabled,
      },
    });
    invalidateShopPolicyCache(shop);

    res.json({ success: true, settings });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

// API: Validate cart (called from storefront)
app.post('/api/validate-cart', async (req, res) => {
  try {
    const shop = sanitizeShop(req.body.shop, false);
    const items = Array.isArray(req.body.items) ? req.body.items : null;

    if (!shop || !items) {
      return res.status(400).json({
        success: false,
        error: 'Missing shop or items',
      });
    }

    const {
      productRules,
      variantRules,
      cartRules,
      settings,
    } = await getShopPolicy(shop);

    const violations = [];
    const normalizedItems = items.map((item) => ({
      ...item,
      quantity: Number(item.quantity) || 0,
      product_id: item.product_id?.toString() || null,
      variant_id: item.variant_id?.toString() || null,
    }));

    for (const [itemIndex, item] of normalizedItems.entries()) {
      const matchingRules = [];
      const seenRuleIds = new Set();

      for (const productKey of normalizeRuleTargetIds(item.product_id)) {
        if (!productRules.has(productKey)) continue;

        for (const rule of productRules.get(productKey)) {
          if (seenRuleIds.has(rule.id)) continue;
          seenRuleIds.add(rule.id);
          matchingRules.push(rule);
        }
      }

      for (const variantKey of normalizeRuleTargetIds(item.variant_id)) {
        if (!variantRules.has(variantKey)) continue;

        for (const rule of variantRules.get(variantKey)) {
          if (seenRuleIds.has(rule.id)) continue;
          seenRuleIds.add(rule.id);
          matchingRules.push(rule);
        }
      }

      for (const rule of matchingRules) {
        if (rule.minQuantity && item.quantity < rule.minQuantity) {
          violations.push({
            scope: 'item',
            type: 'min',
            item: item.title,
            itemIndex,
            productId: item.product_id,
            variantId: item.variant_id,
            limit: rule.minQuantity,
            current: item.quantity,
            message: rule.message || `Minimum quantity for ${item.title} is ${rule.minQuantity}`,
          });
        }

        if (rule.maxQuantity && item.quantity > rule.maxQuantity) {
          violations.push({
            scope: 'item',
            type: 'max',
            item: item.title,
            itemIndex,
            productId: item.product_id,
            variantId: item.variant_id,
            limit: rule.maxQuantity,
            current: item.quantity,
            message: rule.message || `Maximum quantity for ${item.title} is ${rule.maxQuantity}`,
          });
        }
      }
    }

    const totalQuantity = normalizedItems.reduce((sum, item) => sum + item.quantity, 0);

    for (const rule of cartRules) {
      if (rule.minQuantity && totalQuantity < rule.minQuantity) {
        violations.push({
          scope: 'cart',
          type: 'cart_min',
          limit: rule.minQuantity,
          current: totalQuantity,
          message: rule.message || `Minimum cart quantity is ${rule.minQuantity} items`,
        });
      }

      if (rule.maxQuantity && totalQuantity > rule.maxQuantity) {
        violations.push({
          scope: 'cart',
          type: 'cart_max',
          limit: rule.maxQuantity,
          current: totalQuantity,
          message: rule.message || `Maximum cart quantity is ${rule.maxQuantity} items`,
        });
      }
    }

    if (settings?.globalMinCart && totalQuantity < settings.globalMinCart) {
      violations.push({
        scope: 'cart',
        type: 'cart_min',
        limit: settings.globalMinCart,
        current: totalQuantity,
        message: `Minimum cart quantity is ${settings.globalMinCart} items`,
      });
    }

    if (settings?.globalMaxCart && totalQuantity > settings.globalMaxCart) {
      violations.push({
        scope: 'cart',
        type: 'cart_max',
        limit: settings.globalMaxCart,
        current: totalQuantity,
        message: `Maximum cart quantity is ${settings.globalMaxCart} items`,
      });
    }

    res.json({
      success: true,
      valid: violations.length === 0,
      violations,
      showCartWarning: settings?.showCartWarning ?? true,
      blockCheckout: settings?.blockCheckout ?? true,
    });
  } catch (error) {
    console.error('Error validating cart:', error);
    res.status(500).json({ success: false, error: 'Validation failed' });
  }
});

// API: Product rule summary for the theme app block
app.get('/api/storefront/product-rules', async (req, res) => {
  try {
    const shop = sanitizeShop(req.query.shop, false);
    const productId = req.query.productId?.toString();
    const variantId = req.query.variantId?.toString();

    if (!shop || !productId) {
      return res.status(400).json({
        success: false,
        error: 'Missing shop or productId',
      });
    }

    const ruleTargets = [
      {
        ruleType: 'product',
        targetId: {
          in: normalizeRuleTargetIds(productId),
        },
      },
    ];

    const normalizedVariantIds = normalizeRuleTargetIds(variantId);
    if (normalizedVariantIds.length > 0) {
      ruleTargets.push({
        ruleType: 'variant',
        targetId: {
          in: normalizedVariantIds,
        },
      });
    }

    const rules = await prisma.rule.findMany({
      where: {
        shopId: shop.toString(),
        enabled: true,
        OR: ruleTargets,
      },
      select: {
        id: true,
        ruleType: true,
        targetId: true,
        minQuantity: true,
        maxQuantity: true,
        message: true,
      },
    });

    res.json({
      success: true,
      ...aggregateProductRuleSummary(rules),
      rules: rules.map((rule) => ({
        id: rule.id,
        ruleType: rule.ruleType,
        targetId: rule.targetId,
        minQuantity: rule.minQuantity,
        maxQuantity: rule.maxQuantity,
        message: rule.message || null,
      })),
    });
  } catch (error) {
    console.error('Error loading product rule summary:', error);
    res.status(500).json({ success: false, error: 'Failed to load product rules' });
  }
});

// ===== MANDATORY COMPLIANCE WEBHOOKS =====

function verifyWebhook(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const body = JSON.stringify(req.body);
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(body, 'utf8')
    .digest('base64');

  return hmac === hash;
}

app.post('/webhooks/customers/data_request', express.json(), (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).send('Unauthorized');
  }

  console.log('Customer data request:', req.body);
  res.status(200).send('OK');
});

app.post('/webhooks/customers/redact', express.json(), (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).send('Unauthorized');
  }

  console.log('Customer redact request:', req.body);
  res.status(200).send('OK');
});

app.post('/webhooks/shop/redact', express.json(), (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).send('Unauthorized');
  }

  const shopId = req.body.shop_domain;
  console.log('Shop redact request:', shopId);

  prisma.rule.deleteMany({ where: { shopId } })
    .then(() => prisma.settings.deleteMany({ where: { shopId } }))
    .then(() => prisma.shop.deleteMany({ where: { id: shopId } }))
    .then(() => {
      invalidateShopPolicyCache(shopId);
      res.status(200).send('OK');
    })
    .catch((error) => {
      console.error('Error deleting shop data:', error);
      res.status(500).send('Error');
    });
});

// ===== END COMPLIANCE WEBHOOKS =====

async function initializeDatabase() {
  try {
    await prisma.$connect();
    console.log('✅ Database connected');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    console.log('Run: npx prisma migrate dev');
  }
}

app.listen(PORT, async () => {
  await initializeDatabase();
  console.log(`
╔════════════════════════════════════════╗
║   Order Limits Manager - Running      ║
╚════════════════════════════════════════╝

🚀 Server:    http://localhost:${PORT}
💾 Database:  Connected
📊 API:       Ready

Next steps:
1. Set up ngrok: ngrok http ${PORT}
2. Update Shopify Partner Dashboard with ngrok URL
3. Install on development store
  `);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
