# Firebase Setup (Firestore + WebRTC signaling)

Ce guide explique la configuration minimale pour faire fonctionner Talky avec Firebase.

## 1. Creer un projet Firebase

1. Ouvrir la console Firebase.
2. Creer un nouveau projet.
3. Activer Firestore (mode production).

## 2. Creer une app Web

1. Ajouter une application Web au projet.
2. Recuperer la configuration Web (apiKey, authDomain, projectId, etc.).
3. Renseigner les variables d'environnement locales.

Fichier attendu: `.env.local`

```dotenv
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

## 3. Regles Firestore

Regles minimales basees sur un PIN a 4 chiffres.

Fichier: `firestore.rules`

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read, write: if roomId.matches('^[0-9]{4}$');

      match /{document=**} {
        allow read, write: if roomId.matches('^[0-9]{4}$');
      }
    }
  }
}
```

## 4. Deploiement des regles

Prerequis: Firebase CLI installe.

Commande:

```bash
firebase deploy --only firestore:rules
```

## 5. Vercel

Ajouter les memes variables `NEXT_PUBLIC_FIREBASE_*` dans Vercel.

## Notes

- Pas d'auth: l'acces se fait par PIN 4 chiffres.
- Mesh P2P jusqu'a 4 participants par room.
- STUN only: certains reseaux stricts peuvent bloquer la connexion.
- Pour plus de fiabilite, ajouter un TURN (non inclus).
