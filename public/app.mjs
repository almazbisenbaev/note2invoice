const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const examples = {
  design: 'Website redesign for Alex Chen (alex@example.com). I worked 6 hours at $40/hour, plus a flat $30 for hosting setup. Bill in USD. Add a note: Thanks for trusting me with your new website!',
  consulting: 'Client: River Studio, billing@river.example.com. This week: 2.5 hours of product strategy at 120 USD per hour and a fixed 150 USD for the written roadmap. Note to client: Great working together.',
  missing: 'Logo refresh for Maya at maya@example.com. Three design concepts at $80 each. Also spent two hours on revisions, but we have not agreed on the revision rate yet. All amounts are USD.',
};
let draft = null, result = null, requestId = crypto.randomUUID(), busy = false, uncertain = false, currencyNeedsConfirmation = false;
let itemSequence = 0;
const money = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value)) : '—';

function message(text = '') { $('#page-message').textContent = text; $('#page-message').hidden = !text; }
function setStep(step) {
  for (let i = 1; i <= 3; i++) {
    const el = $(`#step-${i}`); el.classList.toggle('active', i === step); el.classList.toggle('complete', i < step);
    if (i === step) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
  }
}

async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); }
  catch { throw new Error('Cannot reach the server. Check your connection and try again.'); }
  const data = await response.json().catch(() => ({ error: `The server is unavailable (HTTP ${response.status}). Please try again shortly.` }));
  if (!response.ok) { const error = new Error(data.error || 'The request failed.'); error.code = data.code; throw error; }
  return data;
}

async function checkSetup() {
  try {
    const status = await api('/api/health');
    $('#setup-instructions').textContent = status.hosted
      ? 'The demo owner configures API credentials in Vercel project settings → Environment Variables, then redeploys. Credentials are never entered in this page.'
      : 'Put your credentials in the .env file in the project folder, then save. This page checks for changes automatically.';
    const ready = status.aiConfigured && status.paypalConfigured;
    $('#setup-label').textContent = ready ? 'Keys added' : 'Setup needed';
    $('#setup-dot').classList.toggle('amber', !ready);
    $('#ai-setup-status').textContent = status.aiConfigured ? `Key added · ${status.provider}` : 'Add AI_API_KEY';
    $('#paypal-setup-status').textContent = status.paypalConfigured ? 'Credentials added' : 'Add sandbox credentials';
  } catch { $('#setup-label').textContent = 'Server offline'; $('#setup-dot').classList.add('amber'); }
}

function setBusy(value, phase = 'extract') {
  busy = value;
  document.body.classList.toggle('is-loading', value);
  $('#extract-button').disabled = value || Boolean(result) || uncertain;
  $('#notes').disabled = value || Boolean(result) || uncertain;
  $$('[data-example]').forEach(button => { button.disabled = value || Boolean(result) || uncertain; });
  $('#invoice-fields').disabled = value || uncertain;
  $('#extract-label').textContent = value && phase === 'extract' ? 'Organizing your notes…' : draft ? 'Organize again' : 'Organize with AI';
  $('#create-label').textContent = value && phase === 'create' ? 'Creating your PayPal draft…' : 'Create PayPal draft';
  updateCreateButton();
}

function updateCount() { $('#character-count').textContent = `${$('#notes').value.length.toLocaleString()} / 8,000`; }
$('#notes').addEventListener('input', updateCount);
$$('[data-example]').forEach(button => button.addEventListener('click', () => { $('#notes').value = examples[button.dataset.example]; updateCount(); $('#notes').focus(); }));

function inputField(labelText, value, options = {}) {
  const label = document.createElement('label'); label.textContent = labelText;
  const input = document.createElement('input'); input.value = value ?? ''; input.required = true;
  input.id = `item-${++itemSequence}`; input.setAttribute('aria-label', options.ariaLabel || labelText);
  Object.assign(input, options); label.append(input); return { label, input };
}

