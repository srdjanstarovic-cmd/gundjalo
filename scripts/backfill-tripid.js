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

function buildPayload(pageIndex, shownIds) {
  return {
    date: { dateType: 1, dateInfo: { checkInDate: '20260610', checkOutDate: '20260613' } },
    destination: { type: 1, geo: { cityId: 228, countryId: 78 }, keyword: { word: 'Tokyo' } },
    extraFilter: {
      childInfoItems: [],
      ctripMainLandBDCoordinate: true,
      sessionId: 'ae94f1343ab148c0838c91680a4b2e89',
      extendableParams: { tripWalkDriveSwitch: 'T', isUgcSentenceB: '', multiLangHotelNameVersion: 'B' },
    },
    filters: [
      { type: '17', title: 'Trip.com recommended', value: '1', filterId: '17|1' },
      { type: '19', title: '',                     value: '228', filterId: '19|228' },
      { type: '80', title: 'Price per room per night', value: '0', filterId: '80|0|1' },
      { filterId: '29|1', type: '29', value: '1|2' },
    ],
    roomQuantity: 1,
    paging: { pageIndex, pageSize: 10, pageCode: '10320668148' },
    hotelIdFilter: { hotelAldyShown: shownIds },
    head: {
      platform: 'PC', cver: '0', bu: 'IBU', group: 'trip',
      aid: '664610', sid: '1193027', locale: 'en-XX',
      currency: 'EUR', pageId: '10320668148',
      extension: [
        { name: 'cityId',    value: '' },
        { name: 'checkIn',   value: '2026-06-10' },
        { name: 'checkOut',  value: '2026-06-13' },
        { name: 'region',    value: 'XX' },
      ],
    },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(pageIndex, shownIds) {
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: HEADERS,
    body:    JSON.stringify(buildPayload(pageIndex, shownIds)),
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
  const url = `https://www.trip.com/hotels/detail/?cityId=228&hotelId=${id}`;
  return { name: name.trim(), url, tripId: id };
}

async function main() {
  await connectMongo();

  // Uzmi hotele bez tripId
  const missing = await Place.find({
    type: 'hotel',
    $or: [{ tripId: null }, { tripId: { $exists: false } }],
  }, { name: 1 }).lean();
  console.log(`\n[backfill] Hotela bez tripId: ${missing.length}`);

  const missingNames = new Set(missing.map(h => h.name));

  const shownIds = [];
  let page       = 1;
  let updated    = 0;
  let empty      = 0;

  while (empty < 2 && page <= 50) {
    process.stdout.write(`  Stranica ${page}... `);

    let hotels;
    try {
      hotels = await fetchPage(page, shownIds);
    } catch (e) {
      console.log(`GREŠKA: ${e.message}`);
      break;
    }

    if (!hotels.length) {
      empty++;
      console.log('prazno');
    } else {
      empty = 0;
      const valid = hotels.map(extractHotel).filter(Boolean);
      valid.forEach(h => { if (!shownIds.includes(h.tripId)) shownIds.push(h.tripId); });

      let pageUpdated = 0;
      for (const h of valid) {
        if (missingNames.has(h.name)) {
          const res = await Place.updateOne(
            { type: 'hotel', name: h.name, $or: [{ tripId: null }, { tripId: { $exists: false } }] },
            { $set: { tripId: h.tripId, url: h.url } }
          );
          if (res.modifiedCount > 0) {
            updated++;
            pageUpdated++;
            missingNames.delete(h.name);
          }
        }
      }
      console.log(`${valid.length} hotela, updated: ${pageUpdated} (ukupno: ${updated})`);
    }

    page++;
    await sleep(600);
  }

  // Provjeri koliko je ostalo
  const stillMissing = await Place.countDocuments({
    type: 'hotel',
    $or: [{ tripId: null }, { tripId: { $exists: false } }],
  });

  console.log(`\n[backfill] Gotovo! Ažurirano: ${updated} hotela`);
  console.log(`[backfill] Još uvijek bez tripId: ${stillMissing}`);

  await disconnectMongo();
}

main().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
