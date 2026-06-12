/**
 * Email service using Resend.
 *
 * Sends ride confirmations to:
 *   - The customer (their copy of the receipt)
 *   - Tom Adams (so he sees what went out)
 *
 * Email design replicates the Clover confirmation screenshot:
 *   - Dark header band with "ADAMS TOWNE CAR & LIMO"
 *   - "Total paid $X,XXX.XX" in big blue
 *   - Payment ID, Order ID, card-on-file display
 *
 * The customer's monthly invoice Excel file is attached.
 */
const fs = require('fs').promises;
const path = require('path');

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@microtechlabs.io';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'tom@adamstowne.com';
const OWNER_NAME = process.env.OWNER_NAME || 'Tom Adams';
const COMPANY_NAME = process.env.COMPANY_NAME || "Adams' Towne Car & Limo";
const COMPANY_PHONE = process.env.COMPANY_PHONE || '914-656-5656';
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || '22-B Heritage Dr., New City, N.Y. 10956';

const isMock = () => !RESEND_KEY;

let resendClient = null;
function getResend() {
  if (resendClient) return resendClient;
  const { Resend } = require('resend');
  resendClient = new Resend(RESEND_KEY);
  return resendClient;
}

/**
 * The main entrypoint: sends ride completion confirmation to customer + owner.
 *
 * @param {object} customer       - { name, email, address, cityState }
 * @param {object} ride           - { id, fare, paymentId, orderId, cardLast4, etc. }
 * @param {Buffer} attachInvoice  - the Excel invoice buffer
 * @param {string} invoiceFilename
 */
async function sendRideConfirmation({ customer, ride, attachInvoice, invoiceFilename }) {
  const html = buildEmailHtml({ customer, ride });
  const text = buildEmailText({ customer, ride });

  const recipients = [customer.email, OWNER_EMAIL].filter(Boolean);
  const subject = `Ride confirmation — ${COMPANY_NAME} — $${ride.fare.toFixed(2)}`;

  const attachments = attachInvoice
    ? [{
        filename: invoiceFilename || 'invoice.xlsx',
        content: attachInvoice,
      }]
    : [];

  if (isMock()) {
    console.log(`[MOCK Email] To: ${recipients.join(', ')}`);
    console.log(`[MOCK Email] Subject: ${subject}`);
    console.log(`[MOCK Email] Attachment: ${invoiceFilename}`);
    // Save mock email to disk for inspection
    const mockDir = path.join(__dirname, '..', 'data', 'sent-emails');
    await fs.mkdir(mockDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(mockDir, `${stamp}-${ride.id}.html`), html);
    return {
      mock: true,
      messageId: 'MOCK_MSG_' + Math.random().toString(36).slice(2, 12),
      to: recipients,
    };
  }

  const resend = getResend();
  const result = await resend.emails.send({
    from: `${COMPANY_NAME} <${FROM_EMAIL}>`,
    to: recipients,
    subject,
    html,
    text,
    attachments,
    reply_to: OWNER_EMAIL,
  });

  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }

  return {
    mock: false,
    messageId: result.data?.id,
    to: recipients,
  };
}

