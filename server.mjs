import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, publicConfig } from './lib/config.mjs';
import { AppError, validateInvoice } from './lib/invoice.mjs';
import { extractInvoice } from './lib/ai.mjs';
import { PayPalClient } from './lib/paypal.mjs';
import { OperationStore } from './lib/operations.mjs';

const publicFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/styles.css': ['styles.css', 'text/css'], '/app.mjs': ['app.mjs', 'text/javascript'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Content-Type must be application/json.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw new AppError('Request is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('Request must contain valid JSON.'); }
}

export function deploymentOrigins(env = process.env) {
  if (env.VERCEL !== '1') return [];
  return [env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_BRANCH_URL]
    .filter(Boolean).map(host => `https://${host}`);
}

export function operationDirectory(env = process.env) {
  // Vercel's application bundle is read-only. /tmp is a cache, not durable storage.
  return env.VERCEL === '1' ? join(tmpdir(), 'note2invoice-operations') : fileURLToPath(new URL('./.local/operations', import.meta.url));
}

export function createApp({ configLoader = loadConfig, fetcher = fetch, store = new OperationStore(operationDirectory()), allowedOrigins = deploymentOrigins() } = {}) {
  let busyAI = false;
  return http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const host = req.headers.host || '';
      // Accept loopback locally and only this project's trusted HTTPS origins when hosted.
      const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
      const origin = local ? `http://${host}` : `https://${host}`;
      if (!local && !allowedOrigins.includes(origin)) throw new AppError('This host is not allowed.', 403);
      if (req.headers.origin && req.headers.origin !== origin) throw new AppError('Cross-origin requests are not allowed.', 403);
      const path = new URL(req.url, `http://${host}`).pathname;
      if (req.method === 'GET' && publicFiles[path]) {
        const [file, type] = publicFiles[path];
        const content = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, { ...securityHeaders, 'Content-Type': type }); res.end(content); return;
      }
      if (path === '/api/health' && req.method === 'GET') return send(200, publicConfig(await configLoader()));
      if (path === '/api/extract' && req.method === 'POST') {
        const { notes } = await readJson(req);
        if (typeof notes !== 'string' || notes.trim().length < 10 || notes.length > 8000) throw new AppError('Enter between 10 and 8,000 characters of work notes.');
        if (busyAI) throw new AppError('An extraction is already running. Please wait.', 429);
        busyAI = true;
        try { return send(200, { invoice: await extractInvoice(notes.trim(), await configLoader(), fetcher) }); }
        finally { busyAI = false; }
      }
      if (path === '/api/invoices' && req.method === 'POST') {
        const body = await readJson(req);
        if (body.confirmed !== true) throw new AppError('Review the invoice and confirm its details before creating a draft.');
        const invoice = validateInvoice(body.invoice);
        const client = new PayPalClient(await configLoader(), fetcher);
        return send(201, { invoice: await store.create(body.requestId, invoice, client) });
      }
      if (path.startsWith('/api/invoices/') && req.method === 'GET') {
        const client = new PayPalClient(await configLoader(), fetcher);
        await client.authenticate();
        return send(200, { invoice: await client.get(path.slice('/api/invoices/'.length)) });
      }
      send(404, { error: 'Not found.' });
    } catch (error) {
      // Never log upstream bodies, work notes, credentials, or raw exception messages.
      if (!(error instanceof AppError)) console.error('Request failed:', error?.name || 'Error');
      send(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : 'Something went wrong on the server. Please retry or check the server logs.', code: error.code || 'SERVER_ERROR' });
    }
  });
}

// Vercel imports the entrypoint rather than executing it through `node server.mjs`.
// Export a server without opening a port; the platform supplies its listener.
export default createApp();

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await loadConfig();
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const server = createApp();
  server.once('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${config.port} is already in use.`);
      console.error(`If Note2Invoice is already running, open http://localhost:${config.port}`);
      console.error('Otherwise, stop the existing server or change PORT in .env, then run npm start again.');
    } else {
      console.error(`Could not start Note2Invoice (${error.code || 'unknown error'}).`);
    }
    process.exitCode = 1;
  });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`Note2Invoice is ready at http://localhost:${config.port}`);
    console.log('Sandbox only. Credentials reload from .env automatically.');
  });
}
