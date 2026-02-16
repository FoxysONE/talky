import { Unsubscribe, onSnapshot, runTransaction } from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import { pttDocRef } from "@/lib/room";
import type { Holder, PttDoc, Role } from "@/types/rtc";

export const PTT_LOCK_MS = 3_000;
export const PTT_HEARTBEAT_MS = 1_000;

function sanitizeHolder(value: unknown): Holder {
  if (value === "host" || value === "guest") {
    return value;
  }

  return "none";
}

function normalizePtt(input?: Partial<PttDoc>): PttDoc {
  const now = Date.now();
  const expiresAt = typeof input?.expiresAt === "number" ? input.expiresAt : 0;
  const updatedAt = typeof input?.updatedAt === "number" ? input.updatedAt : now;
  const holder = sanitizeHolder(input?.holder);

  if (expiresAt <= now) {
    return {
      holder: "none",
      expiresAt: 0,
      updatedAt
    };
  }

  return {
    holder,
    expiresAt,
    updatedAt
  };
}

export async function ensurePttDoc(roomId: string): Promise<void> {
  await runTransaction(getDb(), async (transaction) => {
    const reference = pttDocRef(roomId);
    const snapshot = await transaction.get(reference);

    if (snapshot.exists()) {
      return;
    }

    transaction.set(reference, {
      holder: "none",
      expiresAt: 0,
      updatedAt: Date.now()
    });
  });
}

export async function tryAcquirePtt(roomId: string, role: Role): Promise<boolean> {
  return runTransaction(getDb(), async (transaction) => {
    const reference = pttDocRef(roomId);
    const snapshot = await transaction.get(reference);
    const now = Date.now();
    const current = normalizePtt(snapshot.exists() ? (snapshot.data() as Partial<PttDoc>) : undefined);
    const canTakeLock = current.holder === "none" || current.holder === role || current.expiresAt <= now;

    if (!canTakeLock) {
      return false;
    }

    transaction.set(
      reference,
      {
        holder: role,
        expiresAt: now + PTT_LOCK_MS,
        updatedAt: now
      },
      { merge: true }
    );

    return true;
  });
}

export async function refreshPtt(roomId: string, role: Role): Promise<void> {
  await runTransaction(getDb(), async (transaction) => {
    const reference = pttDocRef(roomId);
    const snapshot = await transaction.get(reference);
    const now = Date.now();
    const current = normalizePtt(snapshot.exists() ? (snapshot.data() as Partial<PttDoc>) : undefined);

    if (current.holder !== role) {
      return;
    }

    transaction.set(
      reference,
      {
        holder: role,
        expiresAt: now + PTT_LOCK_MS,
        updatedAt: now
      },
      { merge: true }
    );
  });
}

export async function releasePtt(roomId: string, role: Role): Promise<void> {
  await runTransaction(getDb(), async (transaction) => {
    const reference = pttDocRef(roomId);
    const snapshot = await transaction.get(reference);
    const current = normalizePtt(snapshot.exists() ? (snapshot.data() as Partial<PttDoc>) : undefined);

    if (current.holder !== role) {
      return;
    }

    transaction.set(
      reference,
      {
        holder: "none",
        expiresAt: 0,
        updatedAt: Date.now()
      },
      { merge: true }
    );
  });
}

export function watchPttState(roomId: string, onUpdate: (state: PttDoc) => void): Unsubscribe {
  return onSnapshot(pttDocRef(roomId), (snapshot) => {
    const current = normalizePtt(snapshot.exists() ? (snapshot.data() as Partial<PttDoc>) : undefined);
    onUpdate(current);
  });
}
