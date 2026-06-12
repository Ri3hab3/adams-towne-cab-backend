/**
 * Google Calendar integration.
 *
 * Owner uses Google Calendar as his "phone-call notebook" — when a customer
 * calls to book, he adds an event with structured info:
 *
 *   Title:     "Cab: Anthony - EWR"
 *   Start:     Sunday 2:30 PM
 *   End:       Sunday 3:30 PM
 *   Location:  "317 Wastena Terr, Ridgewood NJ → EWR Terminal C"
 *   Description (free-form, system parses):
 *     PHONE: (914) 555-0142
 *     EMAIL: a.constantinople@email.com
 *     FROM:  317 Wastena Terr, Ridgewood NJ
 *     TO:    EWR Terminal C
 *     FARE:  68.50
 *
 * Sync strategies:
 *   1. Scheduled polling (every 60s via node-cron) - reliable, simple
 *   2. Push notifications (Google webhooks) - real-time, more setup
 *
 * Both are implemented. Polling is default; webhook is opt-in.
 *
 * Owner does one-time OAuth: GET /auth/google → grants calendar.readonly
 * Refresh token stored in tokens/google.json
 */
const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const cron = require('node-cron');
const db = require('./db');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const EVENT_PREFIX = process.env.CALENDAR_EVENT_PREFIX || 'Cab:';

const TOKEN_FILE = path.join(__dirname, '..', 'tokens', 'google.json');

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

const isMock = () => !CLIENT_ID || !CLIENT_SECRET;

function getOAuth2Client() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function getAuthUrl() {
  const oAuth2 = getOAuth2Client();
  return oAuth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force refresh_token issuance
    scope: SCOPES,
  });
}

async function handleOAuthCallback(code) {
  const oAuth2 = getOAuth2Client();
  const { tokens } = await oAuth2.getToken(code);
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  return true;
}

async function getAuthedClient() {
  let tokens;
  try {
    tokens = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
  } catch {
    throw new Error('Google Calendar not connected. Visit /auth/google once to authorize.');
  }
  const oAuth2 = getOAuth2Client();
  oAuth2.setCredentials(tokens);

  // Auto-refresh handling: googleapis client refreshes automatically when token expires.
  // Persist new tokens when refreshed.
  oAuth2.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await fs.writeFile(TOKEN_FILE, JSON.stringify(merged, null, 2));
  });

  return oAuth2;
}

/**
 * Pull recent events from calendar, parse them, sync to rides DB.
 * Looks at events from 2 days ago through 14 days from now.
 */
async function syncRecentEvents() {
  if (isMock()) {
    console.log('[MOCK Calendar] Skipping sync (no credentials)');
    return { mock: true, events: 0, ridesCreated: 0, ridesUpdated: 0 };
  }

  const auth = await getAuthedClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const timeMin = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });

  const events = res.data.items || [];
  const cabEvents = events.filter(e => (e.summary || '').startsWith(EVENT_PREFIX));

  let ridesCreated = 0;
  let ridesUpdated = 0;
  const errors = [];

  for (const evt of cabEvents) {
    try {
      const result = await syncOneEvent(evt);
      if (result.created) ridesCreated++;
      else if (result.updated) ridesUpdated++;
    } catch (err) {
      errors.push({ eventId: evt.id, summary: evt.summary, error: err.message });
    }
  }

  console.log(`Calendar sync: ${cabEvents.length} events, ${ridesCreated} created, ${ridesUpdated} updated`);
  return { events: cabEvents.length, ridesCreated, ridesUpdated, errors };
}

/**
 * Parse a single Google Calendar event into a ride record.
 * Tries to match an existing customer by phone/email/name; creates if new.
 */
async function syncOneEvent(evt) {
  const parsed = parseEvent(evt);

  // Find or create customer
  const customer = await db.findOrCreateCustomer({
    name: parsed.customerName,
    phone: parsed.phone,
    email: parsed.email,
  });

  // Check if this event already has a corresponding ride
  const allRides = await db.listRides();
  const existing = allRides.find(r => r.calendarEventId === evt.id);

  const rideData = {
    customerId: customer.id,
    calendarEventId: evt.id,
    dateISO: parsed.dateISO,
    time: parsed.time,
    from: parsed.from,
    to: parsed.to,
    fare: parsed.fare,
    driver: parsed.driver || 'Tom Adams',
    source: 'calendar',
    summary: evt.summary,
  };

  if (existing) {
    // Update if status is still 'scheduled' (don't disturb in-progress or paid rides)
    if (existing.status === 'scheduled') {
      await db.updateRide(existing.id, rideData);
      return { updated: true, rideId: existing.id };
    }
    return { unchanged: true, rideId: existing.id };
  } else {
    const newRide = await db.createRide({ ...rideData, status: 'scheduled' });
    return { created: true, rideId: newRide.id };
  }
}

function parseEvent(evt) {
  const summary = evt.summary || '';
  const description = evt.description || '';
  const location = evt.location || '';

  // Extract customer name from "Cab: Anthony - EWR" or "Cab: Anthony Constantinople"
  let customerName = summary.replace(EVENT_PREFIX, '').trim();
  // If there's a " - " separator, name is before it
  if (customerName.includes(' - ')) {
    customerName = customerName.split(' - ')[0].trim();
  }

  // Parse description for structured fields
  const fields = {};
  description.split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z]+)\s*:\s*(.+?)\s*$/);
    if (m) fields[m[1].toUpperCase()] = m[2].trim();
  });

  // Date/time from event start
  const start = evt.start.dateTime || evt.start.date;
  const startDate = new Date(start);
  const dateISO = startDate.toISOString().slice(0, 10);
  const time = startDate.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  // From/To: check description first, then location
  let from = fields.FROM || '';
  let to = fields.TO || '';
  if (!from && !to && location.includes('→')) {
    [from, to] = location.split('→').map(s => s.trim());
  } else if (!from && !to && location.includes('->')) {
    [from, to] = location.split('->').map(s => s.trim());
  }

  return {
    customerName,
    phone: fields.PHONE || fields.PH || '',
    email: fields.EMAIL || '',
    dateISO,
    time,
    from: from || location,
    to: to || '',
    fare: parseFloat(fields.FARE || fields.PRICE || '0') || 0,
    driver: fields.DRIVER || 'Tom Adams',
  };
}

/**
 * Schedule periodic sync every 60 seconds.
 * Called from server.js on startup if not in mock mode.
 */
function startScheduledSync() {
  // Every minute
  cron.schedule('* * * * *', async () => {
    try {
      await syncRecentEvents();
    } catch (err) {
      console.error('Scheduled calendar sync error:', err.message);
    }
  });
  console.log('Calendar sync scheduled (every 60s)');
}

function status() {
  if (isMock()) return 'MOCK (no Google credentials)';
  return `LIVE (calendar: ${CALENDAR_ID}, prefix: "${EVENT_PREFIX}")`;
}

module.exports = {
  getAuthUrl,
  handleOAuthCallback,
  syncRecentEvents,
  startScheduledSync,
  isMock,
  status,
};
