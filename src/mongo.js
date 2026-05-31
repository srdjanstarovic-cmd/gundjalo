'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nevolim';

let _connected = false;

async function connectMongo() {
  if (_connected) return mongoose;
  await mongoose.connect(MONGO_URI);
  _connected = true;
  console.log(`[mongo] Konekcija OK: ${MONGO_URI}`);
  return mongoose;
}

function disconnectMongo() {
  _connected = false;
  return mongoose.disconnect();
}

// ─── Place schema ─────────────────────────────────────────────────────────────

const placeSchema = new mongoose.Schema({
  type:        { type: String, required: true, enum: ['hotel', 'restaurant', 'destination'] },
  name:        { type: String, required: true },
  platform:    { type: String, default: null },   // 'trip.com' | 'booking.com'
  url:         { type: String, default: null },
  tripId:      { type: String, default: null },
  bookingId:   { type: String, default: null },
}, { timestamps: true });

placeSchema.index({ tripId:    1 }, { unique: true, sparse: true });
placeSchema.index({ bookingId: 1 }, { unique: true, sparse: true });

const Place = mongoose.models.Place || mongoose.model('Place', placeSchema);

// ─── Review schema ────────────────────────────────────────────────────────────

const reviewSchema = new mongoose.Schema({
  place_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'Place', required: true, index: true },
  platform:    { type: String, default: null },
  rating:      { type: Number, default: null },
  text:        { type: String, required: true },
  reviewer:    { type: String, default: null },
  review_date: { type: Date,   default: null },
  lang:            { type: String, default: null },
  useful_count:    { type: Number, default: 0 },
  is_bad:          { type: Boolean, default: false },
  reviewer_country: { type: String, default: null },
  reviewer_country_code: { type: String, default: null },
  positive_text:   { type: String, default: null },
  negative_text:   { type: String, default: null },
}, { timestamps: true });

reviewSchema.index({ place_id: 1, rating: 1 });

const Review = mongoose.models.Review || mongoose.model('Review', reviewSchema);

// ─── CRUD ─────────────────────────────────────────────────────────────────────

async function insertPlace(type, name, url = null) {
  const doc = await Place.findOneAndUpdate(
    { type, name },
    { $setOnInsert: { type, name, url } },
    { upsert: true, new: true }
  );
  return doc;
}

async function insertPlaces(rows) {
  const ops = rows.map(r => ({
    updateOne: {
      filter: { type: r.type, name: r.name },
      update: { $setOnInsert: { type: r.type, name: r.name, url: r.url || null, tripId: r.tripId || null, bookingId: r.bookingId || null } },
      upsert: true,
    }
  }));
  const res = await Place.bulkWrite(ops, { ordered: false });
  return res.upsertedCount;
}

async function getPlaces(type = null, limit = 100, skip = 0) {
  const filter = type ? { type } : {};
  return Place.find(filter).sort({ type: 1, name: 1 }).skip(skip).limit(limit).lean();
}

async function getPlace(id) {
  return Place.findById(id).lean();
}

async function countPlaces(type = null) {
  return Place.countDocuments(type ? { type } : {});
}

async function insertReviews(reviews) {
  if (!reviews.length) return { inserted: 0, duplicates: 0 };
  try {
    const res = await Review.insertMany(reviews, { ordered: false });
    return { inserted: res.length, duplicates: 0 };
  } catch (err) {
    if (err.code === 11000 || err.name === 'MongoBulkWriteError') {
      const inserted = err.result?.nInserted ?? err.insertedCount ?? 0;
      return { inserted, duplicates: reviews.length - inserted };
    }
    throw err;
  }
}

async function getReviews(placeId, { maxRating = 3, limit = 30 } = {}) {
  return Review.find({ place_id: placeId, rating: { $lte: maxRating } })
    .sort({ rating: 1 })
    .limit(limit)
    .lean();
}

module.exports = {
  connectMongo, disconnectMongo,
  Place, Review,
  insertPlace, insertPlaces, getPlaces, getPlace, countPlaces,
  insertReviews, getReviews,
};
