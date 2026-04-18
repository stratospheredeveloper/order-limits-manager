# Shopify Review Follow-up

## Fixed in code

- Replaced the mock product search with live Shopify Admin API product and variant lookup.
- Added Shopify OAuth-backed token storage so the dashboard can read real shop data.
- Added a theme app extension under `extensions/limitpro-theme/` with:
  - `Cart validator` app embed for storefront cart validation and checkout blocking
  - `Product limit notice` app block for optional product-page messaging
- Added in-app onboarding instructions with deep links for the app embed and app block.
- Removed the direct theme-editing scope and switched to `read_themes`.

## Still requires a manual Partner Dashboard update

- Replace any duplicate or near-identical App Store listing screenshots.
- Use distinct screenshots for:
  1. Theme setup / app embed activation
  2. Live product or variant rule search
  3. Cart warning / blocked checkout state
  4. Product page app block preview

## Suggested reply

Hello Shopify App Review Team,

We’ve addressed the review feedback for LimitPro.

- We implemented a theme app extension and no longer rely on merchant theme code edits.
- We added detailed in-app onboarding instructions with theme editor deep links for the app embed and app block.
- We fixed the product search flow so it now loads live Shopify product and variant data instead of returning placeholder results.
- We also updated our setup to use the proper theme-extension flow for storefront messaging.

We are also updating the App Store listing screenshots so each image is unique and shows a different feature or state.

Please resume the review when convenient. Thank you.
