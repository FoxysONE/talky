"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDoc, onSnapshot, query, where } from "firebase/firestore";
import {
  ROOM_HEARTBEAT_MS,
  MAX_PARTICIPANTS,
  candidatesCollectionRef,
  joinRoom,
  heartbeatParticipant,
  leaveRoom,
  signalsCollectionRef,
  subscribeParticipants
} from "@/lib/room";
import { createAudioPeerConnection, requestMicrophoneStream } from "@/lib/webrtc";
import type { IceCandidateDoc, ParticipantDoc, SignalDoc } from "@/types/rtc";

type JoinState = "joining" | "ready" | "full" | "error";

const PIN_REGEX = /^\d{4}$/;

export default function RoomPage() {
  const params = useParams<{ roomId: string }>();
  const roomId = useMemo(() => {
    const rawValue = params?.roomId;
    const raw = Array.isArray(rawValue) ? rawValue[0] ?? "" : rawValue ?? "";
    return decodeURIComponent(raw).trim();
  }, [params?.roomId]);
  const isValidPin = useMemo(() => PIN_REGEX.test(roomId), [roomId]);

  const [clientId, setClientId] = useState<string | null>(null);
  const [joinState, setJoinState] = useState<JoinState>("joining");
  const [participants, setParticipants] = useState<ParticipantDoc[]>([]);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>("new");
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [isHolding, setIsHolding] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const clientIdRef = useRef<string | null>(null);
  const pressingRef = useRef(false);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localTrackRef = useRef<MediaStreamTrack | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const busyTimeoutRef = useRef<number | null>(null);
  const roomUnsubRef = useRef<(() => void) | null>(null);

  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const peerUnsubsRef = useRef<Map<string, () => void>>(new Map());
  const peerCandidatesRef = useRef<Map<string, Set<string>>>(new Map());
  const peerSignalsRef = useRef<Map<string, Set<string>>>(new Map());
  const peerAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const offeredPeersRef = useRef<Set<string>>(new Set());

  const setTransientBusyMessage = useCallback((message: string) => {
    setBusyMessage(message);

    if (busyTimeoutRef.current !== null) {
      window.clearTimeout(busyTimeoutRef.current);
    }

    busyTimeoutRef.current = window.setTimeout(() => {
      setBusyMessage(null);
      busyTimeoutRef.current = null;
    }, 1_500);
  }, []);

  const clearTransmissionState = useCallback(() => {
    pressingRef.current = false;
    setIsHolding(false);
    setIsTransmitting(false);

    if (localTrackRef.current) {
      localTrackRef.current.enabled = false;
    }
  }, []);

  const stopTalking = useCallback(async () => {
    clearTransmissionState();
  }, [clearTransmissionState]);

  const closePeerConnections = useCallback(() => {
    for (const [, pc] of peerConnectionsRef.current.entries()) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    peerConnectionsRef.current.clear();

    for (const [, unsub] of peerUnsubsRef.current.entries()) {
      unsub();
    }
    peerUnsubsRef.current.clear();

    for (const [, audio] of peerAudioRef.current.entries()) {
      audio.srcObject = null;
    }
    peerAudioRef.current.clear();

    peerCandidatesRef.current.clear();
    peerSignalsRef.current.clear();
    offeredPeersRef.current.clear();
    setConnectionState("new");
  }, []);

  const attachPeerListeners = useCallback(
    (peerId: string, pc: RTCPeerConnection) => {
      const clientIdNow = clientIdRef.current;
      if (!clientIdNow) {
        return;
      }

      const candidatesSet = new Set<string>();
      peerCandidatesRef.current.set(peerId, candidatesSet);
      const signalsSet = new Set<string>();
      peerSignalsRef.current.set(peerId, signalsSet);

      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          return;
        }

        const payload: IceCandidateDoc = {
          from: clientIdNow,
          to: peerId,
          candidate: event.candidate.toJSON(),
          createdAt: Date.now()
        };

        void addDoc(candidatesCollectionRef(roomId), payload).catch(() => {
          // Ignore transient write failures.
        });
      };

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) {
          return;
        }

        let audio = peerAudioRef.current.get(peerId);
        if (!audio) {
          audio = new Audio();
          audio.autoplay = true;
          (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
          peerAudioRef.current.set(peerId, audio);
        }

        audio.srcObject = stream;
        void audio.play().catch(() => {
          // Autoplay can be blocked; ignore.
        });
      };

      pc.onconnectionstatechange = () => {
        setConnectionState(pc.connectionState);
      };

      const offersQuery = query(
        signalsCollectionRef(roomId),
        where("from", "==", peerId),
        where("to", "==", clientIdNow),
        where("type", "==", "offer")
      );

      const answersQuery = query(
        signalsCollectionRef(roomId),
        where("from", "==", peerId),
        where("to", "==", clientIdNow),
        where("type", "==", "answer")
      );

      const candidatesQuery = query(
        candidatesCollectionRef(roomId),
        where("from", "==", peerId),
        where("to", "==", clientIdNow)
      );

      const unsubs: Array<() => void> = [];

      unsubs.push(
        onSnapshot(offersQuery, async (snapshot) => {
          for (const change of snapshot.docChanges()) {
            if (change.type !== "added") {
              continue;
            }
            if (signalsSet.has(change.doc.id)) {
              continue;
            }
            signalsSet.add(change.doc.id);

            const data = change.doc.data() as SignalDoc & { type: "offer" | "answer" };
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              await addDoc(signalsCollectionRef(roomId), {
                from: clientIdNow,
                to: peerId,
                type: "answer",
                sdp: answer,
                createdAt: Date.now()
              });
            } catch {
              // Ignore stale offers.
            }
          }
        })
      );

      unsubs.push(
        onSnapshot(answersQuery, async (snapshot) => {
          for (const change of snapshot.docChanges()) {
            if (change.type !== "added") {
              continue;
            }
            if (signalsSet.has(change.doc.id)) {
              continue;
            }
            signalsSet.add(change.doc.id);

            const data = change.doc.data() as SignalDoc & { type: "offer" | "answer" };
            try {
              if (pc.signalingState === "have-local-offer") {
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
              }
            } catch {
              // Ignore stale answers.
            }
          }
        })
      );

      unsubs.push(
        onSnapshot(candidatesQuery, (snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type !== "added") {
              return;
            }

            if (candidatesSet.has(change.doc.id)) {
              return;
            }
            candidatesSet.add(change.doc.id);

            const data = change.doc.data() as IceCandidateDoc;
            void pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {
              // Ignore stale candidates.
            });
          });
        })
      );

      peerUnsubsRef.current.set(peerId, () => {
        unsubs.forEach((unsub) => unsub());
      });
    },
    [roomId]
  );

  const createPeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
      const localStream = localStreamRef.current;
      if (!localStream) {
        throw new Error("Flux micro indisponible.");
      }

      const pc = createAudioPeerConnection({
        localStream,
        onRemoteStream: (stream) => {
      let audio = peerAudioRef.current.get(peerId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
        peerAudioRef.current.set(peerId, audio);
      }

          audio.srcObject = stream;
          void audio.play().catch(() => {
            // Autoplay can be blocked.
          });
        },
        onConnectionStateChange: (state) => {
          setConnectionState(state);
        }
      });

      attachPeerListeners(peerId, pc);
      peerConnectionsRef.current.set(peerId, pc);
      return pc;
    },
    [attachPeerListeners]
  );

  const canTransmit = useMemo(
    () => joinState === "ready" && clientId !== null && micReady,
    [clientId, joinState, micReady]
  );

  const startTalking = useCallback(async () => {
    if (!canTransmit || isTransmitting) {
      return;
    }

    if (!localTrackRef.current) {
      return;
    }

    localTrackRef.current.enabled = true;
    setIsTransmitting(true);
    setBusyMessage(null);
  }, [canTransmit, isTransmitting]);

  const handlePressStart = useCallback(() => {
    if (joinState !== "ready") {
      return;
    }

    if (pressingRef.current) {
      return;
    }

    pressingRef.current = true;
    setIsHolding(true);
    void startTalking();
  }, [joinState, startTalking]);

  const handlePressEnd = useCallback(() => {
    setIsHolding(false);
    void stopTalking();
  }, [stopTalking]);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("Impossible de copier le lien.");
    }
  }, []);

  useEffect(() => {
    clientIdRef.current = clientId;
  }, [clientId]);

  useEffect(() => {
    if (isTransmitting && !micReady) {
      void stopTalking();
    }
  }, [isTransmitting, micReady, stopTalking]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) {
        return;
      }

      event.preventDefault();
      handlePressStart();
    };

    const keyup = (event: KeyboardEvent) => {
      if (event.code !== "Space") {
        return;
      }

      event.preventDefault();
      handlePressEnd();
    };

    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);

    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
    };
  }, [handlePressEnd, handlePressStart]);

  useEffect(() => {
    if (!clientId) {
      return;
    }

    const activePeers = participants.filter((participant) => participant.id !== clientId).map((p) => p.id);

    for (const peerId of activePeers) {
      if (peerConnectionsRef.current.has(peerId)) {
        continue;
      }

      const pc = createPeerConnection(peerId);
      if (clientId < peerId && !offeredPeersRef.current.has(peerId)) {
        offeredPeersRef.current.add(peerId);
        void (async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await addDoc(signalsCollectionRef(roomId), {
              from: clientId,
              to: peerId,
              type: "offer",
              sdp: offer,
              createdAt: Date.now()
            });
          } catch {
            setTransientBusyMessage("Connexion audio impossible.");
          }
        })();
      }
    }

    for (const peerId of peerConnectionsRef.current.keys()) {
      if (!activePeers.includes(peerId)) {
        const pc = peerConnectionsRef.current.get(peerId);
        if (pc) {
          pc.close();
        }
        peerConnectionsRef.current.delete(peerId);
      }
    }
  }, [clientId, createPeerConnection, participants, roomId, setTransientBusyMessage]);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      if (!roomId || !isValidPin) {
        setJoinState("error");
        setError("PIN invalide.");
        return;
      }

      try {
        const storedId = window.localStorage.getItem("talky_client_id");
        const newId = storedId && storedId.length > 6 ? storedId : crypto.randomUUID();
        window.localStorage.setItem("talky_client_id", newId);

        const join = await joinRoom(roomId, newId);
        if (cancelled) {
          return;
        }

        if (!join.ok) {
          if (join.reason === "full") {
            setJoinState("full");
            setError(null);
          } else {
            setJoinState("error");
            setError("Impossible de rejoindre la room.");
          }
          return;
        }

        setClientId(newId);

        const micStream = await requestMicrophoneStream();
        if (cancelled) {
          micStream.getTracks().forEach((track) => track.stop());
          return;
        }

        const [micTrack] = micStream.getAudioTracks();
        if (!micTrack) {
          throw new Error("Aucune piste micro.");
        }

        micTrack.enabled = false;
        localStreamRef.current = micStream;
        localTrackRef.current = micTrack;
        setMicReady(true);

        setJoinState("ready");
        setError(null);

        const unsub = subscribeParticipants(roomId, (list) => {
          if (!cancelled) {
            setParticipants(list);
          }
        });
        roomUnsubRef.current = unsub;

        await heartbeatParticipant(roomId, newId);
        if (cancelled) {
          return;
        }

        heartbeatIntervalRef.current = window.setInterval(() => {
          void heartbeatParticipant(roomId, newId).catch(() => {
            // Retry on next heartbeat.
          });
        }, ROOM_HEARTBEAT_MS);
      } catch {
        setJoinState("error");
        setError("Permission micro ou configuration Firebase invalide.");
      }
    };

    const beforeUnload = () => {
      const activeClientId = clientIdRef.current;
      if (!activeClientId) {
        return;
      }

      void leaveRoom(roomId, activeClientId).catch(() => {
        // Best effort.
      });
    };

    window.addEventListener("beforeunload", beforeUnload);
    void setup();

    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", beforeUnload);

      void stopTalking();
      closePeerConnections();

      if (roomUnsubRef.current) {
        roomUnsubRef.current();
        roomUnsubRef.current = null;
      }

      if (heartbeatIntervalRef.current !== null) {
        window.clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }

      if (busyTimeoutRef.current !== null) {
        window.clearTimeout(busyTimeoutRef.current);
        busyTimeoutRef.current = null;
      }

      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          track.stop();
        }
        localStreamRef.current = null;
      }
      localTrackRef.current = null;

      const activeClientId = clientIdRef.current;
      if (activeClientId) {
        void leaveRoom(roomId, activeClientId).catch(() => {
          // Best effort.
        });
      }
    };
  }, [closePeerConnections, isValidPin, roomId, stopTalking]);

  const statusLabel = useMemo(() => {
    if (joinState === "joining") {
      return "Connexion";
    }

    if (joinState === "full") {
      return "Occupe";
    }

    if (joinState === "error") {
      return "Erreur";
    }

    if (participants.length <= 1) {
      return "En attente";
    }

    if (connectionState === "connected") {
      return "Connecte";
    }

    if (connectionState === "connecting" || connectionState === "new") {
      return "Connexion";
    }

    return "Connexion";
  }, [connectionState, joinState, participants.length]);

  const statusClass = useMemo(() => statusLabel.toLowerCase().replaceAll(" ", "-"), [statusLabel]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <span className="brand-mark">TALKY</span>
        <div className="connection-dots" aria-label="Statut de connexion">
          <span className={`connection-dot ${joinState === "ready" ? "on" : ""}`} />
          <span className={`connection-dot ${participants.length >= 2 ? "on" : ""}`} />
        </div>
        <span className={`device-state ${isTransmitting ? "live" : ""}`}>{isTransmitting ? "TX" : "RX"}</span>
      </header>

      <section className="hero reveal">
        <div className="room-header">
          <p className="eyebrow">Talky - room</p>
          <h1 className="brand room-title">{roomId || "room invalide"}</h1>
          <p className={`status-pill status-${statusClass}`}>{statusLabel}</p>
        </div>

        {joinState === "full" ? (
          <>
            <p className="subtle">Room complete: deja {MAX_PARTICIPANTS} personnes.</p>
            <Link className="ghost-btn link-btn" href="/">
              Retour
            </Link>
          </>
        ) : (
          <>
            <div className={`row ${isHolding ? "hold-lock" : ""}`}>
              <button type="button" className="ghost-btn" onClick={copyLink}>
                {copied ? "Lien copie" : "Copier le lien"}
              </button>
              <Link className="ghost-btn link-btn" href="/">
                Quitter
              </Link>
            </div>

            <div className="talkie-face">
              <div className="speaker-grill" aria-hidden="true" />
              <div className="knob-row" aria-hidden="true">
                <span className="knob">CH 1</span>
                <span className="knob">VOL</span>
                <span className="knob">BAT</span>
              </div>
              <div className="ptt-stack">
                <span className={`device-led ${isTransmitting ? "live" : ""}`} />
                <button
                  type="button"
                  className={`ptt-button ${isTransmitting ? "live" : ""}`}
                  disabled={!canTransmit}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    handlePressStart();
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onPointerUp={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                    handlePressEnd();
                  }}
                  onPointerLeave={handlePressEnd}
                  onPointerCancel={handlePressEnd}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  {isTransmitting ? "Parle..." : "Maintenir pour parler"}
                </button>
              </div>
            </div>

            <p className="speaker-line">Parole libre (mix voix)</p>
            <p className="subtle">Participants: {participants.length}/{MAX_PARTICIPANTS}</p>
            <p className="subtle">PIN: {roomId}</p>
            <p className="subtle">Utilisateurs connectes: {participants.length}</p>

            {participants.length <= 1 && joinState === "ready" && (
              <p className="warn-line">Tu es seul pour l'instant, mais tu peux tester le PTT.</p>
            )}

            {busyMessage && <p className="warn-line">{busyMessage}</p>}
          </>
        )}

        {error && <p className="error-line">{error}</p>}
      </section>
    </main>
  );
}
