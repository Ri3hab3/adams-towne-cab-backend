# Adams' Towne Car & Limo — Backend

The backend that powers the dispatch automation for Tom Adams' livery business.

## What it does

When Tom presses **"Ride finished — charge card"** in the web app, the backend runs this chain automatically:

1. **Clover** charges the customer's saved Amex card-on-file
2. **OneDrive** opens the customer's monthly Excel invoice and appends a new ride row (PAID: YES)
3. **Resend** emails the customer + Tom with a Clover-style payment confirmation, with the updated Excel invoice attached
4. **Google Calendar** is kept in sync — new events automatically become rides

If Clover fails, nothing else runs and the DB is unchanged (atomic).

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  HTML page (microtechlabs.io/cab-demo)                        │
│  — Tom's UI: book rides, finish rides, view today's schedule  │
└────────────────┬──────────────────────────────────────────────┘
                 │  fetch()
                 ▼
┌───────────────────────────────────────────────────────────────┐
│  This Backend (Railway, Node.js)                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ POST /api/ride/finish                                   │  │
│  │   1. clover.chargeCustomer()                            │  │
│  │   2. onedrive.appendRideToInvoice()                     │  │
│  │   3. email.sendRideConfirmation()                       │  │
│  └────────────────────────────────────────────────────────┘  │
└────┬──────────────┬──────────────┬──────────────┬─────────────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
  ┌──────┐    ┌──────────┐    ┌──────────┐   ┌──────────────┐
  │Clover│    │ OneDrive │    │  Resend  │   │ Google       │
  │ API  │    │ via Graph│    │  Email   │   │ Calendar API │
  └──────┘    └──────────┘    └──────────┘   └──────────────┘
```

---

## Tech stack (short version)

- **Node.js + Express** on **Railway** (the backend itself)
- **Clover REST API** for charging cards
- **OneDrive + Microsoft Graph API** for invoice file storage
- **ExcelJS** for generating/updating the Adams' Towne format invoice
- **Resend** for sending emails (verified domain: microtechlabs.io)
- **Google Calendar API** for booking sync (every 60 seconds + webhook option)

---

## Setup checklist (one-time, for going live)

Mock mode works immediately — no setup needed. To use real services:

### 1. Clover (charging)

- [ ] In Clover dashboard: **Setup → API Tokens → Create New Token**
- [ ] Permissions: Read/Write on Customers, Orders, Payments
- [ ] Copy token into `.env` as `CLOVER_API_TOKEN`
- [ ] Copy merchant ID into `.env` as `CLOVER_MERCHANT_ID`
- [ ] Use `CLOVER_ENV=sandbox` for testing, `production` when live
- [ ] Each customer's saved card must be tokenized first (one-time, via Clover's hosted payment page)

### 2. Microsoft OneDrive (invoice storage)

- [ ] Go to [portal.azure.com](https://portal.azure.com) → Azure Active Directory → App registrations
- [ ] **New registration** named "Adams Towne Cab Backend"
- [ ] Supported account types: "Accounts in any organizational directory + personal Microsoft accounts"
- [ ] Redirect URI: `https://YOUR-RAILWAY-URL/auth/microsoft/callback` (Web platform)
- [ ] Note the **Application (client) ID** → `.env` as `MS_CLIENT_ID`
- [ ] **Certificates & secrets → New client secret** → copy value → `.env` as `MS_CLIENT_SECRET`
- [ ] **API permissions → Add a permission → Microsoft Graph → Delegated** — add `Files.ReadWrite`, `offline_access`, `User.Read`
- [ ] **Grant admin consent**
- [ ] After deploy, Tom visits `https://YOUR-RAILWAY-URL/auth/microsoft` once to grant access

### 3. Resend (emails)

