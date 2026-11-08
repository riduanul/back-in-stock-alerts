'use strict';

const config = require('./config');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/**
 * Format price with correct currency symbol using Intl.NumberFormat.
 * (e.g. £24.00 for GBP 24, $19.99 for USD 19.99)
 */
function formatPrice(amount, currencyCode) {
  if (amount == null || isNaN(amount)) return '';
  const num = Number(amount);
  const code = (currencyCode || 'USD').trim().toUpperCase();
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: code,
    }).format(num);
  } catch {
    return `${code} ${num.toFixed(2)}`;
  }
}

/**
 * Resolve the "Shop now" destination URL.
 * Priority: explicit storeUrl > STORE_PRODUCT_URL_TEMPLATE > STORE_URL > null.
 */
function resolveShopUrl(sku, storeUrl) {
  if (storeUrl) return storeUrl;
  if (config.STORE_PRODUCT_URL_TEMPLATE && sku) {
    return config.STORE_PRODUCT_URL_TEMPLATE.replace(/\{sku\}/gi, encodeURIComponent(sku));
  }
  if (config.STORE_URL) {
    return config.STORE_URL;
  }
  return null;
}

/**
 * Build the HTML email for a back-in-stock notification.
 * Table-based layout, inline CSS, mobile-first, dark-mode-safe, max-width 600px.
 */
function buildEmailHtml({ productName, productPrice, productCurrency, sku, storeUrl }) {
  const storeName = esc(config.STORE_NAME);
  const name = esc(productName || sku);
  const skuEsc = esc(sku);
  const formattedPrice = formatPrice(productPrice, productCurrency);
  const priceStr = formattedPrice ? esc(formattedPrice) : '';
  const shopUrl = resolveShopUrl(sku, storeUrl);

  const ctaSection = shopUrl
    ? `<!-- CTA -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:4px 0 16px;">
                    <a href="${esc(shopUrl)}" target="_blank" rel="noopener" style="display:inline-block;background:linear-gradient(135deg,#2457d6,#1a3fa0);color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 36px;border-radius:8px;letter-spacing:0.2px;">
                      Shop now &rarr;
                    </a>
                  </td>
                </tr>
              </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Back in Stock: ${name}</title>
  <!--[if mso]><style>table{border-collapse:collapse;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#2457d6,#1a3fa0);padding:32px 24px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">
                Great news! It&rsquo;s back in stock
              </h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 24px;">
              <p style="margin:0 0 20px;color:#333333;font-size:16px;line-height:1.6;">
                The item you were waiting for is available again at <strong>${storeName}</strong>.
              </p>
              <!-- Product card -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f9fb;border-radius:10px;margin-bottom:24px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 4px;font-size:18px;font-weight:600;color:#1a1a2e;">${name}</p>
                    ${priceStr ? `<p style="margin:0 0 4px;font-size:16px;color:#555;">${priceStr}</p>` : ''}
                    <p style="margin:0;font-size:13px;color:#888;">SKU: ${skuEsc}</p>
                  </td>
                </tr>
              </table>
              ${ctaSection}
              <p style="margin:0;color:#888;font-size:13px;line-height:1.5;text-align:center;">
                Hurry &mdash; popular items sell out fast!
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 24px;border-top:1px solid #eaeaea;text-align:center;">
              <p style="margin:0;color:#aaa;font-size:12px;line-height:1.5;">
                You received this email because you asked to be notified when this product was restocked at ${storeName}.<br>
                This is a one-time alert &mdash; you will not receive further emails about this item.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Build the plain-text alternative for the email.
 */
function buildEmailText({ productName, productPrice, productCurrency, sku, storeUrl }) {
  const storeName = config.STORE_NAME;
  const name = productName || sku;
  const formattedPrice = formatPrice(productPrice, productCurrency);
  const shopUrl = resolveShopUrl(sku, storeUrl);

  const lines = [
    `Great news! "${name}" is back in stock at ${storeName}.`,
    formattedPrice ? `Price: ${formattedPrice}` : '',
    `SKU: ${sku}`,
    '',
  ];

  if (shopUrl) {
    lines.push(`Shop now: ${shopUrl}`, '');
  }

  lines.push(
    'Hurry — popular items sell out fast!',
    '',
    `You received this because you asked to be notified when this product was restocked at ${storeName}. This is a one-time alert.`
  );

  return lines.filter(line => line !== null && line !== undefined).join('\n');
}

module.exports = { buildEmailHtml, buildEmailText, formatPrice, resolveShopUrl, esc };
