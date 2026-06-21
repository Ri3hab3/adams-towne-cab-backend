/**
 * Adams' Towne Car & Limo — Backend Server
 *
 * Architecture:
 *   HTML page (microtechlabs.io/cab-demo) → fetch() → THIS BACKEND
 *
 * Endpoints:
 *   POST /api/booking          — create new ride
 *   POST /api/ride/start       — mark ride as in-progress
 *   POST /api/ride/finish      — finish ride: charge card, update Excel, send emails
 *   POST /api/charge           — charge a customer manually (one-off)
 *   GET  /api/customers        — list customers
 *   GET  /api/rides            — list today's rides
 *   GET  /api/calendar/sync    — pull events from Google Calendar
 *   POST /api/calendar/webhook — Google Calendar push notification (real-time sync)
 *   GET  /auth/google          — OAuth flow for calendar
 *   GET  /auth/microsoft       — OAuth flow for OneDrive
 *
 * Mock mode: when NODE_ENV=development AND no real keys are set,
 * all external services return fake success. Lets the prototype work
 * without real Clover/OneDrive/Resend setup.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const clover = require('./services/clover');
const onedrive = require('./services/onedrive');
const email = require('./services/email');
const excel = require('./services/excel');
const calendar = require('./services/calendar');
const db = require('./services/db');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// --- Root: serve the charge page ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'charge.html'));
});

// --- Health check / status JSON ---
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    service: 'Adams Towne Car & Limo backend',
    version: '1.0.0',
    mode: clover.isMock() ? 'mock' : 'production',
    services: {
      clover: clover.status(),
      onedrive: onedrive.status(),
      email: email.status(),
      calendar: calendar.status(),
    },
  });
});

// ===========================================================
// CUSTOMERS
// ===========================================================
app.get('/api/customers', async (req, res) => {
  try {
    const customers = await db.listCustomers();
    res.json({ ok: true, customers });
  } catch (err) {
    console.error('GET /api/customers error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/customers', async (req, res) => {
  try {
    const customer = await db.upsertCustomer(req.body);
    res.json({ ok: true, customer });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===========================================================
// RIDES
// ===========================================================
app.get('/api/rides', async (req, res) => {
  try {
    const { date } = req.query;
    const rides = await db.listRides(date);
    res.json({ ok: true, rides });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/booking', async (req, res) => {
  try {
    const { customer, ride } = req.body;
    // Match or create customer
    const cust = await db.findOrCreateCustomer(customer);
    // Create ride
    const newRide = await db.createRide({ ...ride, customerId: cust.id });
    res.json({ ok: true, ride: newRide, customer: cust });
  } catch (err) {
    console.error('POST /api/booking error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/ride/start', async (req, res) => {
  try {
    const { rideId } = req.body;
    const ride = await db.updateRide(rideId, { status: 'driving', startedAt: new Date().toISOString() });
    res.json({ ok: true, ride });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * THE CRITICAL ENDPOINT — runs the full automation chain:
 *  1. Charge Clover
 *  2. Update Excel on OneDrive
 *  3. Email customer + owner
 *  4. Mark ride paid in DB
 */
