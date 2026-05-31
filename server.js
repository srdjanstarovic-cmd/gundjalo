'use strict';
require('dotenv').config();

const express = require('express');
const path    = require('path');
const { connectMongo, Place, Review } = require('./src/mongo');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/search?q=naziv ili trip.com URL
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  let filter;

  // Ako je URL — izvuci tripId
  const tripIdMatch = q.match(/hotelId=(\d+)/);
  if (tripIdMatch) {
    filter = { type: 'hotel', tripId: tripIdMatch[1] };
  } else {
    filter = { type: 'hotel', name: { $regex: q, $options: 'i' } };
  }

  const hotels = await Place.find(filter).limit(10).lean();
  res.json(hotels.map(h => ({ _id: h._id, name: h.name, url: h.url, tripId: h.tripId })));
});

// GET /api/hotel/:id — summary podatke
app.get('/api/hotel/:id', async (req, res) => {
  const hotel = await Place.findById(req.params.id).lean();
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

  const [badReviews, stats, topCountries] = await Promise.all([
    Review.find({ place_id: hotel._id, is_bad: true })
      .sort({ rating: 1 })
      .limit(30)
      .lean(),

    Review.aggregate([
      { $match: { place_id: hotel._id, is_bad: true } },
      { $group: {
        _id: null,
        count:  { $sum: 1 },
        avgRating: { $avg: '$rating' },
      }},
    ]),

    Review.aggregate([
      { $match: { place_id: hotel._id, is_bad: true, reviewer_country_code: { $ne: null } } },
      { $group: { _id: { code: '$reviewer_country_code', name: '$reviewer_country' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 3 },
    ]),
  ]);

  res.json({
    hotel,
    badCount:   stats[0]?.count     || 0,
    avgRating:  stats[0]?.avgRating || 0,
    topCountries: topCountries.map(c => ({
      code:  c._id.code,
      name:  c._id.name,
      count: c.count,
    })),
    reviews: badReviews.map(r => ({
      rating:   r.rating,
      text:     r.text,
      reviewer: r.reviewer,
      country:  r.reviewer_country,
      date:     r.review_date,
    })),
  });
});

async function main() {
  await connectMongo();
  app.listen(PORT, () => console.log(`[gundjalo] http://localhost:${PORT}`));
}

main().catch(e => { console.error(e.message); process.exit(1); });
