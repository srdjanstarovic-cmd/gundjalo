'use strict';
// Pokreni lokalno da exportujes bazu u data/dump/
// Fajlove pošalji kolegi zajedno sa projektom
require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { connectMongo, Place, Review, disconnectMongo } = require('../src/mongo');

const DUMP_DIR = path.join(__dirname, '../data/dump');

async function main() {
  await connectMongo();

  fs.mkdirSync(DUMP_DIR, { recursive: true });

  process.stdout.write('[export] Exportujem hotele... ');
  const places = await Place.find({}).lean();
  fs.writeFileSync(path.join(DUMP_DIR, 'places.json'), JSON.stringify(places), 'utf8');
  console.log(`${places.length} hotela`);

  process.stdout.write('[export] Exportujem recenzije... ');
  const reviews = await Review.find({}).lean();
  fs.writeFileSync(path.join(DUMP_DIR, 'reviews.json'), JSON.stringify(reviews), 'utf8');
  console.log(`${reviews.length} recenzija`);

  const sizePlaces  = (fs.statSync(path.join(DUMP_DIR, 'places.json')).size  / 1024).toFixed(0);
  const sizeReviews = (fs.statSync(path.join(DUMP_DIR, 'reviews.json')).size / 1024).toFixed(0);
  console.log(`\n[export] Gotovo!`);
  console.log(`  data/dump/places.json   ${sizePlaces} KB`);
  console.log(`  data/dump/reviews.json  ${sizeReviews} KB`);
  console.log(`\nPošalji folder data/dump/ kolegi.`);

  await disconnectMongo();
}

main().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
