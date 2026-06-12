/**
 * Excel invoice generator.
 *
 * Replicates the Adams' Towne Car & Limo invoice format from the
 * Constantinople sample, with one critical difference: each row has a
 * "Paid" Yes/No column the system writes alongside the ride data.
 *
 * Strategy:
 *   - Each customer has ONE rolling monthly Excel file
 *   - File path: /Adams Towne Cab/{Customer Name}/{YYYY-MM-Customer}.xlsx
 *   - Each ride finished = one new row appended
 *   - When charged, Paid column flips to "YES"
 *
 * The owner can open these files any time in Excel and see the running tally.
 * Same format their customers already recognize.
 */
const ExcelJS = require('exceljs');

const COMPANY = {
  name: "ADAMS' TOWNE CAR & LIMO",
  address1: '22-B Heritage Dr.',
  address2: 'New City, N.Y. 10956',
  phone: '914-656-5656',
  wtRate: 80, // $/hr wait-time
  taxRate: 0.0825,
  gasSurcharge: 15.00,
  nycToll: 30.00,
};

/**
 * Build a fresh workbook for a new customer/month.
 * Returns the buffer; caller saves it to OneDrive.
 */
async function createFreshInvoice({ customer, month, year, invoiceNumber }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = COMPANY.name;
  wb.created = new Date();

  const ws = wb.addWorksheet('Invoice', {
    pageSetup: {
      paperSize: 9, // Letter
      orientation: 'portrait',
      margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    },
  });

  // Column widths
  ws.columns = [
    { width: 12 },  // A: DATE
    { width: 30 },  // B: SERVICE DESCRIPTION
    { width: 10 },  // C: P/U TIME
    { width: 9 },   // D: # HOURS
    { width: 14 },  // E: HRLY W/T CHRGES
    { width: 10 },  // F: RATE
    { width: 12 },  // G: AMOUNT
    { width: 8 },   // H: PAID? (Yes/No)
  ];

  // ===== Header band (rows 1-5): Company info + INVOICE =====
  ws.mergeCells('A1:D1');
  ws.getCell('A1').value = COMPANY.name;
  ws.getCell('A1').font = { name: 'Calibri', size: 16, bold: true };

  ws.mergeCells('A2:D2');
  ws.getCell('A2').value = COMPANY.address1;
  ws.mergeCells('A3:D3');
  ws.getCell('A3').value = COMPANY.address2;
  ws.mergeCells('A4:D4');
  ws.getCell('A4').value = COMPANY.phone;

  ws.mergeCells('F1:H2');
  ws.getCell('F1').value = 'INVOICE';
  ws.getCell('F1').font = { name: 'Calibri', size: 28, color: { argb: 'FF1E293B' } };
  ws.getCell('F1').alignment = { horizontal: 'right', vertical: 'middle' };

  // INVOICE date/number table
  ws.getCell('F3').value = 'DATE:';
  ws.getCell('F3').font = { bold: true };
  ws.getCell('F3').alignment = { horizontal: 'right' };
  ws.getCell('G3').value = formatDate(new Date(year, month - 1, getLastDayOfMonth(year, month)));

  ws.getCell('F4').value = 'INVOICE #';
  ws.getCell('F4').font = { bold: true };
  ws.getCell('F4').alignment = { horizontal: 'right' };
  ws.getCell('G4').value = invoiceNumber;

  ws.getCell('F5').value = 'FOR:';
  ws.getCell('F5').font = { bold: true };
  ws.getCell('F5').alignment = { horizontal: 'right' };
  ws.getCell('G5').value = 'Transportation';

  // ===== Bill To (row 7-9) =====
  ws.mergeCells('A7:H7');
  ws.getCell('A7').value = 'BILL TO:';
  ws.getCell('A7').font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A7').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  ws.getCell('A7').alignment = { horizontal: 'left', indent: 1 };

  ws.mergeCells('A8:D8');
  ws.getCell('A8').value = (customer.name || '').toUpperCase();
  ws.getCell('A8').font = { bold: true, size: 12 };

  ws.mergeCells('A9:D9');
  ws.getCell('A9').value = customer.address || '';

  ws.mergeCells('A10:D10');
  ws.getCell('A10').value = customer.cityState || '';

  // ===== Table header (row 12) =====
  const headerRow = 12;
  const headers = ['DATE', 'SERVICE DESCRIPTION', 'P/U TIME', '# HOURS', 'HRLY W/T CHRGES', 'RATE', 'AMOUNT', 'PAID?'];
  headers.forEach((h, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = h;
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.alignment = { horizontal: i === 0 || i === 1 ? 'left' : i >= 4 ? 'right' : 'center', vertical: 'middle', wrapText: true };
    cell.border = thinBorderAll();
  });
  ws.getRow(headerRow).height = 28;

  // Reserve first 20 ride rows with empty cells + borders
  const dataStartRow = headerRow + 1;
  for (let r = dataStartRow; r < dataStartRow + 20; r++) {
    for (let c = 1; c <= 8; c++) {
      const cell = ws.getCell(r, c);
      cell.border = thinBorderAll('FFE2E8F0');
      cell.alignment = { horizontal: c === 1 || c === 2 ? 'left' : c >= 5 && c <= 7 ? 'right' : 'center', vertical: 'middle' };
    }
    if (r % 2 === 0) {
      for (let c = 1; c <= 8; c++) {
        ws.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      }
    }
  }

  // ===== Totals block (rows 34-40) =====
  const totalsStartRow = 34;
  ws.getCell(totalsStartRow, 5).value = 'W/T Rate:';
  ws.getCell(totalsStartRow, 5).font = { bold: true };
  ws.getCell(totalsStartRow, 5).alignment = { horizontal: 'right' };
  ws.getCell(totalsStartRow, 6).value = `$${COMPANY.wtRate.toFixed(2)} / hr`;

  const totalLabels = [
    ['SUBTOTAL', 'subtotal'],
    [`SALES TAX (${(COMPANY.taxRate * 100).toFixed(2)}%)`, 'tax'],
    ['TOLLS, PROC., GAS SC', 'tolls'],
    ['SVC. CHARGE', 'svc'],
    ['MISC.', 'misc'],
    ['CURRENT TOTAL', 'total'],
  ];
  totalLabels.forEach((entry, i) => {
    const r = totalsStartRow + 2 + i;
    const labelCell = ws.getCell(r, 6);
    const amountCell = ws.getCell(r, 7);
    labelCell.value = entry[0];
    labelCell.alignment = { horizontal: 'right' };
    labelCell.font = { bold: true, size: 10 };
    amountCell.numFmt = '"$"#,##0.00';
    amountCell.alignment = { horizontal: 'right' };
    if (entry[1] === 'total') {
      labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      labelCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      amountCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      amountCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    } else {
      labelCell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
      amountCell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    }
  });

  // Initialize totals to 0
  const dataRange = `G${dataStartRow}:G${dataStartRow + 19}`;
  ws.getCell(totalsStartRow + 2, 7).value = { formula: `SUM(${dataRange})` };
  ws.getCell(totalsStartRow + 3, 7).value = { formula: `G${totalsStartRow + 2} * ${COMPANY.taxRate}` };
  ws.getCell(totalsStartRow + 4, 7).value = 0;  // tolls/proc/gas — owner fills manually
  ws.getCell(totalsStartRow + 5, 7).value = 0;  // svc charge
  ws.getCell(totalsStartRow + 6, 7).value = 0;  // misc
  ws.getCell(totalsStartRow + 7, 7).value = {
    formula: `G${totalsStartRow + 2} + G${totalsStartRow + 3} + G${totalsStartRow + 4} + G${totalsStartRow + 5} + G${totalsStartRow + 6}`,
  };

  // ===== Footer (row 43) =====
  ws.mergeCells(`A43:H43`);
  ws.getCell('A43').value = `Please Note: Gas Surcharge $${COMPANY.gasSurcharge.toFixed(2)} / Trip Effective 5/1/2022. NYC $${COMPANY.nycToll.toFixed(2)} Toll.`;
  ws.getCell('A43').font = { italic: true, size: 9 };
  ws.getCell('A43').alignment = { horizontal: 'left' };

  // Add metadata sheet (hidden) for system use
  const meta = wb.addWorksheet('_meta', { state: 'hidden' });
  meta.getCell('A1').value = 'customerId';
  meta.getCell('B1').value = customer.id;
  meta.getCell('A2').value = 'invoiceMonth';
  meta.getCell('B2').value = `${year}-${String(month).padStart(2, '0')}`;
  meta.getCell('A3').value = 'lastDataRow';
  meta.getCell('B3').value = dataStartRow - 1; // no rides yet
  meta.getCell('A4').value = 'dataStartRow';
  meta.getCell('B4').value = dataStartRow;
  meta.getCell('A5').value = 'maxDataRow';
  meta.getCell('B5').value = dataStartRow + 19;

  return wb;
}