- [ ] Sign up at [resend.com](https://resend.com)
- [ ] **Domains → Add Domain → microtechlabs.io**
- [ ] Add the DNS records (TXT, MX, DKIM) shown — they go in your Namecheap DNS panel
- [ ] Wait for verification (usually <10 min)
- [ ] **API Keys → Create API Key** → copy into `.env` as `RESEND_API_KEY`
- [ ] Set `FROM_EMAIL=noreply@microtechlabs.io` in `.env`

### 4. Google Calendar (booking sync)

- [ ] Go to [console.cloud.google.com](https://console.cloud.google.com)
- [ ] Create a new project: "Adams Towne Cab"
- [ ] **APIs & Services → Library → Google Calendar API → Enable**
- [ ] **APIs & Services → OAuth consent screen** → External → fill in app name + Tom's email
- [ ] **Credentials → Create Credentials → OAuth client ID → Web application**
- [ ] Authorized redirect URI: `https://YOUR-RAILWAY-URL/auth/google/callback`
- [ ] Copy Client ID → `.env` as `GOOGLE_CLIENT_ID`
- [ ] Copy Client Secret → `.env` as `GOOGLE_CLIENT_SECRET`
- [ ] After deploy, Tom visits `https://YOUR-RAILWAY-URL/auth/google` once

---

## Deploying to Railway

```bash
# 1. Push this folder to a GitHub repo
git init
git add .
git commit -m "Initial backend"
git remote add origin https://github.com/YOUR-USER/adams-towne-cab-backend.git
git push -u origin main

# 2. Connect Railway to the repo (railway.app → New Project → Deploy from GitHub)

# 3. In Railway dashboard:
#    - Variables tab → paste each line from .env.example with real values
#    - Settings → Generate Domain (gives you https://xxx.up.railway.app)
#    - Use that domain as YOUR-RAILWAY-URL in Microsoft/Google setup above

# 4. Re-deploy after adding env vars
```

---

## Local development

```bash
npm install
cp .env.example .env       # leave keys empty for mock mode
npm run dev                # starts on http://localhost:3000
```

In mock mode:
- Clover charges return fake success (no real money)
- OneDrive writes Excel files to `data/onedrive-mock/`
- Emails saved as HTML to `data/sent-emails/`
- Google Calendar sync is skipped

Once you add real keys to `.env`, mock mode automatically turns off per-service.

---

## Frontend integration

The existing HTML demo (`cab_demo.html`) calls the backend via:

```javascript
// Finish ride
await fetch(`${BACKEND_URL}/api/ride/finish`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ rideId: 'R-2606' }),
});
```

Update the HTML's `BACKEND_URL` constant to point to your Railway domain.

---

## How the calendar sync works

Tom adds an event to his Google Calendar like:

> **Title:** `Cab: Anthony - EWR`
> **Start:** Sunday 2:30 PM
> **End:** Sunday 3:30 PM
> **Location:** `317 Wastena Terr, Ridgewood NJ → EWR Terminal C`
> **Description:**
> ```
> PHONE: (914) 555-0142
> EMAIL: a.constantinople@email.com
> FROM: 317 Wastena Terr, Ridgewood NJ
> TO: EWR Terminal C
> FARE: 68.50
> ```

Every 60 seconds, the backend pulls events with prefix `Cab:` from Tom's calendar, parses the structured description, and creates/updates ride records in the DB. The HTML page then shows them in the "Today's rides" list.

Tom doesn't need to learn anything new — he keeps using Google Calendar the way he always has, with one small habit: prefix the title with `Cab:` and add the structured info in the description.

---

## File-by-file

```
backend/
├── server.js              # Main Express app + all API endpoints
├── package.json           # Dependencies
├── .env.example           # Template for environment variables
├── services/
│   ├── clover.js          # Card charging via Clover REST API
│   ├── onedrive.js        # OneDrive file operations via Microsoft Graph
│   ├── email.js           # Resend integration + Clover-style email template
│   ├── excel.js           # Adams' Towne invoice generation using ExcelJS
│   ├── calendar.js        # Google Calendar sync (polling + webhook)
│   └── db.js              # Simple JSON-file database
├── scripts/
│   └── calendar-sync.js   # Manual sync CLI: `npm run calendar-sync`
└── README.md              # This file
```

---

## Troubleshooting

**"OneDrive not connected"** — Tom needs to visit `/auth/microsoft` once. Token persists after that.

**"Calendar not connected"** — Same, but `/auth/google`.

**"Clover charge failed: 401"** — Token expired or wrong merchant ID. Re-generate in Clover dashboard.

**Emails not sending** — Domain not verified in Resend, or wrong API key. Check Resend dashboard.

**Excel file looks wrong** — Check `services/excel.js` formatting; compare to `templates/sample_constantinople.xlsx` reference.