function buildEmailHtml({ customer, ride }) {
  const totalStr = ride.fare.toFixed(2);
  const dollarsStr = Math.floor(ride.fare).toLocaleString();
  const centsStr = (Math.round((ride.fare - Math.floor(ride.fare)) * 100)).toString().padStart(2, '0');
  const dateStr = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ride Confirmation</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:520px;margin:0 auto;background:white;">

    <!-- Dark header band with logo + company info -->
    <div style="background:#0f172a;padding:36px 24px 28px;text-align:center;">
      <div style="display:inline-block;width:64px;height:64px;background:white;border-radius:50%;line-height:64px;font-size:30px;margin-bottom:14px;">🚕</div>
      <div style="color:white;font-size:18px;font-weight:800;letter-spacing:1px;margin-bottom:12px;">${escapeHtml(COMPANY_NAME.toUpperCase())}</div>
      <div style="margin-bottom:14px;">
        <span style="display:inline-block;border:1.5px solid #3b82f6;color:#3b82f6;border-radius:20px;padding:6px 18px;font-size:12px;font-weight:600;">FOLLOW</span>
      </div>
      <div style="color:#3b82f6;font-size:12px;line-height:1.6;">
        ${escapeHtml(COMPANY_ADDRESS.split(',').slice(0, 1)[0].toUpperCase())}<br>
        ${escapeHtml(COMPANY_ADDRESS.split(',').slice(1).join(',').trim().toUpperCase())}<br>
        +1 ${escapeHtml(COMPANY_PHONE)}
      </div>
    </div>

    <!-- White card: line items -->
    <div style="padding:28px 24px;">
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:10px 0;font-size:14px;font-weight:700;border-bottom:1px solid #e2e8f0;">Ride ${escapeHtml(ride.id)}</td>
          <td style="padding:10px 0;font-size:14px;font-weight:700;text-align:right;border-bottom:1px solid #e2e8f0;">$${totalStr}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding:6px 0;font-size:11px;color:#64748b;line-height:1.5;">
            ${escapeHtml(ride.from || '')} → ${escapeHtml(ride.to || '')}<br>
            ${escapeHtml(ride.time || '')}
          </td>
        </tr>
        <tr>
          <td style="padding:14px 0 4px;font-size:14px;font-weight:700;">Subtotal</td>
          <td style="padding:14px 0 4px;font-size:14px;font-weight:700;text-align:right;">$${totalStr}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-size:13px;color:#64748b;">Total Taxes</td>
          <td style="padding:4px 0;font-size:13px;color:#64748b;text-align:right;">$0.00</td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-size:14px;font-weight:800;border-top:1px solid #e2e8f0;">Order total</td>
          <td style="padding:8px 0;font-size:14px;font-weight:800;text-align:right;border-top:1px solid #e2e8f0;">$${totalStr}</td>
        </tr>
      </table>

      <!-- Total paid - big blue -->
      <div style="margin:24px 0 18px;">
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td style="vertical-align:middle;font-size:22px;font-weight:800;color:#3b82f6;line-height:1.1;padding-right:14px;">Total<br>paid</td>
            <td style="vertical-align:middle;font-size:18px;font-weight:600;color:#3b82f6;padding-right:6px;">$</td>
            <td style="vertical-align:middle;font-size:48px;font-weight:300;color:#3b82f6;line-height:1;">${dollarsStr}</td>
            <td style="vertical-align:top;font-size:18px;font-weight:600;color:#3b82f6;padding-top:6px;padding-left:2px;">${centsStr}</td>
          </tr>
        </table>
      </div>

      <!-- Payment details -->
      <div style="font-size:12px;color:#1e293b;line-height:1.6;margin-bottom:6px;">
        ${escapeHtml(dateStr)}<br>
        <span style="color:#64748b;">Payment ID:</span> ${escapeHtml(ride.paymentId || 'N/A')}<br>
        <span style="color:#64748b;">Order ID:</span> ${escapeHtml(ride.orderId || 'N/A')}
      </div>

      <!-- Card on file -->
      <div style="margin-top:20px;padding-top:18px;border-top:1px solid #e2e8f0;">
        <div style="font-size:12px;font-weight:700;color:#0f172a;margin-bottom:10px;">Payment</div>
        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="vertical-align:middle;padding:4px 10px 4px 0;">
              <div style="display:inline-block;background:#3b82f6;color:white;font-size:9px;font-weight:800;padding:3px 6px;border-radius:3px;letter-spacing:0.5px;">AMEX</div>
            </td>
            <td style="vertical-align:middle;font-size:12px;color:#0f172a;">
              <div style="font-weight:700;">AMERICAN EXPRESS ${escapeHtml(ride.cardLast4 || '7034')}</div>
              <div style="color:#64748b;font-size:11px;">Order amount</div>
            </td>
            <td style="vertical-align:middle;font-size:12px;font-weight:700;text-align:right;">$${totalStr}</td>
          </tr>
          <tr>
            <td></td>
            <td style="padding-top:6px;font-size:11px;color:#0f172a;">CARD ON FILE<br>${escapeHtml(ride.cardLast4 || '7034')} <a href="#" style="color:#3b82f6;text-decoration:underline;">Manage</a></td>
            <td style="padding-top:6px;font-size:11px;text-align:right;color:#0f172a;">$${totalStr}</td>
          </tr>
        </table>
      </div>

      <!-- Footer -->
      <div style="margin-top:24px;padding-top:18px;border-top:1px solid #e2e8f0;text-align:center;">
        <div style="font-size:11px;font-weight:700;color:#64748b;letter-spacing:0.5px;margin-bottom:14px;">PAYMENT ID: ${escapeHtml(ride.paymentId || 'N/A')}</div>
        <div style="font-size:11px;color:#64748b;">Questions? Reply to this email or call ${escapeHtml(COMPANY_PHONE)}</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:10px;">A full Excel invoice for this month is attached to this email.</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function buildEmailText({ customer, ride }) {
  return `
${COMPANY_NAME}
${COMPANY_ADDRESS}
${COMPANY_PHONE}

Ride Confirmation

Ride: ${ride.id}
From: ${ride.from || ''}
To: ${ride.to || ''}
Time: ${ride.time || ''}

Subtotal: $${ride.fare.toFixed(2)}
Total Taxes: $0.00
ORDER TOTAL: $${ride.fare.toFixed(2)}

TOTAL PAID: $${ride.fare.toFixed(2)}

${new Date().toLocaleString('en-US')}
Payment ID: ${ride.paymentId || 'N/A'}
Order ID: ${ride.orderId || 'N/A'}

Card: AMERICAN EXPRESS ${ride.cardLast4 || '7034'} (on file)

Questions? Reply or call ${COMPANY_PHONE}.

The full month-to-date invoice is attached as an Excel file.
`.trim();
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function status() {
  if (isMock()) return 'MOCK (logs to console + data/sent-emails)';
  return `LIVE (Resend, from: ${FROM_EMAIL})`;
}

module.exports = {
  sendRideConfirmation,
  isMock,
  status,
};
