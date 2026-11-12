// Development-only UI fixture. No external requests are made and no credentials are read.
// Do not use this server for the submission demo: its results are simulated.
import { createApp } from '../server.mjs';
import { OperationStore } from '../lib/operations.mjs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const config = { aiProvider: 'meta', aiModel: 'TEST FIXTURE', aiKey: 'fixture-only', paypalClientId: 'fixture-only', paypalSecret: 'fixture-only', merchantEmail: 'fixture@example.com' };
const server = createApp({
  configLoader: async () => config,
  store: new OperationStore(await mkdtemp(join(tmpdir(), 'note2invoice-ui-'))),
  fetcher: async (url, options) => {
    if (url.startsWith('https://api.meta.ai/')) {
      const body = JSON.parse(options.body); const missing = body.messages[1].content.includes('not agreed');
      const invoice = missing
        ? { clientName: 'Maya', clientEmail: 'maya@example.com', currency: 'USD', note: '', items: [{ name: 'Logo design concepts', quantity: '3', unitPrice: '80', evidence: 'Three design concepts at $80 each' }, { name: 'Revisions', quantity: '2', unitPrice: null, evidence: 'two hours on revisions' }], warnings: ['The revision rate has not been agreed. Add it before creating a draft.'] }
        : { clientName: 'Alex Chen', clientEmail: 'alex@example.com', currency: 'USD', note: 'Thanks for trusting me with your new website!', items: [{ name: 'Website redesign', quantity: '6', unitPrice: '40', evidence: '6 hours at $40/hour' }, { name: 'Hosting setup', quantity: '1', unitPrice: '30', evidence: 'a flat $30 for hosting setup' }], warnings: [] };
      return json({ choices: [{ message: { content: JSON.stringify(invoice) } }] });
    }
    if (url.endsWith('/token')) return json({ access_token: 'fixture-only' });
    if (options.method === 'POST') return json({ id: 'INV2-TEST-ONLY-0000-0000', status: 'DRAFT' }, 201);
    return json({ id: 'INV2-TEST-ONLY-0000-0000', status: 'DRAFT', detail: { invoice_number: 'TEST-FIXTURE-NOT-REAL' }, amount: { value: '270.00', currency_code: 'USD' } });
  },
});
server.listen(3001, '127.0.0.1', () => console.log('UI TEST FIXTURE ONLY — http://localhost:3001 — simulated API responses, not a real demo'));
