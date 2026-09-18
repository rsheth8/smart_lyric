# Contributing to Bar4Bar

## Prerequisites
- Node 18+
- Optional: Chromaprint (`brew install chromaprint`) + AcoustID key for vinyl
- XcodeGen for tvOS

## Run
```bash
cp .env.example .env
npm test
npm run dev          # http://localhost:4321
npm start            # Electron desktop (projector / vinyl)
```

tvOS:
```bash
cd tvos && xcodegen generate && open Bar4BarTV.xcodeproj
```

Don't commit `.env` or `tvos/.env.local`.
