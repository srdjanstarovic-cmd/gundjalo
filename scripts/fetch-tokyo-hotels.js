'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fetch = require('node-fetch');
const { connectMongo, Place, disconnectMongo } = require('../src/mongo');

const API_URL = 'https://www.trip.com/restapi/soa2/34951/fetchHotelList';

const HEADERS = {
  'content-type':    'application/json',
  'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'accept':          'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'origin':          'https://www.trip.com',
  'referer':         'https://www.trip.com/hotels/?locale=en-XX&curr=EUR',
};

// Više datumskih perioda za veći coverage
const DATE_RANGES = [
  { checkIn: '20260901', checkOut: '20260902', checkInH: '2026-09-01', checkOutH: '2026-09-02' },
  { checkIn: '20261201', checkOut: '20261202', checkInH: '2026-12-01', checkOutH: '2026-12-02' },
  { checkIn: '20270301', checkOut: '20270302', checkInH: '2027-03-01', checkOutH: '2027-03-02' },
  { checkIn: '20270701', checkOut: '20270702', checkInH: '2027-07-01', checkOutH: '2027-07-02' },
];

const PAGE_SIZE = 10;
const DELAY_MS  = 500;
const MAX_EMPTY = 3; // uzastopno praznih stranica prije prekida

function buildPayload(pageIndex, shownIds, dates) {
  return {
    date: { dateType: 1, dateInfo: { checkInDate: dates.checkIn, checkOutDate: dates.checkOut } },
    destination: { type: 1, geo: { cityId: 228, countryId: 78 }, keyword: { word: 'Tokyo' } },
    extraFilter: {
      childInfoItems: [],
      ctripMainLandBDCoordinate: true,
      sessionId: 'ae94f1343ab148c0838c91680a4b2e89',
      extendableParams: { tripWalkDriveSwitch: 'T', isUgcSentenceB: '', multiLangHotelNameVersion: 'B' },
    },
    filters: [
      { type: '17', title: 'Trip.com recommended', value: '1', filterId: '17|1' },
      { type: '19', title: '', value: '228', filterId: '19|228' },
      { type: '80', title: 'Price per room per night', value: '0', filterId: '80|0|1' },
      { filterId: '29|1', type: '29', value: '1|2' },
    ],
    roomQuantity: 1,
    paging: { pageIndex, pageSize: PAGE_SIZE, pageCode: '10320668148' },
    hotelIdFilter: { hotelAldyShown: shownIds },
    head: {
      platform: 'PC', cver: '0', bu: 'IBU', group: 'trip',
      aid: '664610', sid: '1193027', locale: 'en-XX',
      currency: 'EUR', pageId: '10320668148',
      extension: [
        { name: 'cityId',    value: '' },
        { name: 'checkIn',   value: dates.checkInH },
        { name: 'checkOut',  value: dates.checkOutH },
        { name: 'region',    value: 'XX' },
      ],
    },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(pageIndex, shownIds, dates) {
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: HEADERS,
    body:    JSON.stringify(buildPayload(pageIndex, shownIds, dates)),
    signal:  AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json?.data?.hotelList || [];
}

function extractHotel(h) {
  const info = h.hotelInfo || h;
  const id   = String(info?.summary?.hotelId || info?.hotelId || '');
  const name = info?.nameInfo?.name || info?.nameInfo?.enName || info?.hotelName || '';
  if (!id || !name) return null;
  return {
    type:   'hotel',
    name:   name.trim(),
    url:    `https://www.trip.com/hotels/detail/?cityId=228&hotelId=${id}`,
    tripId: id,
    platform: 'trip.com',
  };
}

async function fetchForDates(dates, shownIds, insertedRef) {
  let page      = 1;
  let empty     = 0;
  let collected = 0;

  process.stdout.write(`\n  [${dates.checkInH}] `);

  while (true) {
    let hotels;
    try {
      hotels = await fetchPage(page, shownIds, dates);
    } catch (e) {
      process.stdout.write(`ERR:${e.message} `);
      await sleep(2000);
      try { hotels = await fetchPage(page, shownIds, dates); }
      catch (e2) { console.log(`\n    retry failed, preskačem datum`); break; }
    }

    const valid = (hotels || []).map(extractHotel).filter(h => h && !shownIds.includes(h.tripId));

    if (!valid.length) {
      empty++;
      process.stdout.write('_');
      if (empty >= MAX_EMPTY) break;
    } else {
      empty = 0;
      // Upiši u bazu
      const ops = valid.map(h => ({
        updateOne: {
          filter: { tripId: h.tripId },
          update: { $setOnInsert: { type: h.type, name: h.name, platform: 'trip.com', url: h.url, tripId: h.tripId } },
          upsert: true,
        }
      }));
      const res = await Place.bulkWrite(ops, { ordered: false });
      insertedRef.count += res.upsertedCount;
      collected         += valid.length;

      // Dodaj u shownIds da slijedeće stranice ne vraćaju iste
      valid.forEach(h => shownIds.push(h.tripId));
      process.stdout.write('.');
    }

    page++;
    await sleep(DELAY_MS);
  }

  console.log(` → ${collected} scraped | novih ukupno: ${insertedRef.count}`);
  return collected;
}

async function main() {
  await connectMongo();

  // Učitaj sve postojeće tripId-ove
  const existing = await Place.find({ platform: 'trip.com', tripId: { $exists: true, $ne: null } }, { tripId: 1 }).lean();
  const shownIds = existing.map(h => h.tripId).filter(Boolean);
  console.log(`\n[trip] Već u bazi: ${shownIds.length} hotela`);
  console.log(`[trip] Prikupljam nove — ${DATE_RANGES.length} datumskih perioda\n`);

  const insertedRef = { count: 0 };
  let totalCollected = 0;

  for (const dates of DATE_RANGES) {
    const n = await fetchForDates(dates, shownIds, insertedRef);
    totalCollected += n;
    await sleep(1500);
  }

  const totalInDB = await Place.countDocuments({ platform: 'trip.com' });
  console.log(`\n[trip] GOTOVO`);
  console.log(`  Scraped ukupno: ${totalCollected}`);
  console.log(`  Novih upisano:  ${insertedRef.count}`);
  console.log(`  Trip.com u bazi: ${totalInDB}`);

  await disconnectMongo();
}

main().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
