# Note2Invoice

**Turn rough freelance work notes into reviewed PayPal invoice drafts.**

[Open the live demo](https://note2invoice.vercel.app/)

Paste what you worked on. AI extracts the client, services, quantities, and prices. Review and edit the result, confirm the details, then create a real draft in the PayPal sandbox. The app retrieves the invoice from PayPal to verify its ID and status.


## Run locally

Requirements:
- Nodejs
-  PayPal sandbox credentials
- Meta AI API key. 

P.S: There are no npm dependencies or build steps.


```sh
cp .env.example .env
# Fill in the credentials in .env, then:
npm start
```

Then open **http://localhost:3000**.

## Deploy to Vercel

Import this repository with its root directory set to `.`. Leave Build Command and Output Directory unset. The exported Node.js server is the entrypoint; `vercel.json` includes the frontend files and allows 120 seconds for upstream requests. Node.js is pinned to 22.x.

In **Project Settings → Environment Variables**, add `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_EMAIL`, `AI_PROVIDER=meta`, and `AI_API_KEY` for Production (and Preview if needed), then redeploy. `AI_MODEL` and `AI_BASE_URL` are optional. Do not upload `.env` or put keys in `public/`. `/api/health` reports only configuration presence, never credentials.

The hosted version accepts HTTPS requests for the deployment, branch, and production domains supplied by Vercel. This is a shared sandbox demo: visitors use the owner's AI credits and sandbox merchant account. Use fictional data. For restricted access, configure Vercel Deployment Protection; authenticated users, per-user credentials, and durable usage limits are outside this prototype.

Vercel's filesystem is read-only except for temporary storage. Hosted operation records are cached in `/tmp` and can disappear between instances. Each logical creation has a stable `PayPal-Request-Id` and invoice number, so [PayPal's idempotency protection](https://developer.paypal.com/invoicing/troubleshooting#duplicate-invoices-from-retried-requests) also applies across instances. Never automatically retry an uncertain creation; inspect the sandbox dashboard first. Local runs retain the durable `.local/operations/` ledger.


### PayPal

1. Sign into the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/).
2. Open **Apps & Credentials**, select **Sandbox**, and create or use a sandbox app.
3. Put its Client ID and Secret in `.env`.
4. Under **Testing Tools → Sandbox Accounts**, find the **business account associated with that app**. Put its email in `PAYPAL_MERCHANT_EMAIL`. This is a sandbox address, not necessarily your real PayPal login email.
5. Make sure the app/account can use Invoicing. If PayPal returns a permission error, check its Invoicing permission in the dashboard.

