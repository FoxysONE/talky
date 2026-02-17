# Talky

Talkie-walkie web ultra minimaliste pour 2 personnes, deployable sur Vercel.

## Stack

- Next.js (App Router + TypeScript)
- Firebase Firestore (signalisation WebRTC + lock PTT)
- WebRTC audio P2P (STUN only)

## Routes

- `/` creation/rejoindre room
- `/r/:pin` session talkie-walkie (PIN 4 chiffres)

## Variables d'environnement

Copier `.env.local.example` vers `.env.local` puis renseigner:

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

## Installation locale

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Deploiement Vercel

1. Importer le repo dans Vercel.
2. Ajouter les variables `NEXT_PUBLIC_FIREBASE_*`.
3. Deploy (framework detecte automatiquement: Next.js).

## Firestore

- Activer Firestore.
- Appliquer `firestore.rules` (minimum base sur roomId secret).

Commande exemple:

```bash
firebase deploy --only firestore:rules
```

## Notes

- Maximum strict de 4 participants par room (mesh P2P).
- Mode PTT: maintenir pour parler (voix melees).
- PIN local 4 chiffres (stocke dans le navigateur).
- STUN only: certains reseaux stricts peuvent bloquer la connexion.
