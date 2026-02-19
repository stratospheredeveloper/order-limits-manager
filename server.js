import 'dotenv/config';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// Simple health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Home route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-dashboard-with-search.html'));
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
    
    // Create shop if it doesn't exist
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
        minQuantity: minQuantity ? parseInt(minQuantity) : null,
        maxQuantity: maxQuantity ? parseInt(maxQuantity) : null,
        message,
        enabled: true,
      },
    });
    
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
        minQuantity: minQuantity ? parseInt(minQuantity) : null,
        maxQuantity: maxQuantity ? parseInt(maxQuantity) : null,
        enabled,
        message,
      },
    });
    
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
    
    await prisma.rule.delete({
      where: { id },
    });
    
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
    
    // Create shop if it doesn't exist
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
    const { globalMinCart, globalMaxCart, showCartWarning, blockCheckout, customMessageEnabled } = req.body;
    
    // Create shop if it doesn't exist
    await prisma.shop.upsert({
      where: { id: shop },
      update: {},
      create: { id: shop, name: shop },
    });
    
    const settings = await prisma.settings.upsert({
      where: { shopId: shop },
      update: {
        globalMinCart: globalMinCart ? parseInt(globalMinCart) : null,
        globalMaxCart: globalMaxCart ? parseInt(globalMaxCart) : null,
        showCartWarning,
        blockCheckout,
        customMessageEnabled,
      },
      create: {
        shopId: shop,
        globalMinCart: globalMinCart ? parseInt(globalMinCart) : null,
        globalMaxCart: globalMaxCart ? parseInt(globalMaxCart) : null,
        showCartWarning,
        blockCheckout,
        customMessageEnabled,
      },
    });
    
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

// API: Validate cart (called from storefront)
app.post('/api/validate-cart', async (req, res) => {
  try {
    const { shop, items } = req.body;
    
    if (!shop || !items) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing shop or items' 
      });
    }
    
    const rules = await prisma.rule.findMany({
      where: { 
        shopId: shop,
        enabled: true,
      },
    });
    
    const settings = await prisma.settings.findUnique({
      where: { shopId: shop },
    });
    
    const violations = [];
    
    // Check product/variant specific rules
    for (const item of items) {
      const productRules = rules.filter(r => 
        (r.ruleType === 'product' && r.targetId === item.product_id?.toString()) ||
        (r.ruleType === 'variant' && r.targetId === item.variant_id?.toString())
      );
      
      for (const rule of productRules) {
        if (rule.minQuantity && item.quantity < rule.minQuantity) {
          violations.push({
            type: 'min',
            item: item.title,
            limit: rule.minQuantity,
            current: item.quantity,
            message: rule.message || `Minimum quantity for ${item.title} is ${rule.minQuantity}`,
          });
        }
        
        if (rule.maxQuantity && item.quantity > rule.maxQuantity) {
          violations.push({
            type: 'max',
            item: item.title,
            limit: rule.maxQuantity,
            current: item.quantity,
            message: rule.message || `Maximum quantity for ${item.title} is ${rule.maxQuantity}`,
          });
        }
      }
    }
    
    // Check cart-wide rules
    const cartRules = rules.filter(r => r.ruleType === 'cart');
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    
    for (const rule of cartRules) {
      if (rule.minQuantity && totalQuantity < rule.minQuantity) {
        violations.push({
          type: 'cart_min',
          limit: rule.minQuantity,
          current: totalQuantity,
          message: rule.message || `Minimum cart quantity is ${rule.minQuantity} items`,
        });
      }
      
      if (rule.maxQuantity && totalQuantity > rule.maxQuantity) {
        violations.push({
          type: 'cart_max',
          limit: rule.maxQuantity,
          current: totalQuantity,
          message: rule.message || `Maximum cart quantity is ${rule.maxQuantity} items`,
        });
      }
    }
    
    // Check global settings limits
    if (settings?.globalMinCart && totalQuantity < settings.globalMinCart) {
      violations.push({
        type: 'cart_min',
        limit: settings.globalMinCart,
        current: totalQuantity,
        message: `Minimum cart quantity is ${settings.globalMinCart} items`,
      });
    }
    
    if (settings?.globalMaxCart && totalQuantity > settings.globalMaxCart) {
      violations.push({
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
      blockCheckout: settings?.blockCheckout ?? true,
    });
  } catch (error) {
    console.error('Error validating cart:', error);
    res.status(500).json({ success: false, error: 'Validation failed' });
  }
});

// API: Search products (for admin dashboard)
app.get('/api/products/search', async (req, res) => {
  try {
    const shop = req.query.shop || 'test-shop';
    const query = req.query.q || '';
    
    // For now, return mock data
    // Later we'll connect to Shopify API to fetch real products
    const mockProducts = [
  {
    id: '10218251190591',
    title: 'Selling Plans Ski Wax',
    image: 'https://cdn.shopify.com/s/files/1/0869/8706/3109/files/snowboard_wax.png',
    variants: []
  },
  {
    id: '10218250895679',
    title: 'The Inventory Not Tracked Snowboard',
    image: 'https://cdn.shopify.com/s/files/1/0869/8706/3109/files/snowboard_purple_hydrogen.png',
    variants: []
  }
];
    
    // Filter by search query
    const filtered = mockProducts.filter(p => 
      p.title.toLowerCase().includes(query.toLowerCase())
    );
    
    res.json({ success: true, products: filtered });
  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({ success: false, error: 'Failed to search products' });
  }
});

// ===== MANDATORY COMPLIANCE WEBHOOKS =====

import crypto from 'crypto';

// Verify Shopify webhook signature
function verifyWebhook(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const body = JSON.stringify(req.body);
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(body, 'utf8')
    .digest('base64');
  return hmac === hash;
}

// Webhook: Customer data request (GDPR)
app.post('/webhooks/customers/data_request', express.json(), (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).send('Unauthorized');
  }
  
  console.log('Customer data request:', req.body);
  // We don't store customer data, so nothing to return
  res.status(200).send('OK');
});

// Webhook: Customer redact (GDPR)
app.post('/webhooks/customers/redact', express.json(), (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).send('Unauthorized');
  }
  
  console.log('Customer redact request:', req.body);
  // We don't store customer data, so nothing to delete
  res.status(200).send('OK');
});

// Webhook: Shop redact (GDPR)
app.post('/webhooks/shop/redact', express.json(), (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).send('Unauthorized');
  }
  
  const shopId = req.body.shop_domain;
  console.log('Shop redact request:', shopId);
  
  // Delete all data for this shop
  prisma.rule.deleteMany({ where: { shopId } })
    .then(() => prisma.settings.deleteMany({ where: { shopId } }))
    .then(() => prisma.shop.deleteMany({ where: { id: shopId } }))
    .then(() => res.status(200).send('OK'))
    .catch(err => {
      console.error('Error deleting shop data:', err);
      res.status(500).send('Error');
    });
});

// ===== END COMPLIANCE WEBHOOKS =====

// Initialize database on first run
async function initializeDatabase() {
  try {
    await prisma.$connect();
    console.log('✅ Database connected');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    console.log('Run: npx prisma migrate dev');
  }
}

// Start server
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

// Handle shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
