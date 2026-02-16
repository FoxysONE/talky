export type Role = "host" | "guest";
export type Holder = "none" | Role;

export interface RoomDoc {
  createdAt: number;
  hostJoined: boolean;
  guestJoined: boolean;
  hostLastSeen: number;
  guestLastSeen: number;
}

export interface SignalDoc {
  sdp: RTCSessionDescriptionInit;
  createdAt: number;
  sessionId?: string;
}

export interface IceCandidateDoc {
  owner: Role;
  candidate: RTCIceCandidateInit;
  createdAt: number;
  sessionId?: string;
}

export interface PttDoc {
  holder: Holder;
  expiresAt: number;
  updatedAt: number;
}

export type JoinRoomResult = { ok: true; role: Role } | { ok: false; reason: "full" | "error" };

