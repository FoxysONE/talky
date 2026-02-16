import {
  Unsubscribe,
  addDoc,
  onSnapshot,
  query,
  setDoc,
  where
} from "firebase/firestore";
import type { IceCandidateDoc, Role, SignalDoc } from "@/types/rtc";
import { candidatesCollectionRef, signalDocRef } from "@/lib/room";

const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }]
};

interface CreatePeerArgs {
  localStream: MediaStream;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
}

function normalizeSignalDoc(input: Partial<SignalDoc>): SignalDoc | null {
  if (!input.sdp) {
    return null;
  }

  return {
    sdp: input.sdp,
    createdAt: typeof input.createdAt === "number" ? input.createdAt : Date.now(),
    sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined
  };
}

function normalizeCandidateDoc(owner: Role, input: Partial<IceCandidateDoc>): IceCandidateDoc | null {
  if (!input.candidate) {
    return null;
  }

  return {
    owner,
    candidate: input.candidate,
    createdAt: typeof input.createdAt === "number" ? input.createdAt : Date.now(),
    sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined
  };
}

export async function requestMicrophoneStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Le navigateur ne supporte pas getUserMedia.");
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
}

export function createAudioPeerConnection({
  localStream,
  onRemoteStream,
  onConnectionStateChange
}: CreatePeerArgs): RTCPeerConnection {
  const pc = new RTCPeerConnection(RTC_CONFIGURATION);

  for (const track of localStream.getAudioTracks()) {
    pc.addTrack(track, localStream);
  }

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      onRemoteStream(stream);
    }
  };

  pc.onconnectionstatechange = () => {
    onConnectionStateChange?.(pc.connectionState);
  };

  return pc;
}

export async function publishOffer(roomId: string, signal: SignalDoc): Promise<void> {
  await setDoc(signalDocRef(roomId, "offer"), signal);
}

export async function publishAnswer(roomId: string, signal: SignalDoc): Promise<void> {
  await setDoc(signalDocRef(roomId, "answer"), signal);
}

export function listenForOffer(roomId: string, onOffer: (offer: SignalDoc) => void): Unsubscribe {
  return onSnapshot(signalDocRef(roomId, "offer"), (snapshot) => {
    if (!snapshot.exists()) {
      return;
    }

    const parsed = normalizeSignalDoc(snapshot.data() as Partial<SignalDoc>);
    if (parsed) {
      onOffer(parsed);
    }
  });
}

export function listenForAnswer(roomId: string, onAnswer: (answer: SignalDoc) => void): Unsubscribe {
  return onSnapshot(signalDocRef(roomId, "answer"), (snapshot) => {
    if (!snapshot.exists()) {
      return;
    }

    const parsed = normalizeSignalDoc(snapshot.data() as Partial<SignalDoc>);
    if (parsed) {
      onAnswer(parsed);
    }
  });
}

export async function publishIceCandidate(
  roomId: string,
  owner: Role,
  sessionId: string | undefined,
  candidate: RTCIceCandidateInit
): Promise<void> {
  const payload: IceCandidateDoc = {
    owner,
    candidate,
    createdAt: Date.now(),
    sessionId
  };

  await addDoc(candidatesCollectionRef(roomId), payload);
}

export function listenForRemoteIceCandidates(
  roomId: string,
  remoteOwner: Role,
  onCandidate: (candidate: IceCandidateDoc, candidateId: string) => void
): Unsubscribe {
  const q = query(candidatesCollectionRef(roomId), where("owner", "==", remoteOwner));

  return onSnapshot(q, (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") {
        continue;
      }

      const parsed = normalizeCandidateDoc(remoteOwner, change.doc.data() as Partial<IceCandidateDoc>);
      if (parsed) {
        onCandidate(parsed, change.doc.id);
      }
    }
  });
}

