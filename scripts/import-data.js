'use strict';
// Pokreni nakon git clone da napuniš bazu iz dump fajlova
// node scripts/import-data.js
require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { connectMongo, Place, Review, disconnectMongo } = require('../src/mongo');

const DUMP_DIR = path.join(__dirname, '../data/dump');

async function main() {
  const placesFile  = path.join(DUMP_DIR, 'places.json');
  const reviewsFile = path.join(DUMP_DIR, 'reviews.json');

  if (!fs.existsSync(placesFile) || !fs.existsSync(reviewsFile)) {
    console.error('[ERR] Nedostaju fajlovi u data/dump/');
    console.error('      Traži od kolege da ti pošalje places.json i reviews.json');
    process.exit(1);
  }

  await connectMongo();

  // Places
  process.stdout.write('[import] Uvozim hotele... ');
  const places = JSON.parse(fs.readFileSync(placesFile, 'utf8'));
  await Place.deleteMany({});
  await Place.insertMany(places, { ordered: false });
  console.log(`${places.length} hotela`);

  // Reviews
  process.stdout.write('[import] Uvozim recenzije... ');
  const reviews = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
  await Review.deleteMany({});

  // Batch insert po 1000
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