app.post('/api/ride/finish', async (req, res) => {
  const { rideId, customAmount } = req.body;
  let ride, customer;
  const steps = [];

  try {
    ride = await db.getRide(rideId);
    if (!ride) throw new Error(`Ride ${rideId} not found`);
    customer = await db.getCustomer(ride.customerId);
    if (!customer) throw new Error(`Customer ${ride.customerId} not found`);

    const amount = customAmount || ride.fare;

    // --- Step 1: Charge via Clover ---
    steps.push({ step: 'charge', status: 'pending' });
    const chargeResult = await clover.chargeCustomer({
      customerToken: customer.cloverToken,
      amount: amount,
      currency: 'USD',
      description: `Ride ${ride.id}: ${ride.from} → ${ride.to}`,
      rideId: ride.id,
    });
    steps[0] = { step: 'charge', status: 'ok', data: chargeResult };

    // --- Step 2: Update Excel on OneDrive ---
    steps.push({ step: 'excel', status: 'pending' });
    const excelResult = await onedrive.appendRideToInvoice({
      customer,
      ride: { ...ride, fare: amount, paid: true, paymentId: chargeResult.paymentId },
    });
    steps[1] = { step: 'excel', status: 'ok', data: excelResult };

    // --- Step 3: Send confirmation emails ---
    steps.push({ step: 'email', status: 'pending' });
    const emailResult = await email.sendRideConfirmation({
      customer,
      ride: { ...ride, fare: amount, paymentId: chargeResult.paymentId, orderId: chargeResult.orderId },
      attachInvoice: excelResult.fileBuffer,
      invoiceFilename: excelResult.filename,
    });
    steps[2] = { step: 'email', status: 'ok', data: emailResult };

    // --- Step 4: Update ride status in DB ---
    const updatedRide = await db.updateRide(rideId, {
      status: 'paid',
      paidAt: new Date().toISOString(),
      paymentId: chargeResult.paymentId,
      orderId: chargeResult.orderId,
      cardLast4: chargeResult.cardLast4,
      invoiceFilePath: excelResult.filePath,
      emailMessageId: emailResult.messageId,
    });

    res.json({
      ok: true,
      ride: updatedRide,
      payment: chargeResult,
      invoice: { path: excelResult.filePath, url: excelResult.webUrl },
      email: { messageId: emailResult.messageId, sentTo: [customer.email, process.env.OWNER_EMAIL] },
      steps,
    });

  } catch (err) {
    console.error('POST /api/ride/finish error:', err);
    // Mark last attempted step as failed
    if (steps.length > 0) steps[steps.length - 1].status = 'failed';
    steps[steps.length - 1].error = err.message;
    res.status(500).json({
      ok: false,
      error: err.message,
      steps,
      hint: 'Check backend logs. Ride state in DB has NOT been modified.',
    });
  }
});

/**
 * Manual one-off charge (e.g., backlog charging)
 * No ride record involved — just charge a customer for a stated amount
 */
