import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from './invoice.mjs';

// A durable record per creation attempt prevents double clicks and retries from creating duplicates.
export class OperationStore {
  constructor(directory) { this.directory = directory; this.inFlight = new Map(); }
  async read(key) {
    try { return JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async write(key, value) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${key}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  async create(requestId, invoice, client) {
    if (!/^[0-9a-f-]{36}$/i.test(requestId || '')) throw new AppError('Missing creation request ID. Refresh the page and try again.');
    const key = createHash('sha256').update(`${client.config.paypalClientId}:${client.config.merchantEmail}:${requestId}`).digest('hex');
    const hash = createHash('sha256').update(JSON.stringify(invoice)).digest('hex');
    if (this.inFlight.has(key)) {
      const existing = this.inFlight.get(key);
      if (existing.hash !== hash) throw new AppError('This request already has different invoice details.', 409, 'REQUEST_CONFLICT');
      return existing.promise;
    }
    const promise = this.perform(key, hash, invoice, client);
    this.inFlight.set(key, { hash, promise });
    try { return await promise; } finally { this.inFlight.delete(key); }
  }
  async perform(key, hash, invoice, client) {
    const previous = await this.read(key);
    if (previous && previous.hash !== hash) throw new AppError('The invoice changed after a creation attempt. Check PayPal before starting a new draft.', 409, 'REQUEST_CONFLICT');
    if (previous?.result) return previous.result;
    if (previous?.state === 'pending' || previous?.state === 'uncertain') throw new AppError(`A previous request may have created invoice ${previous.invoiceNumber}. Check your PayPal sandbox dashboard before creating another.`, 409, 'PAYPAL_UNCERTAIN');
    // Authentication happens before persisting a pending creation, so bad credentials can be corrected and retried.
    await client.authenticate();
    const invoiceNumber = `N2I-${key.slice(0, 20).toUpperCase()}`;
    await this.write(key, { hash, state: 'pending', invoiceNumber });
    let result;
    try { result = await client.create(invoice, invoiceNumber); }
    catch (error) {
      await this.write(key, { hash, state: error.code === 'PAYPAL_REJECTED' ? 'rejected' : 'uncertain', invoiceNumber });
      throw error;
    }
    result.total = invoice.total; result.currency = invoice.currency;
    await this.write(key, { hash, state: 'created', invoiceNumber, result });
    try {
      const details = await client.get(result.id);
      result = { ...result, ...Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined)) };
      await this.write(key, { hash, state: 'created', invoiceNumber, result });
    } catch { result.warning = 'The draft was created, but status verification is temporarily unavailable. Use Refresh status.'; }
    return result;
  }
}
