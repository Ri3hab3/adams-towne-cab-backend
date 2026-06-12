/**
 * OneDrive integration via Microsoft Graph API.
 *
 * Flow:
 *   1. Owner does one-time OAuth: GET /auth/microsoft → grants permission
 *   2. Backend stores refresh token in tokens/microsoft.json
 *   3. From then on, backend can read/write files in owner's OneDrive automatically
 *
 * Folder structure:
 *   /Adams Towne Cab/
 *     /Anthony Constantinople/
 *       2026-06-Anthony Constantinople.xlsx
 *       2026-05-Anthony Constantinople.xlsx
 *     /Diane Robertson/
 *       2026-06-Diane Robertson.xlsx
 *
 * Each ride finish:
 *   - System opens the current month's Excel for that customer
 *   - Appends a ride row
 *   - Saves back
 *   - If file doesn't exist (start of month), creates it from template
 */
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const excel = require('./excel');

const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const TENANT_ID = process.env.MS_TENANT_ID || 'common';
const REDIRECT_URI = process.env.MS_REDIRECT_URI || 'http://localhost:3000/auth/microsoft/callback';
const ROOT_FOLDER = process.env.ONEDRIVE_ROOT_FOLDER || 'Adams Towne Cab';

const TOKEN_FILE = path.join(__dirname, '..', 'tokens', 'microsoft.json');
const LOCAL_MOCK_DIR = path.join(__dirname, '..', 'data', 'onedrive-mock');

const SCOPES = ['Files.ReadWrite', 'offline_access', 'User.Read'].join(' ');

let cachedAccessToken = null;
let cachedExpiry = 0;

const isMock = () => !CLIENT_ID || !CLIENT_SECRET;

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    response_mode: 'query',
  });
  return `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?${params}`;
}

async function handleOAuthCallback(code) {
  const tokenRes = await axios.post(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      scope: SCOPES,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokenRes.data, null, 2));
  cachedAccessToken = tokenRes.data.access_token;
  cachedExpiry = Date.now() + (tokenRes.data.expires_in - 60) * 1000;
  return true;
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiry) return cachedAccessToken;

  let tokens;
  try {
    tokens = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
  } catch {
    throw new Error('OneDrive not connected. Visit /auth/microsoft once to authorize.');
  }

  // Refresh
  const res = await axios.post(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
      scope: SCOPES,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  // Persist new tokens
  const merged = { ...tokens, ...res.data };
  await fs.writeFile(TOKEN_FILE, JSON.stringify(merged, null, 2));
  cachedAccessToken = res.data.access_token;
  cachedExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedAccessToken;
}

function graphClient() {
  return axios.create({
    baseURL: 'https://graph.microsoft.com/v1.0',
    timeout: 20000,
  });
}

async function authedRequest(config) {
  const token = await getAccessToken();
  const client = graphClient();
  return client({
    ...config,
    headers: {
      ...(config.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

/**
 * The main entry point: append a ride to customer's current month invoice Excel.
 * Returns { filePath, webUrl, fileBuffer, filename }
 */
async function appendRideToInvoice({ customer, ride }) {
  const rideDate = ride.dateISO ? new Date(ride.dateISO) : new Date();
  const year = rideDate.getFullYear();
  const month = rideDate.getMonth() + 1;

  const filename = excel.invoiceFilename(customer.name, year, month);
  const folderPath = `${ROOT_FOLDER}/${customer.name}`;
  const filePath = `${folderPath}/${filename}`;

  if (isMock()) {
    return mockAppend({ customer, ride, year, month, filename, filePath });
  }

  // 1. Try to download existing file
  let existingBuffer = null;
  try {
    const dl = await authedRequest({
      method: 'GET',
      url: `/me/drive/root:/${encodeURI(filePath)}:/content`,
      responseType: 'arraybuffer',
    });
    existingBuffer = Buffer.from(dl.data);
  } catch (err) {
    if (err.response?.status !== 404) {
      console.warn('Existing file fetch warning:', err.response?.status);
    }
    // 404 = file doesn't exist, create fresh
  }

  // 2. Build the updated workbook
  let wb;
  if (existingBuffer) {
    wb = await excel.appendRideToExistingWorkbook(existingBuffer, ride, customer);
  } else {
    const invoiceNumber = `${year}${String(month).padStart(2, '0')}-${customer.id?.replace('CUST-', '') || '001'}`;
    wb = await excel.createFreshInvoice({ customer, month, year, invoiceNumber });
    wb = await excel.appendRideToExistingWorkbook(await excel.workbookToBuffer(wb), ride, customer);
  }

  const newBuffer = await excel.workbookToBuffer(wb);

  // 3. Ensure folder exists (PUT will fail if path doesn't exist for new files)
  await ensureFolder(folderPath);

  // 4. Upload (small file upload <4MB — PUT directly)
  const up = await authedRequest({
    method: 'PUT',
    url: `/me/drive/root:/${encodeURI(filePath)}:/content`,
    data: newBuffer,
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return {
    filePath,
    webUrl: up.data.webUrl,
    fileBuffer: newBuffer,
    filename,
    fileId: up.data.id,
  };
}

async function ensureFolder(folderPath) {
  // Splits folder path and creates each segment if missing
  const segments = folderPath.split('/').filter(Boolean);
  let currentPath = '';
  for (const seg of segments) {
    const parentPath = currentPath;
    currentPath = currentPath ? `${currentPath}/${seg}` : seg;
    try {
      await authedRequest({
        method: 'GET',
        url: `/me/drive/root:/${encodeURI(currentPath)}`,
      });
    } catch (err) {
      if (err.response?.status === 404) {
        // Create folder
        const parentRef = parentPath
          ? `/me/drive/root:/${encodeURI(parentPath)}:/children`
          : `/me/drive/root/children`;
        await authedRequest({
          method: 'POST',
          url: parentRef,
          data: { name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' },
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        throw err;
      }
    }
  }
}

// Mock implementation — writes Excel to local disk, prints path
async function mockAppend({ customer, ride, year, month, filename, filePath }) {
  const dir = path.join(LOCAL_MOCK_DIR, ROOT_FOLDER, customer.name);
  await fs.mkdir(dir, { recursive: true });
  const localPath = path.join(dir, filename);

  // Try to read existing
  let existingBuffer = null;
  try { existingBuffer = await fs.readFile(localPath); } catch {}

  let wb;
  if (existingBuffer) {
    wb = await excel.appendRideToExistingWorkbook(existingBuffer, ride, customer);
  } else {
    const invoiceNumber = `${year}${String(month).padStart(2, '0')}-${customer.id?.replace('CUST-', '') || '001'}`;
    wb = await excel.createFreshInvoice({ customer, month, year, invoiceNumber });
    wb = await excel.appendRideToExistingWorkbook(await excel.workbookToBuffer(wb), ride, customer);
  }

  const buf = await excel.workbookToBuffer(wb);
  await fs.writeFile(localPath, buf);

  console.log(`[MOCK OneDrive] Saved: ${localPath}`);
  return {
    filePath,
    webUrl: `file://${localPath}`,
    fileBuffer: buf,
    filename,
    mock: true,
  };
}

function status() {
  if (isMock()) return 'MOCK (local file system)';
  return 'LIVE (OneDrive via Graph API)';
}

module.exports = {
  getAuthUrl,
  handleOAuthCallback,
  appendRideToInvoice,
  isMock,
  status,
};
