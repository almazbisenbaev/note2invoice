import { AppError, paypalPayload } from './invoice.mjs';

// Intentionally not configurable: this hackathon app can never use live PayPal.
export const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';

export class PayPalClient {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; this.token = null; }
  async authenticate() {
    const { paypalClientId, paypalSecret, merchantEmail } = this.config;
    if (!paypalClientId || !paypalSecret || !merchantEmail) throw new AppError('Add PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_MERCHANT_EMAIL to .env, then save.', 503, 'PAYPAL_NOT_CONFIGURED');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(merchantEmail)) throw new AppError('PAYPAL_MERCHANT_EMAIL must be your sandbox business account email.', 503, 'PAYPAL_CONFIGURATION');
    let response;
    try {
      response = await this.fetcher(`${PAYPAL_BASE}/v1/oauth2/token`, {
        method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${paypalClientId}:${paypalSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials', signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new AppError('Could not connect to PayPal sandbox. No invoice was created; try again.', 504, 'PAYPAL_AUTH_CONNECTION'); }
    if (!response.ok) throw new AppError('PayPal rejected the sandbox credentials. Check that both keys belong to the same sandbox app.', 502, 'PAYPAL_AUTH');
    this.token = (await response.json()).access_token;
    if (!this.token) throw new AppError('PayPal returned no access token.', 502, 'PAYPAL_AUTH');
  }

  async create(invoice, invoiceNumber) {
    let response;
    try {
      response = await this.fetcher(`${PAYPAL_BASE}/v2/invoicing/invoices`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(paypalPayload(invoice, this.config.merchantEmail, invoiceNumber)), signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new AppError('PayPal did not confirm the result. Check your sandbox invoices before trying a new draft to avoid duplicates.', 504, 'PAYPAL_UNCERTAIN'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status >= 500) throw new AppError('PayPal could not confirm whether the draft was created. Check your sandbox invoice list before creating another.', 502, 'PAYPAL_UNCERTAIN');
      const detail = data.details?.map(item => item.issue || item.description || '').filter(Boolean).join('; ').slice(0, 300);
      const message = response.status === 403
        ? 'This sandbox app cannot create invoices. Check the Invoicing permission and its business account.'
        : `PayPal rejected this invoice${detail ? `: ${detail}` : '. Check the client details and sandbox merchant email.'}`;
      throw new AppError(message, 502, 'PAYPAL_REJECTED');
    }
    const id = data.id || (data.href || response.headers.get('location') || '').match(/\/invoices\/(INV2-[A-Z0-9-]+)/i)?.[1];
    if (!id || !/^INV2-[A-Z0-9-]+$/i.test(id)) throw new AppError('PayPal accepted the request but returned no invoice ID. Check your sandbox invoices before creating another draft.', 502, 'PAYPAL_UNCERTAIN');
    return { id, status: data.status || 'CREATED', invoiceNumber, verified: false, createdAt: new Date().toISOString() };
  }

  async get(id) {
    if (!/^INV2-[A-Z0-9-]{5,80}$/i.test(id)) throw new AppError('Invalid PayPal invoice ID.');
    let response;
    try {
      response = await this.fetcher(`${PAYPAL_BASE}/v2/invoicing/invoices/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20_000) });
    } catch { throw new AppError('Could not refresh the PayPal invoice. The existing draft has not been changed.', 504, 'PAYPAL_READ'); }
    if (!response.ok) throw new AppError('Could not read this invoice from PayPal. Check your sandbox account and try Refresh status.', 502, 'PAYPAL_READ');
    const data = await response.json();
    if (data.id !== id) throw new AppError('PayPal returned an unexpected invoice.', 502, 'PAYPAL_READ');
    const candidate = data.detail?.metadata?.invoicer_view_url;
    let merchantUrl = '';
    try { const url = new URL(candidate); if (url.protocol === 'https:' && url.hostname === 'www.sandbox.paypal.com') merchantUrl = url.href; } catch { /* Use the sandbox dashboard link instead. */ }
    return { id: data.id, status: data.status, invoiceNumber: data.detail?.invoice_number, total: data.amount?.value, currency: data.amount?.currency_code, merchantUrl, verified: true, verifiedAt: new Date().toISOString() };
  }
}
