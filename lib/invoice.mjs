export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') {
    super(message); this.status = status; this.code = code;
  }
}

export function cleanText(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Represent both price and quantity in hundredths. Never use floats to sum money.
export function hundredths(value, label, allowZero = true) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(text)) {
    throw new AppError(`${label} must be a number with up to two decimal places.`);
  }
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if ((!allowZero && result <= 0) || result > 100_000_000) {
    throw new AppError(`${label} is outside the supported range.`);
  }
  return result;
}

export function formatHundredths(value) { return (value / 100).toFixed(2); }

export function validateInvoice(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Invoice details are required.');
  if (input.currency !== 'USD') throw new AppError('This version supports USD only. Review and convert the amounts yourself before creating a draft.');
  const clientName = cleanText(input.clientName, 200);
  const clientEmail = cleanText(input.clientEmail, 254);
  if (!clientName) throw new AppError('Enter a client name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) throw new AppError('Enter a valid client email.');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) throw new AppError('Add between 1 and 20 line items.');
  let totalCents = 0;
  const items = input.items.map((item, i) => {
    if (!item || typeof item !== 'object') throw new AppError(`Line ${i + 1} is invalid.`);
    const name = cleanText(item.name, 127);
    if (!name) throw new AppError(`Enter a description for line ${i + 1}.`);
    const quantityHundredths = hundredths(item.quantity, `Quantity on line ${i + 1}`, false);
    const priceCents = hundredths(item.unitPrice, `Price on line ${i + 1}`);
    // Quantity x unit price, rounded half up to cents for each line.
    const lineCents = Math.floor((quantityHundredths * priceCents + 50) / 100);
    if (!Number.isSafeInteger(quantityHundredths * priceCents) || lineCents > 100_000_000) throw new AppError(`Amount on line ${i + 1} is too large.`);
    totalCents += lineCents;
    return { name, quantity: formatHundredths(quantityHundredths), unitPrice: formatHundredths(priceCents), lineTotal: formatHundredths(lineCents) };
  });
  if (totalCents <= 0 || totalCents > 100_000_000) throw new AppError('Invoice total must be greater than zero and no more than $1,000,000.');
  return { clientName, clientEmail, currency: 'USD', items, note: cleanText(input.note, 1000), total: formatHundredths(totalCents) };
}

export function normalizeExtraction(input) {
  if (!input || !Array.isArray(input.items)) throw new AppError('The AI returned an unexpected response. Try again with clearer work notes.', 502, 'AI_FORMAT');
  const warnings = Array.isArray(input.warnings) ? input.warnings.map(x => cleanText(x, 300)).filter(Boolean).slice(0, 10) : [];
  const normalized = {
    clientName: cleanText(input.clientName, 200),
    clientEmail: cleanText(input.clientEmail, 254),
    currency: cleanText(input.currency, 12).toUpperCase(),
    note: cleanText(input.note, 1000),
    items: input.items.slice(0, 20).map((item, i) => {
      const readNumber = (value, label, zero) => {
        if (value === null || value === undefined || value === '') return '';
        try { return formatHundredths(hundredths(value, label, zero)); }
        catch { warnings.push(`${label} needs review.`); return ''; }
      };
      return {
        name: cleanText(item?.name, 127),
        quantity: readNumber(item?.quantity, `Quantity on line ${i + 1}`, false),
        unitPrice: readNumber(item?.unitPrice, `Price on line ${i + 1}`, true),
        evidence: cleanText(item?.evidence, 500),
      };
    }),
    warnings,
  };
  if (!normalized.currency) warnings.push('Currency was not specified. Confirm that these amounts are in USD.');
  else if (normalized.currency !== 'USD') warnings.push(`Notes specify ${normalized.currency}. This prototype supports USD only; amounts have not been converted.`);
  if (!normalized.clientName) warnings.push('Add the client name.');
  if (!normalized.clientEmail) warnings.push('Add the client email.');
  if (input.items.length > 20) warnings.push('Only the first 20 items were extracted. Split this into smaller invoices.');
  return normalized;
}

export function paypalPayload(invoice, merchantEmail, invoiceNumber) {
  return {
    detail: {
      invoice_number: invoiceNumber,
      currency_code: invoice.currency,
      ...(invoice.note ? { note: invoice.note } : {}),
    },
    invoicer: { email_address: merchantEmail },
    primary_recipients: [{ billing_info: { email_address: invoice.clientEmail, business_name: invoice.clientName } }],
    items: invoice.items.map(item => ({
      name: item.name,
      quantity: item.quantity,
      unit_amount: { currency_code: invoice.currency, value: item.unitPrice },
    })),
  };
}
