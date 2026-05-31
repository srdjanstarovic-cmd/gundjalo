# Gundjalo 😤

> Cross-platform traveler sentiment summaries. Real complaints. Real hotels. Zero mercy.

## Šta je ovo?

Web app koji prikazuje analize loših recenzija hotela prikupljenih sa Trip.com.  
Pretraži hotel po imenu ili Trip.com linku i vidi ko se žali i zašto.

## Potrebno

- [Node.js](https://nodejs.org/) v18+
- [MongoDB](https://www.mongodb.com/try/download/community) (lokalno, port 27017)

## Instalacija

```bash
git clone https://github.com/srdjanstarovic/gundjalo.git
cd gundjalo
npm install
cp .env.example .env
```

## Pokretanje servera

```bash
node server.js
```

Otvori http://localhost:3000

## Punjenje baze podacima

### Opcija A — Import dump fajlova (preporučeno, brzo)

`dump.zip` je uključen u repo (~15 MB, ~1000 hotela + 19k recenzija).

```bash
node scripts/import-data.js
```

Skripta sama raspakuje zip i uveze sve u MongoDB.

### Opcija B — Scrape sam (sporo, ~45 min)

```bash
# 1. Prikupi ~1000 hotela sa Trip.com
node scripts/fetch-tokyo-hotels.js

# 2. Prikupi recenzije (10 paralelno, checkpoint sistem)
node scripts/fetch-reviews.js
```

### Export (za dijeljenje dump-a)

```bash
node scripts/export-data.js
# Kreira data/dump/places.json i data/dump/reviews.json
```

## Struktura

```
gundjalo/
├── server.js              # Express server + API
├── src/
│   └── mongo.js           # MongoDB modeli (Place, Review)
├── scripts/
│   ├── fetch-tokyo-hotels.js   # Prikuplja hotele sa Trip.com
│   └── fetch-reviews.js        # Prikuplja recenzije (paralelno, 10 hotela)
└── public/
    └── index.html         # Frontend
```

## API

| Endpoint | Opis |
|---|---|
| `GET /api/search?q=...` | Pretraži hotele po imenu ili Trip.com URL-u |
| `GET /api/hotel/:id` | Recenzije i statistike za hotel |
