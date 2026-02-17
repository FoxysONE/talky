export interface RoomDoc {
  createdAt: number;
}

export interface ParticipantDoc {
  id: string;
  joinedAt: number;
  lastSeen: number;
}

export interface SignalDoc {
  from: string;
  to: string;
  sdp: RTCSessionDescriptionInit;
  createdAt: number;
}

export interface IceCandidateDoc {
  from: string;
  to: string;
  candidate: RTCIceCandidateInit;
  createdAt: number;
}

export type JoinRoomResult =
  | { ok: true; clientId: string }
  | { ok: false; reason: "full" | "error" };
