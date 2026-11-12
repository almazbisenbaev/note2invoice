import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { validateInvoice, normalizeExtraction, paypalPayload, AppError } from '../lib/invoice.mjs';
import { extractInvoice } from '../lib/ai.mjs';
import { OperationStore } from '../lib/operations.mjs';
import { PayPalClient, PAYPAL_BASE } from '../lib/paypal.mjs';

const draft = () => ({ clientName: 'Alex Chen', clientEmail: 'alex@example.com', currency: 'USD', note: 'Thanks!', items: [{ name: 'Website redesign', quantity: '6', unitPrice: '40.00' }, { name: 'Hosting setup', quantity: '1', unitPrice: '30.00' }] });
const config = { paypalClientId: 'test-client', paypalSecret: 'secret-not-for-browser', merchantEmail: 'merchant@business.example.com', aiProvider: 'meta', aiModel: 'muse-spark-1.3', aiKey: 'test-key-not-for-browser', aiBaseUrl: '' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('calculates 6 x $40 + $30 as $270, ignoring client-supplied totals', () => {
  const result = validateInvoice({ ...draft(), total: '0.01' });
  assert.equal(result.total, '270.00');
  assert.equal(result.items[0].lineTotal, '240.00');
});
test('decimal quantities and fractional cents round half up per line', () => {
  const input = draft(); input.items = [{ name: 'Work', quantity: '1.5', unitPrice: '0.03' }, { name: 'Work 2', quantity: '2.5', unitPrice: '120' }];
  assert.equal(validateInvoice(input).total, '300.05');
});
test('rejects missing rates, negative values, invalid precision and unsafe totals', () => {
  for (const unitPrice of ['', null, '-5', '2.555', '1e2', 'Infinity', '1000001']) {
    const input = draft(); input.items[0].unitPrice = unitPrice;
    assert.throws(() => validateInvoice(input), AppError);
  }
  const input = draft(); input.items[0].quantity = '1000000'; input.items[0].unitPrice = '1000000';
  assert.throws(() => validateInvoice(input), AppError);
});
test('rejects invalid clients, currencies, and empty item lists', () => {
  for (const change of [{ clientName: '' }, { clientEmail: 'invalid' }, { currency: 'EUR' }, { items: [] }]) assert.throws(() => validateInvoice({ ...draft(), ...change }), AppError);
});
test('missing AI prices remain empty and non-USD currency stays visible', () => {
  const result = normalizeExtraction({ ...draft(), currency: 'EUR', items: [{ name: 'Revisions', quantity: '2', unitPrice: null, evidence: 'two hours on revisions' }], warnings: [] });
  assert.equal(result.items[0].unitPrice, '');
  assert.equal(result.currency, 'EUR');
  assert.match(result.warnings.join(' '), /not been converted/);
});
test('PayPal payload uses normalized items without payment or send actions', () => {
  const payload = paypalPayload(validateInvoice(draft()), config.merchantEmail, 'N2I-123');
  assert.equal(payload.invoicer.email_address, config.merchantEmail);
  assert.equal(payload.items[0].unit_amount.value, '40.00');
  assert.equal(payload.primary_recipients[0].billing_info.email_address, 'alex@example.com');
  assert.equal(payload.detail.invoice_number, 'N2I-123');
});
test('Meta extraction calls the correct endpoint and validates structured output', async () => {
  let called = false;
  const result = await extractInvoice('Example notes with USD rates', config, async (url, options) => {
    called = true;
    assert.equal(url, 'https://api.meta.ai/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.messages[0].role, 'developer');
    assert.equal(body.response_format.type, 'json_schema');
    return json({ choices: [{ message: { content: JSON.stringify({ ...draft(), warnings: [] }) } }] });
  });
  assert.ok(called); assert.equal(result.items[0].quantity, '6.00');
});
test('AI errors do not disclose upstream bodies or keys', async () => {
  await assert.rejects(() => extractInvoice('Example notes', config, async () => json({ secret: config.aiKey }, 401)), error => {
    assert.equal(error.code, 'AI_PROVIDER_ERROR'); assert.ok(!error.message.includes(config.aiKey)); return true;
  });
  await assert.rejects(() => extractInvoice('Example notes', config, async () => json({ choices: [{ message: { content: 'not json' } }] })), { code: 'AI_FORMAT' });
});
test('PayPal supports both the minimal href response and direct representation', async () => {
  for (const body of [{ href: `${PAYPAL_BASE}/v2/invoicing/invoices/INV2-TEST-1234-ABCD-EFGH` }, { id: 'INV2-TEST-1234-ABCD-EFGH', status: 'DRAFT' }]) {
    const client = new PayPalClient(config, async (url) => {
      assert.ok(url.startsWith(PAYPAL_BASE));
      return url.endsWith('/token') ? json({ access_token: 'test-token' }) : json(body, 201);
    });
    await client.authenticate();
    assert.equal((await client.create(validateInvoice(draft()), 'N2I-123')).id, 'INV2-TEST-1234-ABCD-EFGH');
  }
});
test('PayPal timeouts after a write are explicitly marked uncertain', async () => {
  const client = new PayPalClient(config, async () => { throw new Error('timeout'); });
  await assert.rejects(() => client.create(validateInvoice(draft()), 'N2I-123'), { code: 'PAYPAL_UNCERTAIN' });
});

async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'note2invoice-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new OperationStore(directory);
}
test('concurrent clicks and later retries create exactly one PayPal draft', async t => {
  const store = await temporaryStore(t); let creates = 0;
  const client = { config, authenticate: async () => {}, create: async () => { creates++; return { id: 'INV2-TEST', status: 'DRAFT', total: '270.00' }; }, get: async () => ({ id: 'INV2-TEST', status: 'DRAFT', verified: true }) };
  const requestId = randomUUID(), invoice = validateInvoice(draft());
  const results = await Promise.all([store.create(requestId, invoice, client), store.create(requestId, invoice, client)]);
  assert.equal(results[0].id, results[1].id);
  await new OperationStore(store.directory).create(requestId, invoice, client);
  assert.equal(creates, 1);
  await assert.rejects(() => store.create(requestId, { ...invoice, note: 'changed' }, client), { code: 'REQUEST_CONFLICT' });
});
test('uncertain writes survive restart and are never automatically retried', async t => {
  const store = await temporaryStore(t); let creates = 0;
  const client = { config, authenticate: async () => {}, create: async () => { creates++; throw new AppError('timeout', 504, 'PAYPAL_UNCERTAIN'); } };
  const id = randomUUID(), invoice = validateInvoice(draft());
  await assert.rejects(() => store.create(id, invoice, client), { code: 'PAYPAL_UNCERTAIN' });
  await assert.rejects(() => new OperationStore(store.directory).create(id, invoice, client), { code: 'PAYPAL_UNCERTAIN' });
  assert.equal(creates, 1);
});
test('read failure after successful creation still returns the actual created invoice', async t => {
  const store = await temporaryStore(t);
  const client = { config, authenticate: async () => {}, create: async () => ({ id: 'INV2-TEST', status: 'CREATED', verified: false }), get: async () => { throw new Error('read unavailable'); } };
  const result = await store.create(randomUUID(), validateInvoice(draft()), client);
  assert.equal(result.id, 'INV2-TEST'); assert.equal(result.verified, false); assert.match(result.warning, /created/);
});
test('bad credentials can be corrected and retried', async t => {
  const store = await temporaryStore(t); let bad = true;
  const client = { config, authenticate: async () => { if (bad) throw new AppError('bad credentials', 502, 'PAYPAL_AUTH'); }, create: async () => ({ id: 'INV2-TEST' }), get: async () => ({ id: 'INV2-TEST', status: 'DRAFT' }) };
  const id = randomUUID(), invoice = validateInvoice(draft());
  await assert.rejects(() => store.create(id, invoice, client), { code: 'PAYPAL_AUTH' });
  bad = false; assert.equal((await store.create(id, invoice, client)).id, 'INV2-TEST');
});

test('HTTP flow extracts, validates, creates and verifies without exposing secrets', async t => {
  const store = await temporaryStore(t); let writes = 0;
  const fetcher = async (url, options) => {
    if (url.startsWith('https://api.meta.ai/')) return json({ choices: [{ message: { content: JSON.stringify({ ...draft(), warnings: [] }) } }] });
    if (url.endsWith('/token')) return json({ access_token: 'test-token' });
    if (options.method === 'POST') { writes++; return json({ id: 'INV2-TEST-1234-ABCD-EFGH', status: 'DRAFT' }, 201); }
    return json({ id: 'INV2-TEST-1234-ABCD-EFGH', status: 'DRAFT', amount: { value: '270.00', currency_code: 'USD' }, detail: { invoice_number: 'N2I-TEST' } });
  };
  const server = createApp({ configLoader: async () => config, fetcher, store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(base)).status, 200);
  const health = await (await fetch(`${base}/api/health`)).text();
  assert.ok(!health.includes(config.aiKey)); assert.ok(!health.includes(config.paypalSecret));
  for (const path of ['/.env', '/lib/config.mjs', '/.git/config', '/.local/operations/test.json']) assert.equal((await fetch(`${base}${path}`)).status, 404);
  assert.equal((await post('/api/extract', { notes: 'Website redesign for Alex, six hours at $40 USD per hour.' }, { Origin: 'https://evil.example' })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/health`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  const extraction = await (await post('/api/extract', { notes: 'Website redesign for Alex, six hours at $40 USD per hour.' })).json();
  assert.equal(extraction.invoice.clientName, 'Alex Chen');
  const body = { invoice: draft(), requestId: randomUUID(), confirmed: false };
  assert.equal((await post('/api/invoices', body)).status, 400); assert.equal(writes, 0);
  body.confirmed = true;
  const created = await post('/api/invoices', body); assert.equal(created.status, 201);
  const result = await created.json(); assert.equal(result.invoice.verified, true); assert.equal(result.invoice.status, 'DRAFT');
  assert.equal((await post('/api/invoices', body)).status, 201); assert.equal(writes, 1);
});
