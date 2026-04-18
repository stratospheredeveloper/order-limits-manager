import { shopifyApi, LATEST_API_VERSION } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

const DEFAULT_APP_URL = 'https://order-limits-manager-production.up.railway.app';

function resolveAppUrl(rawValue) {
  const candidate = typeof rawValue === 'string' ? rawValue.trim() : '';
  const match = candidate.match(/https?:\/\/[^\s]+/);
  const normalized = (match ? match[0] : DEFAULT_APP_URL).replace(/\/$/, '');

  try {
    return new URL(normalized);
  } catch (error) {
    console.warn(`Invalid SHOPIFY_APP_URL value "${candidate}". Falling back to ${DEFAULT_APP_URL}.`);
    return new URL(DEFAULT_APP_URL);
  }
}

const appUrl = resolveAppUrl(process.env.SHOPIFY_APP_URL);

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_products', 'read_themes', 'read_orders'],
  hostName: appUrl.host,
  hostScheme: appUrl.protocol.replace(':', ''),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});

export default shopify;
