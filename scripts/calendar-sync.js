#!/usr/bin/env node
/**
 * Manual calendar sync CLI.
 *
 * Usage: npm run calendar-sync
 *
 * Useful for:
 *   - Initial bulk import after connecting calendar for the first time
 *   - Debugging when scheduled sync isn't behaving as expected
 *   - Running from cron on platforms where node-cron isn't reliable
 */
require('dotenv').config();
const calendar = require('../services/calendar');

(async () => {
  console.log('Starting manual calendar sync...');
  console.log(`Status: ${calendar.status()}`);

  try {
    const result = await calendar.syncRecentEvents();
    console.log('\n=== Sync Result ===');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Sync failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
})();
