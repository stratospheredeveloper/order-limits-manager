import shopify from './shopify.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Billing configuration
const BILLING_CONFIG = {
  planName: process.env.BILLING_PLAN_NAME || 'Order Limits Pro',
  amount: parseFloat(process.env.BILLING_AMOUNT) || 9.99,
  currencyCode: process.env.BILLING_CURRENCY || 'USD',
  interval: process.env.BILLING_INTERVAL || 'EVERY_30_DAYS',
  trialDays: parseInt(process.env.FREE_TRIAL_DAYS) || 7,
};

export async function createRecurringCharge(session) {
  const client = new shopify.clients.Graphql({ session });
  
  const mutation = `
    mutation AppSubscriptionCreate(
      $name: String!
      $lineItems: [AppSubscriptionLineItemInput!]!
      $returnUrl: URL!
      $test: Boolean
      $trialDays: Int
    ) {
      appSubscriptionCreate(
        name: $name
        lineItems: $lineItems
        returnUrl: $returnUrl
        test: $test
        trialDays: $trialDays
      ) {
        appSubscription {
          id
          status
        }
        confirmationUrl
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    name: BILLING_CONFIG.planName,
    returnUrl: `${process.env.SHOPIFY_APP_URL}/api/billing/callback`,
    test: process.env.NODE_ENV === 'development',
    trialDays: BILLING_CONFIG.trialDays,
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            price: {
              amount: BILLING_CONFIG.amount,
              currencyCode: BILLING_CONFIG.currencyCode,
            },
            interval: BILLING_CONFIG.interval,
          },
        },
      },
    ],
  };

  try {
    const response = await client.query({
      data: { query: mutation, variables },
    });

    const { appSubscription, confirmationUrl, userErrors } = 
      response.body.data.appSubscriptionCreate;

    if (userErrors && userErrors.length > 0) {
      throw new Error(userErrors[0].message);
    }

    // Store subscription info
    await prisma.shop.update({
      where: { id: session.shop },
      data: {
        subscriptionId: appSubscription.id,
        subscriptionStatus: appSubscription.status,
      },
    });

    return confirmationUrl;
  } catch (error) {
    console.error('Error creating subscription:', error);
    throw error;
  }
}

export async function checkSubscriptionStatus(session) {
  const client = new shopify.clients.Graphql({ session });
  
  const query = `
    {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          test
          trialDays
          currentPeriodEnd
        }
      }
    }
  `;

  try {
    const response = await client.query({ data: query });
    const subscriptions = 
      response.body.data.currentAppInstallation.activeSubscriptions;

    if (subscriptions && subscriptions.length > 0) {
      const subscription = subscriptions[0];
      
      // Update shop subscription status
      await prisma.shop.update({
        where: { id: session.shop },
        data: {
          subscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
        },
      });

      return {
        hasActiveSubscription: subscription.status === 'ACTIVE',
        subscription,
      };
    }

    return { hasActiveSubscription: false, subscription: null };
  } catch (error) {
    console.error('Error checking subscription:', error);
    return { hasActiveSubscription: false, subscription: null };
  }
}

export async function requireSubscription(req, res, next) {
  try {
    const session = await shopify.auth.getSession(req.headers.authorization);
    const { hasActiveSubscription } = await checkSubscriptionStatus(session);

    if (!hasActiveSubscription) {
      // Check if in trial period
      const shop = await prisma.shop.findUnique({
        where: { id: session.shop },
      });

      const trialEndDate = new Date(shop.createdAt);
      trialEndDate.setDate(trialEndDate.getDate() + BILLING_CONFIG.trialDays);

      if (new Date() > trialEndDate) {
        return res.status(402).json({
          error: 'Subscription required',
          message: 'Please activate a subscription to continue using this app',
        });
      }
    }

    next();
  } catch (error) {
    console.error('Subscription check error:', error);
    res.status(500).json({ error: 'Failed to verify subscription' });
  }
}

export async function cancelSubscription(session, subscriptionId) {
  const client = new shopify.clients.Graphql({ session });
  
  const mutation = `
    mutation AppSubscriptionCancel($id: ID!) {
      appSubscriptionCancel(id: $id) {
        appSubscription {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const response = await client.query({
      data: {
        query: mutation,
        variables: { id: subscriptionId },
      },
    });

    const { appSubscription, userErrors } = 
      response.body.data.appSubscriptionCancel;

    if (userErrors && userErrors.length > 0) {
      throw new Error(userErrors[0].message);
    }

    await prisma.shop.update({
      where: { id: session.shop },
      data: {
        subscriptionStatus: appSubscription.status,
      },
    });

    return appSubscription;
  } catch (error) {
    console.error('Error canceling subscription:', error);
    throw error;
  }
}
