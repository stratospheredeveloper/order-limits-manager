import 'dotenv/config';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import cors from 'cors';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

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
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Order Limits Manager</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
          h1 { color: #5C6AC4; }
          .status { background: #E3F2FD; padding: 20px; border-radius: 8px; }
        </style>
      </head>
      <body>
        <h1>🎉 Order Limits Manager</h1>
        <div class="status">
          <p><strong>Status:</strong> Running</p>
          <p><strong>Version:</strong> 1.0.0</p>
          <p><strong>API Ready:</strong> Yes</p>
        </div>
        <h2>Next Steps:</h2>
        <ol>
          <li>Install this app on your Shopify store</li>
          <li>Configure your order limits</li>
          <li>Start managing quantities!</li>
        </ol>
      </body>
    </html>
  `);
});

// ===== BILLING ROUTES =====

// Initiate subscription
app.get('/api/billing/subscribe', async (req, res) => {
  try {
    const session = await shopify.auth.getSession(req.headers.authorization);
    const confirmationUrl = await createRecurringCharge(session);
    res.json({ confirmationUrl });
  } catch (error) {
    console.error('Subscription error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// Check subscription status
app.get('/api/billing/status', async (req, res) => {
  try {
    const session = await shopify.auth.getSession(req.headers.authorization);
    const status = await checkSubscriptionStatus(session);
    res.json(status);
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Failed to check subscription status' });
  }
});

// ===== END BILLING ROUTES =====

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
    
    // Check cart-wide limits
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    
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