function addItem(item = { name: '', quantity: '1', unitPrice: '', evidence: '' }) {
  if ($('#line-items').children.length >= 20) { message('This version supports up to 20 line items.'); return; }
  const row = document.createElement('div'); row.className = 'line-item';
  const description = document.createElement('div'); description.className = 'item-description';
  const name = inputField('', item.name, { placeholder: 'Describe the work', maxLength: 127, ariaLabel: 'Service description' }); name.input.dataset.field = 'name';
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-item'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove line item');
  description.append(name.label, remove);
  const numbers = document.createElement('div'); numbers.className = 'item-numbers';
  const qty = inputField('Quantity', item.quantity, { type: 'number', min: '0.01', max: '1000000', step: '0.01', placeholder: 'Required' }); qty.input.dataset.field = 'quantity';
  const price = inputField('Unit price (USD)', item.unitPrice, { type: 'number', min: '0', max: '1000000', step: '0.01', placeholder: 'Add a rate' }); price.input.dataset.field = 'unitPrice';
  const amount = document.createElement('output'); amount.className = 'line-amount'; amount.setAttribute('aria-label', 'Line total');
  numbers.append(qty.label, price.label, amount); row.append(description, numbers);
  if (item.evidence) { const hint = document.createElement('p'); hint.className = 'evidence-hint'; hint.textContent = `From your notes: “${item.evidence}”`; row.append(hint); }
  row.addEventListener('input', () => { invalidateConfirmation(); updateTotals(); });
  remove.addEventListener('click', () => { row.remove(); invalidateConfirmation(); updateTotals(); });
  $('#line-items').append(row);
}

function readInvoice() {
  return {
    clientName: $('#client-name').value.trim(), clientEmail: $('#client-email').value.trim(), currency: 'USD', note: $('#invoice-note').value.trim(),
    items: $$('#line-items .line-item').map(row => Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value.trim()]))),
  };
}

function updateTotals() {
  let total = 0, valid = true;
  for (const row of $$('#line-items .line-item')) {
    const qty = row.querySelector('[data-field="quantity"]'); const price = row.querySelector('[data-field="unitPrice"]');
    row.querySelectorAll('input').forEach(input => input.classList.toggle('needs-input', !input.value));
    const okay = qty.value !== '' && price.value !== '' && qty.validity.valid && price.validity.valid;
    const cents = okay ? Math.floor((Math.round(Number(qty.value) * 100) * Math.round(Number(price.value) * 100) + 50) / 100) : 0;
    row.querySelector('output').textContent = okay ? money(cents / 100) : '—';
    total += cents; valid = valid && okay;
  }
  $('#invoice-total').textContent = valid ? money(total / 100) : 'Needs review';
  updateCreateButton();
}

function invalidateConfirmation() {
  $('#review-confirm').checked = false;
  // A rejected attempt may be edited; uncertain attempts remain locked.
  if (!uncertain) requestId = crypto.randomUUID();
}

function updateCreateButton() {
  const form = $('#invoice-form');
  const valid = [...form.querySelectorAll('input[required]')].every(input => input.validity.valid);
  const currencyOkay = !currencyNeedsConfirmation || $('#currency-confirm').checked;
  $('#create-button').disabled = busy || uncertain || !draft || !valid || !currencyOkay || !$('#line-items').children.length;
}

function showDraft(invoice) {
  draft = invoice; result = null; uncertain = false; requestId = crypto.randomUUID();
  $('#empty-preview').hidden = true; $('#success-panel').hidden = true; $('#invoice-form').hidden = false;
  $('#invoice-badge').textContent = 'Review your draft'; $('#client-name').value = invoice.clientName; $('#client-email').value = invoice.clientEmail; $('#invoice-note').value = invoice.note;
  $('#line-items').replaceChildren(); invoice.items.forEach(addItem); if (!invoice.items.length) addItem();
  $('#warning-list').replaceChildren();
  for (const warning of invoice.warnings || []) { const li = document.createElement('li'); li.textContent = warning; $('#warning-list').append(li); }
  $('#warnings').hidden = !(invoice.warnings?.length);
  currencyNeedsConfirmation = invoice.currency !== 'USD'; $('#currency-confirm-wrap').hidden = !currencyNeedsConfirmation; $('#currency-confirm').checked = false;
  $('#review-confirm').checked = false;
  $('#source-list').replaceChildren();
  for (const item of invoice.items) { if (item.evidence) { const quote = document.createElement('blockquote'); quote.textContent = item.evidence; $('#source-list').append(quote); } }
  $('#source-details').hidden = !$('#source-list').children.length;
  setStep(2); updateTotals();
  $('#notes-status').textContent = 'Organized with AI. Check every detail on the right.';
  if (window.innerWidth <= 720) $('.invoice-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#notes-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || uncertain) return;
  message(); setBusy(true); $('#notes-status').textContent = 'Finding the client, services, and rates in your notes…';
  try { const response = await api('/api/extract', { method: 'POST', body: JSON.stringify({ notes: $('#notes').value }) }); showDraft(response.invoice); }
  catch (error) { message(error.message); $('#notes-status').textContent = 'Your notes are still here. Resolve the issue and try again.'; }
  finally { setBusy(false); }
});

