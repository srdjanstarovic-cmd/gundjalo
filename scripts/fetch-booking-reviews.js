'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fetch  = require('node-fetch');
const fs     = require('fs');
const path   = require('path');
const { connectMongo, insertReviews, disconnectMongo, Place, Review } = require('../src/mongo');

const API_URL     = 'https://www.booking.com/dml/graphql?aid=304142&lang=en-us';
const LIMIT       = 10;       // reviews per request
const MAX_PAGES   = 15;       // max 150 reviews per hotel
const CONCURRENCY = 3;
const BAD_RATING  = 6;
const TOP_HELPFUL = 10;
const CHECKPOINT  = path.join(__dirname, '../data/booking-reviews-checkpoint.json');
const DELAY_MS    = 800;
const UFI         = -246227;  // Tokyo city ID na Booking.com

const HEADERS = {
  'content-type':   'application/json',
  'user-agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'accept':         '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'origin':         'https://www.booking.com',
  'referer':        'https://www.booking.com/',
};

const QUERY = `
query ReviewList($input: ReviewListFrontendInput!) {
  reviewListFrontend(input: $input) {
    ... on ReviewListFrontendResult {
      reviewsCount
      reviewCard {
        reviewScore
        helpfulVotesCount
        guestDetails { username countryCode countryName anonymous __typename }
        bookingDetails { checkinDate __typename }
        textDetails { positiveText negativeText lang __typename }
        __typename
      }
      __typename
    }
    ... on ReviewsFrontendError { statusCode message __typename }
    __typename
  }
}
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadCheckpoint() {
  try { return new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'))); }
  catch { return new Set(); }
}
function saveCheckpoint(done) {
  fs.mkdirSync(path.dirname(CHECKPOINT), { recursive: true });
  fs.writeFileSync(CHECKPOINT, JSON.stringify([...done]), 'utf8');
}

async function fetchPage(hotelId, skip) {
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: HEADERS,
    body: JSON.stringify({
      operationName: 'ReviewList',
      variables: {
        input: {
          hotelId:          parseInt(hotelId),
          ufi:              UFI,
          hotelCountryCode: 'jp',
          sorter:           'MOST_RELEVANT',
          filters:          { text: '' },
          skip,
          limit:            LIMIT,
          hotelScore:       0,
          upsortReviewUrl:  '',
          searchFeatures:   { destId: UFI, destType: 'CITY' },
        },
      },
      extensions: {},
      query: QUERY,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.data?.reviewListFrontend;
  if (result?.__typename === 'ReviewsFrontendError') throw new Error(result.message);

  return {
    reviews:     result?.reviewCard     || [],
    totalCount:  result?.reviewsCount   || 0,
  };
}

async function processHotel(hotel) {
  const hotelId = hotel.bookingId;
  const placeId = hotel._id;
  const all     = [];

  let total = 0;
  try {
    const first = await fetchPage(hotelId, 0);
    total = first.totalCount;
    all.push(...first.reviews);
  } catch (e) {
    console.log(`  [${hotel.name.slice(0,25)}] Greška str.1: ${e.message}`);
    return { bad: 0, helpful: 0, total: 0 };
  }

  const totalPages = Math.min(Math.ceil(total / LIMIT), MAX_PAGES);
  for (let p = 1; p < totalPages; p++) {
    await sleep(DELAY_MS);
    try {
      const { reviews } = await fetchPage(hotelId, p * LIMIT);
      if (!reviews.length) break;
      all.push(...reviews);
    } catch (e) {
      console.log(`  [${hotel.name.slice(0,25)}] Greška str.${p+1}: ${e.message}`);
      break;
    }
  }

  const bad = all.filter(r => r.reviewScore <= BAD_RATING &&
    ((r.textDetails?.negativeText || r.textDetails?.positiveText || '').length > 5));

  const helpful = all
    .filter(r => r.reviewScore > BAD_RATING &&
      ((r.textDetails?.positiveText || '').length > 5))
    .sort((a, b) => (b.helpfulVotesCount || 0) - (a.helpfulVotesCount || 0))
    .slice(0, TOP_HELPFUL);

  const toInsert = [...bad, ...helpful].map(r => ({
    place_id:             placeId,
    platform:             'booking.com',
    rating:               r.reviewScore,
    text:                 (r.textDetails?.negativeText || r.textDetails?.positiveText || '').trim(),
    positive_text:        (r.textDetails?.positiveText || '').trim() || null,
    negative_text:        (r.textDetails?.negativeText || '').trim() || null,
    reviewer:             r.guestDetails?.anonymous ? null : (r.guestDetails?.username || null),
    review_date:          r.bookingDetails?.checkinDate ? new Date(r.bookingDetails.checkinDate) : null,
    lang:                 r.textDetails?.lang || null,
    useful_count:         r.helpfulVotesCount || 0,
    is_bad:               r.reviewScore <= BAD_RATING,
    reviewer_country:     r.guestDetails?.countryName || null,
    reviewer_country_code: r.guestDetails?.countryCode?.toLowerCase() || null,
  }));

  if (toInsert.length > 0) await insertReviews(toInsert);

  return { bad: bad.length, helpful: helpful.length, total: all.length };
}

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
        process.stdout.write(`  ✓  ${hotel.name.slice(0,35).padEnd(35)} bad:${r.bad} helpful:${r.helpful} (od ${r.total}) | ${processed}/${hotels.length}\n`);
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

  const hotels = await Place.find({ platform: 'booking.com', bookingId: { $exists: true, $ne: null } }).lean();
  console.log(`\n[booking-reviews] Hotela: ${hotels.length}`);
  console.log(`[booking-reviews] Concurrency: ${CONCURRENCY} | Max stranica: ${MAX_PAGES} | Bad: <=${BAD_RATING}/10\n`);

  const done      = loadCheckpoint();
  const remaining = hotels.filter(h => !done.has(h._id.toString()));
  console.log(`[booking-reviews] Preskočenih: ${done.size} | Ostalo: ${remaining.length}\n`);

  const { totalBad, totalHelp } = await runPool(hotels, CONCURRENCY, done);

  const reviewCount = await Review.countDocuments({ platform: 'booking.com' });
  console.log(`\n[booking-reviews] GOTOVO`);
  console.log(`  Loših:   ${totalBad}`);
  console.log(`  Helpful: ${totalHelp}`);
  console.log(`  Ukupno u bazi (booking.com): ${reviewCount}`);

  await disconnectMongo();
}

main().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
