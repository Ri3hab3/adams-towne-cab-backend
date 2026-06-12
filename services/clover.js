/**
 * Clover REST API integration
 *
 * Two modes:
 *   - MOCK: when no API token configured, returns fake successful charges
 *   - LIVE: makes real API calls to Clover sandbox or production
 *
 * Key Clover API endpoints used:
 *   POST /v3/merchants/{mId}/orders            — create order
 *   POST /v3/merchants/{mId}/orders/{oId}/line_items  — add line items
 *   POST /v3/merchants/{mId}/orders/{oId}/payments    — charge customer's card-on-file
 *
 * For card-on-file (token-based) charges, the customer must have been
 * tokenized via /v3/merchants/{mId}/customers/{cId}/cards first (one-time setup).
 *
 * Docs: https://docs.clover.com/reference/payments-overview
 */
const axios = require('axios');

const API_TOKEN = process.env.CLOVER_API_TOKEN;
const MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
const CLOVER_ENV = process.env.CLOVER_ENV || 'sandbox';

const BASE_URL = CLOVER_ENV === 'production'
  ? 'https://api.clover.com'
  : 'https://apisandbox.dev.clover.com';

const isMock = () => !API_TOKEN || !MERCHANT_ID;

const httpClient = () => axios.create({
  baseURL: `${BASE_URL}/v3/merchants/${MERCHANT_ID}`,
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

/**
 * Charge a customer using their saved card-on-file (token).
 * Flow: create order → add line item → charge via stored tokenized card
 */
async function chargeCustomer({ customerToken, amount, currency = 'USD', description, rideId }) {
  if (isMock()) {
    console.log(`[MOCK] Charging customer ${customerToken} for $${amount.toFixed(2)}`);
    await sleep(800);
    return {
      ok: true,
      mock: true,
      paymentId: 'MOCK_' + Math.random().toString(36).slice(2, 12).toUpperCase(),
      orderId: 'MOCK_ORD_' + Math.random().toString(36).slice(2, 10).toUpperCase(),
      amount: amount,
      currency,
      cardLast4: '7034',
      cardBrand: 'AMEX',
      timestamp: new Date().toISOString(),
    };
  }

  const http = httpClient();
  const amountCents = Math.round(amount * 100);

  try {
    // 1. Create order
    const orderRes = await http.post('/orders', {
      title: description || `Ride ${rideId}`,
      currency,
      state: 'open',
      note: description,
    });
    const orderId = orderRes.data.id;

    // 2. Add line item
    await http.post(`/orders/${orderId}/line_items`, {
      name: description || 'Cab Service',
      price: amountCents,
    });

    // 3. Charge customer's tokenized card
    // Note: this assumes customerToken is a Clover card token (from /customers/{id}/cards)
    const paymentRes = await http.post(`/orders/${orderId}/payments`, {
      amount: amountCents,
      currency,
      tokenized: true,
      cardToken: customerToken,
    });

    return {
      ok: true,
      mock: false,
      paymentId: paymentRes.data.id,
      orderId,
      amount,
      currency,
      cardLast4: paymentRes.data.cardTransaction?.last4 || '',
      cardBrand: paymentRes.data.cardTransaction?.cardType || '',
      timestamp: new Date().toISOString(),
      raw: paymentRes.data,
    };
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Clover charge failed:', detail);
    throw new Error(`Clover charge failed: ${err.response?.data?.message || err.message}`);
  }
}

/**
 * Create a Clover customer record + tokenize their card.
 * Called once when a new customer's card is added.
 */
async function createCustomerWithCard({ name, phone, email, cardNumber, expMonth, expYear, cvv }) {
  if (isMock()) {
    return {
      ok: true,
      mock: true,
      customerId: 'MOCK_CUST_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      cardToken: 'MOCK_TOK_' + Math.random().toString(36).slice(2, 12).toUpperCase(),
    };
  }

  const http = httpClient();
  try {
    const custRes = await http.post('/customers', {
      firstName: name.split(' ')[0],
      lastName: name.split(' ').slice(1).join(' '),
      phoneNumbers: phone ? [{ phoneNumber: phone }] : undefined,
      emailAddresses: email ? [{ emailAddress: email }] : undefined,
    });
    const customerId = custRes.data.id;

    // NOTE: Real card tokenization usually goes through Clover's hosted payment page
    // (PCI-safe). Direct card-on-file via raw card numbers is restricted.
    // For now, return placeholder — real flow uses Clover Hosted Iframe or Ecomm SDK.

    return { ok: true, customerId, cardToken: null,
             note: 'Tokenize via Hosted Payment Page, then attach to customer' };
  } catch (err) {
    throw new Error(`Create customer failed: ${err.response?.data?.message || err.message}`);
  }
}

function status() {
  if (isMock()) return 'MOCK (no API token configured)';
  return `LIVE (${CLOVER_ENV})`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = {
  chargeCustomer,
  createCustomerWithCard,
  isMock,
  status,
};
