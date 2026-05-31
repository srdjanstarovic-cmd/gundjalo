'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fetch = require('node-fetch');
const { connectMongo, insertPlaces, disconnectMongo } = require('../src/mongo');

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
  return { type: 'hotel', name: name.trim(), url, tripId: id };
}

async function main() {
  const { Place } = require('../src/mongo');
  await connectMongo();

  // Učitaj već prikupljene hotel ID-ove iz baze
  const existing = await Place.find({ type: 'hotel', tripId: { $exists: true } }, { tripId: 1 }).lean();
  const shownIds = existing.map(h => h.tripId).filter(Boolean);
  console.log(`[fetch] Već u bazi: ${shownIds.length} hotela — nastavljam od stranice 51\n`);

  const allHotels = [];
  let   page      = 51;
  let   empty     = 0;
  const PAGE_END  = 100;

  console.log('[fetch] Prikupljam stranice 51–100...\n');

  while (empty < 2 && page <= PAGE_END) {
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
      if (empty >= 2) break;
    } else {
      empty = 0;
      const valid = hotels.map(extractHotel).filter(Boolean);
      valid.forEach(h => { if (!shownIds.includes(h.tripId)) shownIds.push(h.tripId); });
      allHotels.push(...valid);
      console.log(`${valid.length} hotela (ukupno: ${allHotels.length})`);
    }

    page++;
    await sleep(600);
  }

  console.log(`\n[fetch] Ukupno prikupljeno: ${allHotels.length} hotela`);

  if (allHotels.length > 0) {
    const inserted = await insertPlaces(allHotels);
    console.log(`[mongo] Upisano: ${inserted} novih u bazu`);
  }

  await disconnectMongo();
}

main().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
