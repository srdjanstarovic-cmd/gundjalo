'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fetch  = require('node-fetch');
const fs     = require('fs');
const path   = require('path');
const { connectMongo, insertReviews, disconnectMongo, Place, Review } = require('../src/mongo');

const API_URL      = 'https://www.trip.com/restapi/soa2/33269/getHotelCommentList';
const PAGE_SIZE    = 20;
const MAX_PAGES    = 15;       // max 300 recenzija po hotelu
const CONCURRENCY  = 10;       // paralelnih hotela
const BAD_RATING   = 6;        // <= 6/10 = loša recenzija (< 3/5 zvjezdica)
const TOP_HELPFUL  = 10;       // top N helpful recenzija
const CHECKPOINT   = path.join(__dirname, '../data/reviews-checkpoint.json');
const DELAY_MS     = 300;

const HEADERS = {
  'content-type':    'application/json',
  'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'accept':          'application/json, */*',
  'origin':          'https://www.trip.com',
  'referer':         'https://www.trip.com/hotels/',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Učitaj/sačuvaj checkpoint
function loadCheckpoint() {
  try { return new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'))); }
  catch { return new Set(); }
}
function saveCheckpoint(done) {
  fs.mkdirSync(path.dirname(CHECKPOINT), { recursive: true });
  fs.writeFileSync(CHECKPOINT, JSON.stringify([...done]), 'utf8');
}

async function fetchPage(hotelId, pageIndex) {
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: HEADERS,
    body: JSON.stringify({
      hotelId, pageIndex, pageSize: PAGE_SIZE,
      repeatComment: 1, needStaticInfo: false,
      functionOptions: ['IntegratedTARating', 'hidePicAndVideoAgg', 'TripReviewsToServerOnline', 'filterComment'],
      head: { platform: 'PC', bu: 'IBU', group: 'trip', locale: 'en-XX', currency: 'EUR', pageId: '10320668147' },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return {
    comments:   json?.data?.commentList     || [],
    totalCount: json?.data?.totalCount      || 0,
  };
}

async function processHotel(hotel) {
  const hotelId  = parseInt(hotel.tripId);
  const placeId  = hotel._id;
  const allComments = [];

  // Stranica 1 — doznajemo totalCount
  let total = 0;
  try {
    const first = await fetchPage(hotelId, 1);
    total = first.totalCount;
    allComments.push(...first.comments);
  } catch (e) {
    console.log(`  [${hotel.name.slice(0,25)}] Greška str.1: ${e.message}`);
    return { bad: 0, helpful: 0 };
  }

  // Ostatak stranica
  const totalPages = Math.min(Math.ceil(total / PAGE_SIZE), MAX_PAGES);
  for (let p = 2; p <= totalPages; p++) {
    await sleep(DELAY_MS);
    try {
      const { comments } = await fetchPage(hotelId, p);
      if (!comments.length) break;
      allComments.push(...comments);
    } catch (e) {
      console.log(`  [${hotel.name.slice(0,25)}] Greška str.${p}: ${e.message}`);
      break;
    }
  }

  // Filtriraj — loše recenzije
  const bad = allComments.filter(c => c.rating <= BAD_RATING && (c.content || '').length > 10);

  // Top helpful — sortiraj po usefulCount, uzmi 10 sa visokim ratingom
  const helpful = allComments
    .filter(c => c.rating > BAD_RATING && (c.content || '').length > 10)
    .sort((a, b) => (b.usefulCount || 0) - (a.usefulCount || 0))
    .slice(0, TOP_HELPFUL);

  const toInsert = [...bad, ...helpful].map(c => ({
    place_id:    placeId,
    platform:    'trip.com',
    rating:      c.rating,
    text:        (c.content || '').trim(),
    reviewer:    c.userInfo?.nickName || null,
    review_date: c.checkInDate ? new Date(c.checkInDate) : null,
    lang:        c.language || null,
    useful_count: c.usefulCount || 0,
    is_bad:      c.rating <= BAD_RATING,
    reviewer_country:      c.userInfo?.regionName || null,
    reviewer_country_code: c.userInfo?.regionCode || null,
  }));

  if (toInsert.length > 0) {
    await insertReviews(toInsert);
  }

  return { bad: bad.length, helpful: helpful.length, total: allComments.length };
}

// Paralelni worker pool
async function runPool(hotels, concurrency, done) {
  let idx       = 0;
  let processed = 0;
  let totalBad  = 0;
  let totalHelp = 0;

  async function worker() {
    while (idx < hotels.length) {
      const hotel = hotels[idx++];
      const key   = hotel._id.toString();

      if (done.has(key)) {
        process.stdout.write(`  ⏭  ${hotel.name.slice(0,30)} (preskočen)\n`);
        continue;
      }

      try {
        const r = await processHotel(hotel);
        done.add(key);
        processed++;
        totalBad  += r.bad || 0;
        totalHelp += r.helpful || 0;
        process.stdout.write(`  ✓  ${hotel.name.slice(0,35).padEnd(35)} bad:${r.bad} helpful:${r.helpful} (od ${r.total}) | ukupno: ${processed}/${hotels.length}\n`);

        if (processed % 20 === 0) saveCheckpoint(done);
      } catch (e) {
        console.log(`  ✗  ${hotel.name.slice(0,30)} ERR: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  saveCheckpoint(done);
  return { totalBad, totalHelp };
}

async function main() {
  await connectMongo();

  // Uzmi samo hotele sa tripId
  const hotels = await Place.find({ type: 'hotel', tripId: { $exists: true, $ne: null } }).lean();
  console.log(`\n[reviews] Hotela za obradu: ${hotels.length}`);
  console.log(`[reviews] Concurrency: ${CONCURRENCY} | Max stranica/hotel: ${MAX_PAGES} | Bad threshold: <=${BAD_RATING}/10\n`);

  const done = loadCheckpoint();
  const remaining = hotels.filter(h => !done.has(h._id.toString()));
  console.log(`[reviews] Preskočenih (checkpoint): ${done.size} | Ostalo: ${remaining.length}\n`);

  const { totalBad, totalHelp } = await runPool(hotels, CONCURRENCY, done);

  const reviewCount = await Review.countDocuments();
  console.log(`\n[reviews] GOTOVO`);
  console.log(`  Loših recenzija:   ${totalBad}`);
  console.log(`  Helpful recenzija: ${totalHelp}`);
  console.log(`  Ukupno u bazi:     ${reviewCount}`);

  await disconnectMongo();
}

main().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