The API host is hardcoded to `https://api-m.sandbox.paypal.com`. There is no live mode. Use generated sandbox credentials to log into the [sandbox merchant dashboard](https://www.sandbox.paypal.com/invoice/s/manage).

Official reference: [Sandbox setup](https://github.com/paypaldev/getting-started-with-paypal-sandbox), [Create a draft](https://developer.paypal.com/api/invoicing/v2/invoices-create), [Read an invoice](https://developer.paypal.com/api/invoicing/v2/invoices-get).

### AI

The primary integration is **Meta Model API** at [dev.meta.ai](https://dev.meta.ai/), using `muse-spark-1.3` by default. Set `AI_PROVIDER=meta`, paste your key into `AI_API_KEY`, and leave `AI_BASE_URL` blank. `AI_MODEL` can be left blank to use the default or set to a model your account supports.

Meta requests use a developer instruction and a JSON schema to extract invoice fields. [Meta structured output documentation](https://dev.meta.ai/docs/structured-output).

The app also includes adapters for OpenAI (`AI_PROVIDER=openai`), Gemini (`gemini`), and Anthropic (`anthropic`). Defaults are defined in `lib/config.mjs`; set `AI_MODEL` if your account requires a different model. OpenAI-compatible services can use `AI_PROVIDER=openai` plus an HTTPS `AI_BASE_URL` ending in `/v1` and a model that supports JSON-schema output. These alternate providers require their own credentials and have not all been tested against live services.

The status indicator only reports whether configuration values are present. Successful extraction and creation verify the credentials with their services.

## Judge's walkthrough

1. Open the [hosted demo](https://note2invoice.vercel.app/), or run `npm start` with your own sandbox and AI credentials configured above.
2. Select **Design project** to insert fictional example notes.
3. Select **Extract invoice details**. The notes are sent to the configured model; this is not a canned parsing response.
4. Verify two lines: website redesign, 6 × $40; hosting setup, 1 × $30. Expected total: **$270.00 USD**.
5. Edit any field as needed, then check **I've checked the client, line items, and total**.
6. Select **Create PayPal draft**. The result should show the PayPal invoice ID, `DRAFT` status, and a verification message after the read request succeeds.
7. Use **Open PayPal sandbox** to view the merchant account, or **Refresh status** to retrieve the invoice again.
8. For a second demonstration, select **Start another invoice → Missing a rate → Extract invoice details**. The revision rate should be empty and creation disabled until it is supplied and the invoice reviewed. AI output can vary; always check it.

The client email in the sample is fictional. No email is sent because the application never calls the send-invoice endpoint. The hosted demo uses the owner's sandbox account; local runs use the credentials you configure.

## What the AI does

- Extracts structured client and line-item information from prose.
- Includes a source phrase for each item so the user can compare it with the notes.
- Is instructed to leave missing values blank and flag ambiguous or unsupported details.
- Does not calculate authoritative totals or invoke PayPal. Server validation and user confirmation are separate from the model.

AI can still misread notes. Schema validation guarantees shape, not factual accuracy. The user must review extracted amounts. `$` alone is treated as ambiguous; USD must be confirmed when the notes do not explicitly identify it. Other currencies are not automatically converted.

## Implementation

```text
Browser notes
    ↓ POST /api/extract
Node server → Meta Model API → structured invoice fields
    ↓
Editable review + explicit confirmation
    ↓ POST /api/invoices
Node server → PayPal OAuth → create draft → retrieve invoice
    ↓
PayPal invoice ID, status, total, and downloadable result record
```

The app uses Node.js built-ins, plain JavaScript, HTML, and CSS. Server code is in `server.mjs` and `lib/`; browser assets are in `public/`. No external UI packages, fonts, or analytics are loaded.

Amounts are calculated using integer hundredths and rounded per line. Server-side validation rejects missing prices, unsupported currencies, invalid email addresses, and invalid totals. Requests are capped at 32 KB; notes at 8,000 characters and invoices at 20 items. Amounts over $1,000,000 are unsupported.

A local operation record in `.local/operations/` prevents the same creation request from being submitted twice, including across server restarts. Concurrent identical requests share a result. If a write times out, the app does not automatically retry it: check the sandbox invoice list to avoid creating a duplicate. This is request deduplication, not multi-user billing infrastructure.

## Data and prototype limits

- Local runs bind to loopback and reject foreign Host/Origin headers. Vercel runs allow the project's HTTPS origins and remain a shared sandbox prototype, not a multi-user billing service.
- Notes are sent to the selected AI provider. Reviewed invoice details are sent to PayPal sandbox.
- The app does not persist raw notes. Local operation files contain a request hash and result metadata; the browser tab keeps the last creation-attempt marker and result. PayPal and the AI provider apply their own data policies.
- Supported scope: English notes, USD, line items, and an optional note. Taxes, discounts, due dates, attachments, sending, payment capture, and multi-user access are outside this version.
- A created draft is not a sent invoice and is not proof of payment.

## Verification

```sh
npm run check
```

This runs JavaScript syntax checks and Node's built-in tests for money calculation, invalid data, missing fields, structured extraction, API errors, sandbox requests, write deduplication, uncertain responses, confirmation, and secret-file access. Automated tests inject simulated provider responses and require no credentials. They do not establish that your real credentials work.

`node test/fixture-server.mjs` serves a separate **UI test fixture** at `http://localhost:3001`. It never contacts AI or PayPal. It exists only for interface testing and must not be represented as a real integration or used for the submission video. The real app is `npm start` on port 3000.

## Troubleshooting

- **AI key rejected:** Check `AI_PROVIDER`, `AI_API_KEY`, model access, and API credits.
- **PayPal authentication rejected:** Use the Client ID and Secret from the same sandbox app, not live keys.
- **Invoicing permission error:** Check Invoicing access and the business sandbox account associated with the app.
- **Creation outcome uncertain:** Inspect PayPal sandbox invoices before creating a new draft. The invoice number begins with `N2I-`.
- **Created but not verified:** The creation succeeded but the follow-up read failed. Select **Refresh status**; do not create another invoice just to verify it.
- **Port in use:** Change `PORT` in `.env` and restart.


## License

MIT. See [LICENSE](LICENSE).