app.post('/api/charge', async (req, res) => {
  try {
    const { customerId, amount, description } = req.body;
    const customer = await db.getCustomer(customerId);
    if (!customer) throw new Error('Customer not found');

    const chargeResult = await clover.chargeCustomer({
      customerToken: customer.cloverToken,
      amount,
      description: description || 'Manual charge',
    });

    res.json({ ok: true, payment: chargeResult });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===========================================================
// CALENDAR
// ===========================================================

/**
 * Pull recent events from Google Calendar and sync to DB
 * Owner can also trigger this manually from the UI
 */
app.get('/api/calendar/sync', async (req, res) => {
  try {
    const result = await calendar.syncRecentEvents();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Calendar sync error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Google Calendar push notification webhook
 * Google calls this URL whenever the watched calendar changes
 */
app.post('/api/calendar/webhook', async (req, res) => {
  const channelId = req.headers['x-goog-channel-id'];
  const resourceState = req.headers['x-goog-resource-state'];
  console.log(`Calendar webhook: ${resourceState} (channel ${channelId})`);

  // Respond immediately — Google retries if we delay
  res.status(200).send('OK');

  // Sync in background
  if (resourceState === 'exists') {
    calendar.syncRecentEvents().catch(err => console.error('Background sync failed:', err));
  }
});

/**
 * One-time setup — owner clicks this link to authorize Google Calendar
 */
app.get('/auth/google', (req, res) => {
  const url = calendar.getAuthUrl();
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    await calendar.handleOAuthCallback(code);
    res.send(`<h1>✓ Google Calendar connected</h1><p>You can close this window.</p>`);
  } catch (err) {
    res.status(500).send(`<h1>Auth failed</h1><pre>${err.message}</pre>`);
  }
});

// ===========================================================
// ONEDRIVE
// ===========================================================
app.get('/auth/microsoft', (req, res) => {
  const url = onedrive.getAuthUrl();
  res.redirect(url);
});

app.get('/auth/microsoft/callback', async (req, res) => {
  try {
    const { code } = req.query;
    await onedrive.handleOAuthCallback(code);
    res.send(`<h1>✓ OneDrive connected</h1><p>You can close this window.</p>`);
  } catch (err) {
    res.status(500).send(`<h1>Auth failed</h1><pre>${err.message}</pre>`);
  }
});

// ===========================================================
// INVOICE UPLOAD + BULK CHARGE
// ===========================================================
const ExcelJS = require('exceljs');
const axios = require('axios');

// Cache tender ID — only look up once, reuse forever
let cachedTenderId = null;

async function getTenderId(http) {
  if (cachedTenderId) return cachedTenderId;
  const res = await http.get('/tenders');
  const tenders = res.data?.elements || [];
  const cardTender = tenders.find(t =>
    t.label?.toLowerCase().includes('credit') ||
    t.label?.toLowerCase().includes('card')
  ) || tenders[0];
  if (!cardTender) throw new Error('No valid tender found on Clover account');
  cachedTenderId = cardTender.id;
  console.log(`Tender ID cached: ${cachedTenderId}`);
  return cachedTenderId;
}

// Helper to make Clover HTTP client
function cloverHttp() {
  const API_TOKEN = process.env.CLOVER_API_TOKEN;
  const MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
  const CLOVER_ENV = process.env.CLOVER_ENV || 'sandbox';
  if (!API_TOKEN || !MERCHANT_ID) return null;
  const BASE_URL = CLOVER_ENV === 'production'
    ? 'https://api.clover.com'
    : 'https://apisandbox.dev.clover.com';
  return axios.create({
    baseURL: `${BASE_URL}/v3/merchants/${MERCHANT_ID}`,
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 30000,
    validateStatus: () => true,
  });
}

/**
 * Search Clover customers by partial name.
 * Frontend calls this to help Tom find the right customer before charging.
 * GET /api/clover/search?q=anthony
 */
app.get('/api/clover/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ ok: true, customers: [] });

  const http = cloverHttp();
  if (!http) return res.status(400).json({ ok: false, error: 'Clover not configured' });

  try {
    // Clover doesn't have a "search by any field" so we try firstName then lastName
    const tryQueries = [
      `firstName=${q}`,
      `lastName=${q}`,
    ];
    const seen = new Set();
    const matches = [];
    for (const filter of tryQueries) {
      const r = await http.get('/customers', {
        params: { filter, expand: 'cards,emailAddresses,phoneNumbers', limit: 20 },
      });
      if (r.status === 200) {
        for (const c of r.data?.elements || []) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          matches.push({
            id: c.id,
            firstName: c.firstName || '',
            lastName: c.lastName || '',
            fullName: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
            email: (c.emailAddresses?.elements?.[0]?.emailAddress) || '',
            phone: (c.phoneNumbers?.elements?.[0]?.phoneNumber) || '',
            hasCard: (c.cards?.elements || []).length > 0,
            cardLast4: c.cards?.elements?.[0]?.last4 || '',
            cardBrand: c.cards?.elements?.[0]?.cardType || '',
          });
        }
      }
    }
    res.json({ ok: true, customers: matches });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Charge by Clover customer ID using Ecommerce API.
 * Card tokenType is MULTIPAY — card.id is the multi-pay token used as source.
 */
app.post('/api/clover/charge-by-id', async (req, res) => {
  const { cloverCustomerId, amount, description } = req.body;
  if (!cloverCustomerId || !amount) {
    return res.status(400).json({ ok: false, error: 'Missing cloverCustomerId or amount' });
  }

  const API_TOKEN = process.env.CLOVER_API_TOKEN;
  const MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
  const CLOVER_ENV = process.env.CLOVER_ENV || 'sandbox';
  const ECOMM_PRIVATE_TOKEN = process.env.CLOVER_ECOMM_PRIVATE_TOKEN;
  if (!API_TOKEN || !MERCHANT_ID) {
    return res.status(400).json({ ok: false, error: 'Clover not configured' });
  }
  if (!ECOMM_PRIVATE_TOKEN) {
    return res.status(400).json({ ok: false, error: 'CLOVER_ECOMM_PRIVATE_TOKEN not configured' });
  }

  const ECOMM_URL = CLOVER_ENV === 'production'
    ? 'https://scl.clover.com'
    : 'https://scl-sandbox.dev.clover.com';

  const restHttp = cloverHttp();
  const ecHttp = axios.create({
    baseURL: ECOMM_URL,
    headers: {
      'Authorization': `Bearer ${ECOMM_PRIVATE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  try {
    // Step 1: Get customer's card via REST API
    const custRes = await restHttp.get(`/customers/${cloverCustomerId}`, {
      params: { expand: 'cards' },
    });
    if (custRes.status !== 200) {
      throw new Error(`Customer lookup failed (${custRes.status}): ${JSON.stringify(custRes.data).slice(0, 200)}`);
    }
    const customer = custRes.data;
    const cards = customer.cards?.elements || [];
    if (cards.length === 0) {
      return res.json({ ok: false, error: 'No card on file for this customer' });
    }

    // card.id IS the MULTIPAY token — use it directly as source
    const card = cards[0];
    const cardSource = card.id;

    const amountCents = Math.round(parseFloat(amount) * 100);
    const desc = description || `Adams' Towne Car & Limo`;

    // Step 2: Charge via Ecommerce API using MULTIPAY token as source
    const chargeRes = await ecHttp.post('/v1/charges', {
      amount: amountCents,
      currency: 'usd',
      source: cardSource,
      description: desc,
      capture: true,
      stored_credentials: {
        sequence: 'subsequent',
        initiator: 'merchant',
        is_scheduled: false,
      },
    });

    console.log('Ecommerce charge response:', chargeRes.status, JSON.stringify(chargeRes.data).slice(0, 300));

    if (chargeRes.status >= 400) {
      throw new Error(`Charge failed (${chargeRes.status}): ${JSON.stringify(chargeRes.data).slice(0, 300)}`);
    }

    const charge = chargeRes.data;
    if (charge.status === 'failed' || charge.outcome?.type === 'issuer_declined') {
      throw new Error(`Card declined: ${charge.outcome?.seller_message || charge.failure_message || 'Unknown reason'}`);
    }

    res.json({
      ok: true,
      payment: {
        paymentId: charge.id,
        orderId: charge.order || '',
        amount: parseFloat(amount),
        cardLast4: charge.source?.last4 || card.last4 || '',
        cardBrand: charge.source?.brand || card.cardType || '',
        customerName: `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
      },
    });
  } catch (err) {
    console.error('charge-by-id error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

/**
 * Parse uploaded Excel invoices. Returns array of {file, customerName, invoiceNumber, amount, parseError}
 * Reads cells: C6 (customer), H4 (invoice #), H38 (current total)
 */
app.post('/api/invoices/parse', upload.array('files', 50), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, error: 'No files uploaded' });
    }

    const results = [];
    for (const file of req.files) {
      const parsed = { file: file.originalname };
      try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(file.buffer);
        const ws = wb.worksheets[0];
        const cellValue = (coord) => {
          const v = ws.getCell(coord).value;
          if (v && typeof v === 'object' && 'result' in v) return v.result;
          return v;
        };

        const customerRaw = cellValue('C6');
        const invoiceNumber = cellValue('H4');
        const currentTotal = cellValue('H38');

        if (!customerRaw) throw new Error('Missing customer name (C6)');
        if (currentTotal === null || currentTotal === undefined) throw new Error('Missing CURRENT TOTAL (H38)');
        const amount = parseFloat(currentTotal);
        if (isNaN(amount) || amount <= 0) throw new Error(`Invalid total: ${currentTotal}`);

        // Normalize "LAST, First" → "First Last"
        const raw = String(customerRaw).trim();
        let normalized = raw;
        if (raw.includes(',')) {
          const [last, first] = raw.split(',').map(s => s.trim());
          normalized = `${first} ${last}`.replace(/\s+/g, ' ').trim();
        }

        parsed.customerName = normalized;
        parsed.customerNameRaw = raw;
        parsed.invoiceNumber = invoiceNumber ? String(invoiceNumber) : '';
        parsed.amount = amount;
        parsed.status = 'pending';
        parsed.selected = true;
      } catch (err) {
        parsed.parseError = err.message;
        parsed.status = 'error';
      }
      results.push(parsed);
    }

    res.json({ ok: true, invoices: results });
  } catch (err) {
    console.error('parse error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Charge one customer via Clover.
 * Flow: search customer by name → find card on file → create order → charge.
 */
app.post('/api/invoices/charge', async (req, res) => {
  const { customerName, amount, invoiceNumber } = req.body;
  if (!customerName || !amount) {
    return res.status(400).json({ ok: false, error: 'Missing customerName or amount' });
  }

  const API_TOKEN = process.env.CLOVER_API_TOKEN;
  const MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
  const CLOVER_ENV = process.env.CLOVER_ENV || 'sandbox';
  if (!API_TOKEN || !MERCHANT_ID) {
    return res.status(400).json({ ok: false, error: 'Clover not configured (missing CLOVER_API_TOKEN or CLOVER_MERCHANT_ID)' });
  }

  const BASE_URL = CLOVER_ENV === 'production'
    ? 'https://api.clover.com'
    : 'https://apisandbox.dev.clover.com';

  const http = axios.create({
    baseURL: `${BASE_URL}/v3/merchants/${MERCHANT_ID}`,
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 30000,
    validateStatus: () => true,
  });

  try {
    const parts = customerName.trim().split(/\s+/);
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ');

    // 1. Search for customer
    const searchRes = await http.get('/customers', {
      params: {
        filter: `firstName=${firstName}&lastName=${lastName}`,
        expand: 'cards,emailAddresses,phoneNumbers',
        limit: 10,
      },
    });
    if (searchRes.status !== 200) {
      throw new Error(`Customer search failed (${searchRes.status}): ${JSON.stringify(searchRes.data).slice(0, 200)}`);
    }
    let elements = searchRes.data?.elements || [];

    // Fallback: search by firstName only and match full name
    if (elements.length === 0) {
      const r2 = await http.get('/customers', {
        params: { filter: `firstName=${firstName}`, expand: 'cards', limit: 30 },
      });
      elements = (r2.data?.elements || []).filter(c => {
        const full = `${c.firstName || ''} ${c.lastName || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
        return full === customerName.toLowerCase();
      });
    }

    if (elements.length === 0) {
      return res.json({ ok: false, error: `Customer "${customerName}" not found in Clover` });
    }
    if (elements.length > 1) {
      const withCards = elements.filter(c => (c.cards?.elements || []).length > 0);
      if (withCards.length === 1) elements = withCards;
      else return res.json({ ok: false, error: `Multiple Clover customers match "${customerName}" (${elements.length}). Disambiguate in Clover.` });
    }

    const customer = elements[0];
    const cards = customer.cards?.elements || [];
    if (cards.length === 0) {
      return res.json({ ok: false, error: 'No card on file in Clover for this customer' });
    }
    const card = cards[0];
    // card.id IS the MULTIPAY token for remote charging
    const cardSource = card.id;
    if (!cardSource) {
      return res.json({ ok: false, error: 'Card found but no token available for remote charging.' });
    }

    // 2. Charge via Ecommerce API
    const amountCents = Math.round(parseFloat(amount) * 100);
    const description = `Invoice ${invoiceNumber || ''} — Adams' Towne Car & Limo`;
    const ECOMM_URL = (process.env.CLOVER_ENV === 'production')
      ? 'https://scl.clover.com'
      : 'https://scl-sandbox.dev.clover.com';

    const ecHttp = axios.create({
      baseURL: ECOMM_URL,
      headers: { Authorization: `Bearer ${process.env.CLOVER_ECOMM_PRIVATE_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 30000,
      validateStatus: () => true,
    });

    const chargeRes = await ecHttp.post('/v1/charges', {
      amount: amountCents,
      currency: 'usd',
      source: cardSource,
      description,
      capture: true,
      stored_credentials: {
        sequence: 'subsequent',
        initiator: 'merchant',
        is_scheduled: false,
      },
    });

    if (chargeRes.status >= 400) {
      throw new Error(`Charge failed (${chargeRes.status}): ${JSON.stringify(chargeRes.data).slice(0, 300)}`);
    }

    const charge = chargeRes.data;
    if (charge.status === 'failed' || charge.outcome?.type === 'issuer_declined') {
      throw new Error(`Card declined: ${charge.outcome?.seller_message || charge.failure_message || 'Unknown reason'}`);
    }

    res.json({
      ok: true,
      payment: {
        paymentId: charge.id,
        orderId: charge.order || '',
        amount: parseFloat(amount),
        cardLast4: charge.source?.last4 || card.last4 || '',
        cardBrand: charge.source?.brand || card.cardType || '',
      },
    });
  } catch (err) {
    console.error('charge error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ===========================================================
// START SERVER
// ===========================================================
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  Adams' Towne Car & Limo Backend                ║`);
  console.log(`║  Listening on port ${PORT}                          ║`);
  console.log(`║  Mode: ${clover.isMock() ? 'MOCK (no real charges)' : 'PRODUCTION (real charges)'}                    ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  console.log('Service status:');
  console.log(`  Clover:   ${clover.status()}`);
  console.log(`  OneDrive: ${onedrive.status()}`);
  console.log(`  Email:    ${email.status()}`);
  console.log(`  Calendar: ${calendar.status()}`);
  console.log('');

  // Pre-fetch Clover tender ID on startup (1 API call, cached for all future charges)
  const API_TOKEN = process.env.CLOVER_API_TOKEN;
  const MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
  if (API_TOKEN && MERCHANT_ID) {
    const http = cloverHttp();
    if (http) {
      getTenderId(http)
        .then(id => console.log(`  Clover tender ID cached: ${id}`))
        .catch(err => console.warn(`  Tender pre-fetch failed (will retry on first charge): ${err.message}`));
    }
  }

  // Start scheduled calendar sync if not in mock
  if (!calendar.isMock()) {
    calendar.startScheduledSync();
  }
});
