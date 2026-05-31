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

Baza dolazi prazna. Da prikupiš hotele i recenzije za Tokyo:

```bash
# 1. Prikupi hotele sa Trip.com (stranice 1-100, ~1000 hotela)
node scripts/fetch-tokyo-hotels.js

# 2. Prikupi recenzije za sve hotele
node scripts/fetch-reviews.js
```

> Napomena: skripte direktno scrapuju Trip.com API i mogu potrajati 30-60 minuta.

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
