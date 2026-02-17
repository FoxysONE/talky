import {
  CollectionReference,
  DocumentReference,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getCountFromServer,
  onSnapshot,
  runTransaction,
  setDoc
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import type { JoinRoomResult, ParticipantDoc, RoomDoc } from "@/types/rtc";

export const ROOM_HEARTBEAT_MS = 5_000;
export const ROOM_STALE_MS = 15_000;
export const MAX_PARTICIPANTS = 4;

export function roomDocRef(roomId: string): DocumentReference {
  return doc(getDb(), "rooms", roomId);
}

export function participantsCollectionRef(roomId: string): CollectionReference {
  return collection(getDb(), "rooms", roomId, "participants");
}

export function signalsCollectionRef(roomId: string): CollectionReference {
  return collection(getDb(), "rooms", roomId, "signals");
}

export function candidatesCollectionRef(roomId: string): CollectionReference {
  return collection(getDb(), "rooms", roomId, "candidates");
}

function normalizeRoomDoc(input?: Partial<RoomDoc>): RoomDoc {
  return {
    createdAt: typeof input?.createdAt === "number" ? input.createdAt : Date.now()
  };
}

function toParticipant(id: string, data?: Partial<ParticipantDoc>): ParticipantDoc {
  return {
    id,
    joinedAt: typeof data?.joinedAt === "number" ? data.joinedAt : Date.now(),
    lastSeen: typeof data?.lastSeen === "number" ? data.lastSeen : 0
  };
}

export function isParticipantActive(participant: ParticipantDoc, now = Date.now()): boolean {
  return now - participant.lastSeen <= ROOM_STALE_MS;
}

export async function joinRoom(roomId: string, clientId: string): Promise<JoinRoomResult> {
  try {
    return await runTransaction(getDb(), async (transaction) => {
      const roomRef = roomDocRef(roomId);
      const roomSnap = await transaction.get(roomRef);
      const now = Date.now();
      const room = normalizeRoomDoc(roomSnap.exists() ? (roomSnap.data() as Partial<RoomDoc>) : undefined);

      transaction.set(roomRef, room, { merge: true });

      const countSnap = await getCountFromServer(participantsCollectionRef(roomId));
      const activeCount = countSnap.data().count;

      if (activeCount >= MAX_PARTICIPANTS) {
        return { ok: false, reason: "full" };
      }

      const participantRef = doc(participantsCollectionRef(roomId), clientId);
      transaction.set(
        participantRef,
        {
          joinedAt: now,
          lastSeen: now
        },
        { merge: true }
      );

      return { ok: true, clientId };
    });
  } catch {
    return { ok: false, reason: "error" };
  }
}

export async function heartbeatParticipant(roomId: string, clientId: string): Promise<void> {
  await setDoc(
    doc(participantsCollectionRef(roomId), clientId),
    {
      lastSeen: Date.now()
    },
    { merge: true }
  );
}

export async function leaveRoom(roomId: string, clientId: string): Promise<void> {
  await deleteDoc(doc(participantsCollectionRef(roomId), clientId));
}

export function subscribeParticipants(
  roomId: string,
  onUpdate: (participants: ParticipantDoc[]) => void
): () => void {
  return onSnapshot(participantsCollectionRef(roomId), (snapshot) => {
    const now = Date.now();
    const list: ParticipantDoc[] = [];
    snapshot.forEach((docSnap) => {
      const participant = toParticipant(docSnap.id, docSnap.data() as Partial<ParticipantDoc>);
      if (isParticipantActive(participant, now)) {
        list.push(participant);
      }
    });
    onUpdate(list);
  });
}

export async function fetchParticipants(roomId: string): Promise<ParticipantDoc[]> {
  const snap = await getDocs(participantsCollectionRef(roomId));
  const now = Date.now();
  const list: ParticipantDoc[] = [];
  snap.forEach((docSnap) => {
    const participant = toParticipant(docSnap.id, docSnap.data() as Partial<ParticipantDoc>);
    if (isParticipantActive(participant, now)) {
      list.push(participant);
    }
  });
  return list;
}
