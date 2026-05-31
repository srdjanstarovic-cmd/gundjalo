'use strict';
// node scripts/import-data.js
// Raspakuje dump.zip (iz roota projekta) i uvozi u MongoDB
require('dotenv').config();

const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');
const { connectMongo, Place, Review, disconnectMongo } = require('../src/mongo');

const ROOT      = path.join(__dirname, '..');
const DUMP_ZIP  = path.join(ROOT, 'dump.zip');
const DUMP_DIR  = path.join(ROOT, 'data', 'dump');

async function main() {
  // Raspakovavanje
  if (!fs.existsSync(path.join(DUMP_DIR, 'places.json'))) {
    if (!fs.existsSync(DUMP_ZIP)) {
      console.error('[ERR] Nema dump.zip u rootu projekta.');
      process.exit(1);
    }
    process.stdout.write('[import] Raspakovavam dump.zip... ');
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    try {
      execSync(`tar -xf "${DUMP_ZIP}" -C "${path.join(ROOT, 'data')}"`);
      console.log('OK');
    } catch {
      // fallback za stariji Windows
      execSync(`cd /d "${path.join(ROOT, 'data')}" && tar -xf "${DUMP_ZIP}"`, { shell: 'cmd.exe' });
      console.log('OK');
    }
  }

  await connectMongo();

  // Places
  process.stdout.write('[import] Uvozim hotele... ');
  const places = JSON.parse(fs.readFileSync(path.join(DUMP_DIR, 'places.json'), 'utf8'));
  await Place.deleteMany({});
  await Place.insertMany(places, { ordered: false });
  console.log(`${places.length} hotela ✓`);

  // Reviews u batchevima
  const reviews = JSON.parse(fs.readFileSync(path.join(DUMP_DIR, 'reviews.json'), 'utf8'));
  await Review.deleteMany({});
  const BATCH = 1000;
  let inserted = 0;
  for (let i = 0; i < reviews.length; i += BATCH) {
    await Review.insertMany(reviews.slice(i, i + BATCH), { ordered: false });
    inserted += Math.min(BATCH, reviews.length - i);
    process.stdout.write(`\r[import] Uvozim recenzije... ${inserted}/${reviews.length}`);
  }
  console.log(' ✓');

  console.log('\n[import] Gotovo! Pokreni: node server.js');
  await disconnectMongo();
}

main().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
