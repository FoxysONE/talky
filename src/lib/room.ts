import {
  CollectionReference,
  DocumentReference,
  Unsubscribe,
  collection,
  doc,
  onSnapshot,
  runTransaction,
  setDoc
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import type { JoinRoomResult, Role, RoomDoc } from "@/types/rtc";

export const ROOM_HEARTBEAT_MS = 5_000;
export const ROOM_STALE_MS = 15_000;

const ROLE_FIELDS: Record<Role, { joinedKey: keyof RoomDoc; lastSeenKey: keyof RoomDoc }> = {
  host: { joinedKey: "hostJoined", lastSeenKey: "hostLastSeen" },
  guest: { joinedKey: "guestJoined", lastSeenKey: "guestLastSeen" }
};

function normalizeRoomDoc(input?: Partial<RoomDoc>): RoomDoc {
  return {
    createdAt: typeof input?.createdAt === "number" ? input.createdAt : Date.now(),
    hostJoined: Boolean(input?.hostJoined),
    guestJoined: Boolean(input?.guestJoined),
    hostLastSeen: typeof input?.hostLastSeen === "number" ? input.hostLastSeen : 0,
    guestLastSeen: typeof input?.guestLastSeen === "number" ? input.guestLastSeen : 0
  };
}

export function roomDocRef(roomId: string): DocumentReference {
  return doc(getDb(), "rooms", roomId);
}

export function signalDocRef(roomId: string, signalType: "offer" | "answer"): DocumentReference {
  return doc(getDb(), "rooms", roomId, "signals", signalType);
}

export function candidatesCollectionRef(roomId: string): CollectionReference {
  return collection(getDb(), "rooms", roomId, "candidates");
}

export function pttDocRef(roomId: string): DocumentReference {
  return doc(getDb(), "rooms", roomId, "state", "ptt");
}

export function isRoleActive(room: RoomDoc, role: Role, now = Date.now()): boolean {
  const { joinedKey, lastSeenKey } = ROLE_FIELDS[role];
  const joined = room[joinedKey] as boolean;
  const lastSeen = room[lastSeenKey] as number;
  return joined && now - lastSeen <= ROOM_STALE_MS;
}

function getOtherRole(role: Role): Role {
  return role === "host" ? "guest" : "host";
}

export async function getOrCreateRoomRole(roomId: string): Promise<JoinRoomResult> {
  try {
    return await runTransaction(getDb(), async (transaction) => {
      const reference = roomDocRef(roomId);
      const snapshot = await transaction.get(reference);
      const now = Date.now();
      const raw = normalizeRoomDoc(snapshot.exists() ? (snapshot.data() as Partial<RoomDoc>) : undefined);

      const hostIsActive = raw.hostJoined && now - raw.hostLastSeen <= ROOM_STALE_MS;
      const guestIsActive = raw.guestJoined && now - raw.guestLastSeen <= ROOM_STALE_MS;

      const next: RoomDoc = {
        createdAt: raw.createdAt,
        hostJoined: hostIsActive,
        guestJoined: guestIsActive,
        hostLastSeen: hostIsActive ? raw.hostLastSeen : 0,
        guestLastSeen: guestIsActive ? raw.guestLastSeen : 0
      };

      let role: Role | null = null;

      if (!next.hostJoined) {
        role = "host";
      } else if (!next.guestJoined) {
        role = "guest";
      } else {
        return { ok: false, reason: "full" };
      }

      const { joinedKey, lastSeenKey } = ROLE_FIELDS[role];
      next[joinedKey] = true;
      next[lastSeenKey] = now;

      transaction.set(reference, next, { merge: true });

      return { ok: true, role };
    });
  } catch {
    return { ok: false, reason: "error" };
  }
}

export async function heartbeatRoom(roomId: string, role: Role): Promise<void> {
  const now = Date.now();
  const { joinedKey, lastSeenKey } = ROLE_FIELDS[role];
  await setDoc(
    roomDocRef(roomId),
    {
      [joinedKey]: true,
      [lastSeenKey]: now
    },
    { merge: true }
  );
}

export async function leaveRoom(roomId: string, role: Role): Promise<void> {
  const { joinedKey, lastSeenKey } = ROLE_FIELDS[role];
  await setDoc(
    roomDocRef(roomId),
    {
      [joinedKey]: false,
      [lastSeenKey]: 0
    },
    { merge: true }
  );
}

export function subscribeRoom(roomId: string, onUpdate: (room: RoomDoc) => void): Unsubscribe {
  return onSnapshot(roomDocRef(roomId), (snapshot) => {
    const raw = snapshot.exists() ? (snapshot.data() as Partial<RoomDoc>) : undefined;
    onUpdate(normalizeRoomDoc(raw));
  });
}

export function otherRole(role: Role): Role {
  return getOtherRole(role);
}

