'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fetch  = require('node-fetch');
const { connectMongo, Place, disconnectMongo } = require('../src/mongo');

const API_URL     = 'https://www.booking.com/dml/graphql?lang=en-us';
const ROWS        = 25;
const TARGET      = 1000;
const DELAY_MS    = 800;

const HEADERS = {
  'content-type':  'application/json',
  'user-agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'accept':        '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'origin':        'https://www.booking.com',
  'referer':       'https://www.booking.com/searchresults.html?ss=tokyo&lang=en-us',
};

const QUERY = `
query FullSearch($input: SearchQueryInput!) {
  searchQueries {
    search(input: $input) {
      ...FullSearchFragment
      __typename
    }
    __typename
  }
}

fragment FullSearchFragment on SearchQueryOutput {
  pagination { nbResultsPerPage nbResultsTotal __typename }
  results {
    ...BasicPropertyData
    __typename
  }
  __typename
}

fragment BasicPropertyData on SearchResultProperty {
  basicPropertyData {
    id
    pageName
    location { address city countryCode __typename }
    reviewScore: reviews {
      score: totalScore
      reviewCount: reviewsCount
      __typename
    }
    starRating { value __typename }
    __typename
  }
  displayName { text __typename }
  __typename
}
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(offset) {
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: HEADERS,
    body: JSON.stringify({
      operationName: 'FullSearch',
      variables: {
        input: {
          acidCarouselContext: null,
          doAvailabilityCheck: false,
          encodedAutocompleteMeta: null,
          enableCampaigns: false,
          filters: {},
          flexibleDatesConfig: {
            broadDatesCalendar: { checkinMonths: [], los: [], startWeekdays: [] },
            dateFlexUseCase: 'DATE_RANGE',
            dateRangeCalendar: { checkin: [], checkout: [] },
          },
          forcedBlocks: null,
          location: { searchString: 'tokyo', destId: 0, destType: 'NO_DEST_TYPE' },
          metaContext: { metaCampaignId: 0, externalTotalPrice: null, feedPrice: null, hotelCenterAccountId: null, rateRuleId: null, dragongateTraceId: null, pricingProductsTag: null },
          showAparthotelAsHotel: true,
          needsRoomsMatch: false,
          optionalFeatures: { forceArpExperiments: true, testProperties: false },
          pagination: { rowsPerPage: ROWS, offset },
          rawQueryForSession: `/searchresults.html?ss=tokyo`,
          referrerBlock: null,
          sbCalendarOpen: false,
          sorters: { selectedSorter: null, referenceGeoId: null, tripTypeIntentId: null },
          travelPurpose: 2,
          seoThemeIds: [],
          useSearchParamsFromSession: false,
          merchInput: { testCampaignIds: [] },
        },
      },
      query: QUERY,
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();

  if (json.errors) throw new Error(json.errors[0]?.message || 'GraphQL error');

  const search = json?.data?.searchQueries?.search;
  const total  = search?.pagination?.nbResultsTotal || 0;
  const results = search?.results || [];

  return { results, total };
}

function extractHotel(r) {
  const bd      = r.basicPropertyData;
  const id      = bd?.id;
  const name    = r.displayName?.text;
  const page    = bd?.pageName;
  const country = (bd?.location?.countryCode || 'jp').toLowerCase();
  if (!id || !name || !page) return null;
  return {
    type:      'hotel',
    name:      name.trim(),
    url:       `https://www.booking.com/hotel/${country}/${page}.html`,
    bookingId: String(id),
  };
}

async function main() {
  await connectMongo();

  let offset    = 0;
  let collected = 0;
  let total     = 0;
  let inserted  = 0;

  console.log(`\n[booking] Prikupljam Tokyo hotele sa Booking.com...\n`);

  while (collected < TARGET) {
    process.stdout.write(`  Offset ${offset}... `);

    let results, pageTotal;
    try {
      ({ results, total: pageTotal } = await fetchPage(offset));
    } catch (e) {
      console.log(`GREŠKA: ${e.message}`);
      break;
    }

    if (!results.length) { console.log('prazno, kraj'); break; }
    if (total && !collected) console.log(`\n  Ukupno dostupnih: ${pageTotal}`);

    const hotels = results.map(extractHotel).filter(Boolean);
    if (hotels.length) {
      const ops = hotels.map(h => ({
        updateOne: {
          filter: { bookingId: h.bookingId },
          update: { $setOnInsert: { type: h.type, name: h.name, platform: 'booking.com', url: h.url, bookingId: h.bookingId } },
          upsert: true,
        }
      }));
      const res = await Place.bulkWrite(ops, { ordered: false });
      inserted  += res.upsertedCount;
      collected += hotels.length;
    }

    console.log(`${hotels.length} hotela (upisano novih: ${inserted}, ukupno sakupljeno: ${collected})`);

    if (collected >= TARGET || offset + ROWS >= pageTotal) break;
    offset += ROWS;
    await sleep(DELAY_MS);
  }

  console.log(`\n[booking] GOTOVO`);
  console.log(`  Sakupljeno:   ${collected}`);
  console.log(`  Novih u bazi: ${inserted}`);

  await disconnectMongo();
}

main().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
