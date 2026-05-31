'use strict';
const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = path.join(__dirname, '../data/nevolim.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS places (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT    NOT NULL CHECK(type IN ('hotel','restaurant','destination')),
      name        TEXT    NOT NULL,
      url         TEXT,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_places_type ON places(type);
    CREATE INDEX IF NOT EXISTS idx_places_name ON places(name);

    CREATE TABLE IF NOT EXISTS reviews (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id    INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      platform    TEXT,
      rating      REAL,
      text        TEXT    NOT NULL,
      reviewer    TEXT,
      review_date TEXT,
      lang        TEXT,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reviews_place  ON reviews(place_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(place_id, rating);
  `);

  console.log('[db] Baza inicijalizovana:', DB_PATH);
  return db;
}

// Upiši jedno mjesto, vrati id
function insertPlace(type, name, url = null) {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM places WHERE name = ? AND type = ?`).get(name, type);
  if (existing) return existing.id;
  const info = db.prepare(`INSERT INTO places (type, name, url) VALUES (?, ?, ?)`).run(type, name, url);
  return info.lastInsertRowid;
}

// Batch insert mjesta, vrati broj novih
function insertPlaces(rows) {
  const db   = getDb();
  const stmt = db.prepare(`INSERT OR IGNORE INTO places (type, name, url) VALUES (?, ?, ?)`);
  const many = db.transaction(rows => { let n = 0; for (const r of rows) { const i = stmt.run(r.type, r.name, r.url || null); n += i.changes; } return n; });
  return many(rows);
}

function getPlaces(type = null, limit = 100, offset = 0) {
  const db = getDb();
  if (type) return db.prepare(`SELECT * FROM places WHERE type = ? ORDER BY name LIMIT ? OFFSET ?`).all(type, limit, offset);
  return db.prepare(`SELECT * FROM places ORDER BY type, name LIMIT ? OFFSET ?`).all(limit, offset);
}

function getPlace(id) {
  return getDb().prepare(`SELECT * FROM places WHERE id = ?`).get(id);
}

function deletePlace(id) {
  return getDb().prepare(`DELETE FROM places WHERE id = ?`).run(id).changes;
}

function countPlaces(type = null) {
  const db = getDb();
  if (type) return db.prepare(`SELECT COUNT(*) as n FROM places WHERE type = ?`).get(type).n;
  return db.prepare(`SELECT COUNT(*) as n FROM places`).get().n;
}

module.exports = { getDb, initDb, insertPlace, insertPlaces, getPlaces, getPlace, deletePlace, countPlaces };