$('#add-item').addEventListener('click', () => { addItem(); invalidateConfirmation(); updateTotals(); });
['#client-name', '#client-email', '#invoice-note'].forEach(selector => $(selector).addEventListener('input', () => { invalidateConfirmation(); updateCreateButton(); }));
$('#review-confirm').addEventListener('change', updateCreateButton);
$('#currency-confirm').addEventListener('change', () => { invalidateConfirmation(); updateCreateButton(); });

function saveTab(value) { try { sessionStorage.setItem('note2invoice-attempt', JSON.stringify(value)); } catch { /* Storage can be disabled. */ } }
function clearTab() { try { sessionStorage.removeItem('note2invoice-attempt'); } catch { /* Storage can be disabled. */ } }

function showResult(invoice) {
  result = invoice;
  $('#empty-preview').hidden = true; $('#invoice-form').hidden = true; $('#success-panel').hidden = false;
  $('#invoice-badge').textContent = 'Saved to PayPal';
  $('#result-total').textContent = money(invoice.total); $('#result-status').textContent = invoice.status; $('#result-id').textContent = invoice.id; $('#result-number').textContent = invoice.invoiceNumber || '—';
  $('#verification').textContent = invoice.verified ? '✓ Verified directly with PayPal sandbox' : invoice.warning || 'Created. Refresh status to verify directly with PayPal.';
  $('#paypal-link').href = invoice.merchantUrl || 'https://www.sandbox.paypal.com/invoice/s/manage';
  $('#notes-status').textContent = 'Draft saved. No invoice was sent and no payment was taken.';
  setStep(3); saveTab({ result: invoice }); setBusy(false);
  if (window.innerWidth <= 720) $('.invoice-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#invoice-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || uncertain || $('#create-button').disabled) return;
  message(); setBusy(true, 'create');
  saveTab({ pending: true, requestId });
  try {
    const response = await api('/api/invoices', { method: 'POST', body: JSON.stringify({ invoice: readInvoice(), requestId, confirmed: $('#review-confirm').checked }) });
    showResult(response.invoice);
  } catch (error) {
    if (error.code === 'PAYPAL_UNCERTAIN' || !error.code || error.code === 'SERVER_ERROR') {
      uncertain = true;
      message(`${error.message} Check your PayPal sandbox dashboard before reloading or starting another invoice.`);
    } else { clearTab(); message(error.message); }
  } finally { setBusy(false); }
});

$('#refresh-status').addEventListener('click', async () => {
  if (!result) return; message(); $('#refresh-status').disabled = true;
  try { const response = await api(`/api/invoices/${encodeURIComponent(result.id)}`); showResult({ ...result, ...response.invoice }); }
  catch (error) { message(error.message); }
  finally { $('#refresh-status').disabled = false; }
});
$('#download-receipt').addEventListener('click', () => {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ app: 'Note2Invoice', environment: 'PayPal sandbox', ...result }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `note2invoice-${result.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#start-again').addEventListener('click', () => {
  clearTab(); result = null; draft = null; uncertain = false; requestId = crypto.randomUUID();
  $('#success-panel').hidden = true; $('#invoice-form').hidden = true; $('#empty-preview').hidden = false; $('#source-details').hidden = true;
  $('#invoice-badge').textContent = 'Waiting for notes'; $('#notes').value = ''; $('#notes-status').textContent = 'Your notes stay editable. Nothing is created yet.';
  setBusy(false); setStep(1); updateCount(); message(); $('#notes').focus();
});

$('#setup-button').addEventListener('click', () => { checkSetup(); $('#setup-dialog').showModal(); });
$('#close-setup').addEventListener('click', () => $('#setup-dialog').close());
$('#recheck-setup').addEventListener('click', checkSetup);
$('#privacy-button').addEventListener('click', () => $('#privacy-dialog').showModal());
$('#close-privacy').addEventListener('click', () => $('#privacy-dialog').close());
try {
  const saved = JSON.parse(sessionStorage.getItem('note2invoice-attempt') || 'null');
  if (saved?.result) showResult(saved.result);
  else if (saved?.pending) message('A creation attempt was interrupted. Check your PayPal sandbox invoice list before creating another draft. A draft may already exist.');
} catch { /* Ignore invalid session state. */ }
checkSetup(); setInterval(checkSetup, 10_000);
