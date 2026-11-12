import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export async function loadConfig() {
  let file = {};
  try { if (process.env.VERCEL !== '1') file = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not parse .env. Check its KEY=value format.'); }
  const env = { ...file, ...process.env };
  const provider = (env.AI_PROVIDER || 'openai').trim().toLowerCase();
  const models = { meta: 'muse-spark-1.3', openai: 'gpt-4o-mini', gemini: 'gemini-2.5-flash', anthropic: 'claude-haiku-4-5-20251001' };
  return {
    paypalClientId: env.PAYPAL_CLIENT_ID?.trim() || '',
    paypalSecret: env.PAYPAL_CLIENT_SECRET?.trim() || '',
    merchantEmail: env.PAYPAL_MERCHANT_EMAIL?.trim() || '',
    aiProvider: provider,
    aiKey: env.AI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || '',
    aiModel: env.AI_MODEL?.trim() || models[provider] || '',
    aiBaseUrl: env.AI_BASE_URL?.trim() || '',
    port: Number(env.PORT || 3000),
    hosted: env.VERCEL === '1',
  };
}

export function publicConfig(config) {
  return {
    aiConfigured: Boolean(config.aiKey && config.aiModel),
    paypalConfigured: Boolean(config.paypalClientId && config.paypalSecret && config.merchantEmail),
    provider: config.aiProvider,
    model: config.aiModel,
    environment: 'sandbox',
    hosted: Boolean(config.hosted),
  };
}