/**
 * Open an existing workbook (from buffer), append a ride row, save.
 */
async function appendRideToExistingWorkbook(buffer, ride, customer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const ws = wb.getWorksheet('Invoice');
  const meta = wb.getWorksheet('_meta');

  const dataStartRow = parseInt(meta.getCell('B4').value) || 13;
  const maxDataRow = parseInt(meta.getCell('B5').value) || 32;
  const lastDataRow = parseInt(meta.getCell('B3').value) || dataStartRow - 1;

  // Find next empty row
  let nextRow = Math.max(lastDataRow + 1, dataStartRow);
  if (nextRow > maxDataRow) {
    throw new Error(`Invoice for ${customer.name} is full (max ${maxDataRow - dataStartRow + 1} rides per month). Start a new monthly invoice.`);
  }

  const rideDate = ride.dateISO ? new Date(ride.dateISO) : new Date();

  ws.getCell(nextRow, 1).value = formatDate(rideDate);
  ws.getCell(nextRow, 2).value = `${ride.from} / ${ride.to}`;
  ws.getCell(nextRow, 3).value = ride.time || '';
  ws.getCell(nextRow, 4).value = ride.hours || '';
  ws.getCell(nextRow, 5).value = ride.wtCharge || 0;
  ws.getCell(nextRow, 6).value = ride.fare;
  ws.getCell(nextRow, 7).value = ride.fare;
  ws.getCell(nextRow, 8).value = ride.paid ? 'YES' : 'NO';

  ws.getCell(nextRow, 5).numFmt = '"$"#,##0.00';
  ws.getCell(nextRow, 6).numFmt = '"$"#,##0.00';
  ws.getCell(nextRow, 7).numFmt = '"$"#,##0.00';

  // Color the Paid cell
  if (ride.paid) {
    ws.getCell(nextRow, 8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
    ws.getCell(nextRow, 8).font = { bold: true, color: { argb: 'FF14532D' } };
  } else {
    ws.getCell(nextRow, 8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    ws.getCell(nextRow, 8).font = { bold: true, color: { argb: 'FF854D0E' } };
  }
  ws.getCell(nextRow, 8).alignment = { horizontal: 'center' };

  // Update meta
  meta.getCell('B3').value = nextRow;

  return wb;
}

function formatDate(date) {
  const mm = String(date.getMonth() + 1);
  const dd = String(date.getDate());
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function getLastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function thinBorderAll(argb = 'FF000000') {
  return {
    top: { style: 'thin', color: { argb } },
    bottom: { style: 'thin', color: { argb } },
    left: { style: 'thin', color: { argb } },
    right: { style: 'thin', color: { argb } },
  };
}

async function workbookToBuffer(wb) {
  return await wb.xlsx.writeBuffer();
}

function invoiceFilename(customerName, year, month) {
  const safe = customerName.replace(/[^a-zA-Z0-9 ]/g, '').trim();
  const monthStr = String(month).padStart(2, '0');
  return `${year}-${monthStr}-${safe}.xlsx`;
}

module.exports = {
  createFreshInvoice,
  appendRideToExistingWorkbook,
  workbookToBuffer,
  invoiceFilename,
};
