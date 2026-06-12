/**
 * Simple JSON-file based database.
 *
 * For production at this scale (1 owner, ~50 customers, ~30 rides/day),
 * a single JSON file is plenty. No SQL setup needed.
 *
 * Migration path: when scale demands it, swap this module for Postgres/Supabase
 * with identical method signatures.
 *
 * Data layout: /data/db.json
 *   {
 *     "customers": { "CUST-001": {...}, ... },
 *     "rides":     [ {...}, ... ],
 *     "counters":  { "customer": 1, "ride": 2606 }
 *   }
 */
const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let cache = null;
let writeQueue = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(DB_FILE, 'utf8');
    cache = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      cache = seedData();
      await persist();
    } else {
      throw err;
    }
  }
  return cache;
}

function seedData() {
  return {
    customers: {
      'CUST-001': {
        id: 'CUST-001',
        name: 'Anthony Constantinople',
        phone: '+19145550142',
        email: 'a.constantinople@email.com',
        address: '317 Wastena Terr.',
        cityState: 'Ridgewood, NJ 07450',
        cloverCustomerId: null,
        cloverToken: null,
        cardLast4: '7034',
        cardBrand: 'AMEX',
        createdAt: new Date().toISOString(),
      },
    },
    rides: [
      {
        id: 'R-2606',
        customerId: 'CUST-001',
        date: 'Today',
        dateISO: new Date().toISOString().slice(0, 10),
        time: '2:30 PM',
        from: '317 Wastena Terr, Ridgewood NJ',
        to: 'EWR Terminal C',
        fare: 68.50,
        status: 'scheduled',
        driver: 'Tom Adams',
        source: 'manual',
        createdAt: new Date().toISOString(),
      },
    ],
    counters: { customer: 1, ride: 2606 },
  };
}

async function persist() {
  // Queue writes to avoid races
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DB_FILE, JSON.stringify(cache, null, 2));
  });
  return writeQueue;
}

// ===== Customers =====

async function listCustomers() {
  const db = await load();
  return Object.values(db.customers);
}

async function getCustomer(id) {
  const db = await load();
  return db.customers[id] || null;
}

async function upsertCustomer(input) {
  const db = await load();
  let id = input.id;
  if (!id) {
    db.counters.customer += 1;
    id = 'CUST-' + String(db.counters.customer).padStart(3, '0');
  }
  const existing = db.customers[id] || {};
  db.customers[id] = {
    ...existing,
    ...input,
    id,
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString(),
  };
  await persist();
  return db.customers[id];
}

async function findOrCreateCustomer(input) {
  const db = await load();
  if (input.id && db.customers[input.id]) return db.customers[input.id];

  // Match by phone or email
  const customers = Object.values(db.customers);
  const found = customers.find(c => {
    if (input.phone && c.phone && normalizePhone(c.phone) === normalizePhone(input.phone)) return true;
    if (input.email && c.email && c.email.toLowerCase() === input.email.toLowerCase()) return true;
    if (input.name && c.name && c.name.toLowerCase() === input.name.toLowerCase()) return true;
    return false;
  });

  if (found) return found;
  return upsertCustomer(input);
}

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

// ===== Rides =====

async function listRides(dateFilter) {
  const db = await load();
  if (!dateFilter) return db.rides;
  return db.rides.filter(r => r.dateISO === dateFilter);
}

async function getRide(id) {
  const db = await load();
  return db.rides.find(r => r.id === id) || null;
}

async function createRide(input) {
  const db = await load();
  db.counters.ride += 1;
  const id = 'R-' + db.counters.ride;
  const ride = {
    ...input,
    id,
    status: input.status || 'scheduled',
    createdAt: new Date().toISOString(),
  };
  db.rides.push(ride);
  await persist();
  return ride;
}

async function updateRide(id, updates) {
  const db = await load();
  const idx = db.rides.findIndex(r => r.id === id);
  if (idx === -1) throw new Error(`Ride ${id} not found`);
  db.rides[idx] = { ...db.rides[idx], ...updates, updatedAt: new Date().toISOString() };
  await persist();
  return db.rides[idx];
}

module.exports = {
  listCustomers,
  getCustomer,
  upsertCustomer,
  findOrCreateCustomer,
  listRides,
  getRide,
  createRide,
  updateRide,
};
