import { shopifyApi, LATEST_API_VERSION } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

const appUrl = new URL(process.env.SHOPIFY_APP_URL || 'http://localhost:3000');

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
