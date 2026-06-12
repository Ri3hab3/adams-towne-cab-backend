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

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// --- Health check ---
app.get('/', (req, res) => {
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

  // Start scheduled calendar sync if not in mock
  if (!calendar.isMock()) {
    calendar.startScheduledSync();
  }
});
