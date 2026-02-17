"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensurePttDoc, PTT_HEARTBEAT_MS, refreshPtt, releasePtt, tryAcquirePtt, watchPttState } from "@/lib/ptt";
import { ROOM_HEARTBEAT_MS, getOrCreateRoomRole, heartbeatRoom, isRoleActive, leaveRoom, otherRole, subscribeRoom } from "@/lib/room";
import {
  createAudioPeerConnection,
  listenForAnswer,
  listenForOffer,
  listenForRemoteIceCandidates,
  publishAnswer,
  publishIceCandidate,
  publishOffer,
  requestMicrophoneStream
} from "@/lib/webrtc";
import type { Holder, Role, SignalDoc } from "@/types/rtc";

type JoinState = "joining" | "ready" | "full" | "error";

const FAILED_STATES: RTCPeerConnectionState[] = ["failed", "disconnected", "closed"];

function makeSessionId(): string {
  return crypto.randomUUID();
}

function isFailedState(state: RTCPeerConnectionState): boolean {
  return FAILED_STATES.includes(state);
}

export default function RoomPage() {
  const params = useParams<{ roomId: string }>();
  const roomId = useMemo(() => {
    const rawValue = params?.roomId;
    const raw = Array.isArray(rawValue) ? rawValue[0] ?? "" : rawValue ?? "";
    return decodeURIComponent(raw).trim();
  }, [params?.roomId]);
  const isValidPin = useMemo(() => /^\d{4}$/.test(roomId), [roomId]);

  const [role, setRole] = useState<Role | null>(null);
  const [joinState, setJoinState] = useState<JoinState>("joining");
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>("new");
  const [remoteActive, setRemoteActive] = useState(false);
  const [pttHolder, setPttHolder] = useState<Holder>("none");
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const roleRef = useRef<Role | null>(null);
  const remoteActiveRef = useRef(false);
  const joiningRef = useRef(false);
  const pressingRef = useRef(false);
  const acquiringPttRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const localTrackRef = useRef<MediaStreamTrack | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const heartbeatIntervalRef = useRef<number | null>(null);
  const pttHeartbeatRef = useRef<number | null>(null);
  const busyTimeoutRef = useRef<number | null>(null);

  const roomUnsubRef = useRef<(() => void) | null>(null);
  const pttUnsubRef = useRef<(() => void) | null>(null);
  const offerUnsubRef = useRef<(() => void) | null>(null);
  const answerUnsubRef = useRef<(() => void) | null>(null);
  const candidateUnsubRef = useRef<(() => void) | null>(null);

  const processedCandidateIdsRef = useRef<Set<string>>(new Set());

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
    acquiringPttRef.current = false;
    setIsTransmitting(false);

    if (pttHeartbeatRef.current !== null) {
      window.clearInterval(pttHeartbeatRef.current);
      pttHeartbeatRef.current = null;
    }

    if (localTrackRef.current) {
      localTrackRef.current.enabled = false;
    }
  }, []);

  const stopTalking = useCallback(async () => {
    const activeRole = roleRef.current;
    const shouldRelease = pressingRef.current || acquiringPttRef.current || isTransmitting;
    clearTransmissionState();

    if (!shouldRelease || !activeRole) {
      return;
    }

    try {
      await releasePtt(roomId, activeRole);
    } catch {
      // Network races can happen during tab close; ignore.
    }
  }, [clearTransmissionState, isTransmitting, roomId]);

  const closePeerConnection = useCallback(() => {
    if (answerUnsubRef.current) {
      answerUnsubRef.current();
      answerUnsubRef.current = null;
    }

    if (candidateUnsubRef.current) {
      candidateUnsubRef.current();
      candidateUnsubRef.current = null;
    }

    processedCandidateIdsRef.current.clear();

    const activePc = peerConnectionRef.current;
    if (activePc) {
      activePc.onicecandidate = null;
      activePc.ontrack = null;
      activePc.onconnectionstatechange = null;
      activePc.close();
      peerConnectionRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }

    setConnectionState("new");
    sessionIdRef.current = null;
  }, []);

  const attachRemoteCandidateListener = useCallback(
    (sessionId: string) => {
      if (candidateUnsubRef.current) {
        candidateUnsubRef.current();
        candidateUnsubRef.current = null;
      }

      processedCandidateIdsRef.current.clear();

      const activeRole = roleRef.current;
      if (!activeRole) {
        return;
      }

      const remoteRole = otherRole(activeRole);
      candidateUnsubRef.current = listenForRemoteIceCandidates(roomId, remoteRole, async (payload, candidateId) => {
        if (processedCandidateIdsRef.current.has(candidateId)) {
          return;
        }

        processedCandidateIdsRef.current.add(candidateId);

        if (payload.sessionId && payload.sessionId !== sessionIdRef.current) {
          return;
        }

        const activePc = peerConnectionRef.current;
        if (!activePc) {
          return;
        }

        try {
          await activePc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch {
          // Ignore stale candidates after reconnect.
        }
      });

      sessionIdRef.current = sessionId;
    },
    [roomId]
  );

  const createSessionPeerConnection = useCallback(
    (sessionId: string): RTCPeerConnection => {
      const localStream = localStreamRef.current;
      if (!localStream) {
        throw new Error("Flux micro indisponible.");
      }

      closePeerConnection();

      const pc = createAudioPeerConnection({
        localStream,
        onRemoteStream: (stream) => {
          const audioEl = remoteAudioRef.current;
          if (!audioEl) {
            return;
          }

          if (audioEl.srcObject !== stream) {
            audioEl.srcObject = stream;
          }

          void audioEl.play().catch(() => {
            // Some browsers require another user interaction.
          });
        },
        onConnectionStateChange: (state) => {
          setConnectionState(state);
        }
      });

      pc.onicecandidate = (event) => {
        const activeRole = roleRef.current;
        if (!event.candidate || !activeRole) {
          return;
        }

        void publishIceCandidate(roomId, activeRole, sessionId, event.candidate.toJSON()).catch(() => {
          // Ignore transient write failures.
        });
      };

      peerConnectionRef.current = pc;
      setConnectionState(pc.connectionState);
      attachRemoteCandidateListener(sessionId);
      return pc;
    },
    [attachRemoteCandidateListener, closePeerConnection, roomId]
  );

  const startHostSession = useCallback(async () => {
    if (joiningRef.current || roleRef.current !== "host" || !remoteActiveRef.current) {
      return;
    }

    if (!localStreamRef.current) {
      return;
    }

    joiningRef.current = true;

    try {
      const sessionId = makeSessionId();
      const pc = createSessionPeerConnection(sessionId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await publishOffer(roomId, { sdp: offer, createdAt: Date.now(), sessionId });

      if (answerUnsubRef.current) {
        answerUnsubRef.current();
        answerUnsubRef.current = null;
      }

      answerUnsubRef.current = listenForAnswer(roomId, async (answer) => {
        const activePc = peerConnectionRef.current;
        if (!activePc) {
          return;
        }

        if (answer.sessionId && answer.sessionId !== sessionIdRef.current) {
          return;
        }

        if (activePc.signalingState !== "have-local-offer") {
          return;
        }

        try {
          await activePc.setRemoteDescription(new RTCSessionDescription(answer.sdp));
        } catch {
          // Ignore stale answers after a new session starts.
        }
      });
    } catch {
      setError("Impossible d'etablir la connexion audio.");
    } finally {
      joiningRef.current = false;
    }
  }, [createSessionPeerConnection, roomId]);

  const startGuestSession = useCallback(
    async (offer: SignalDoc) => {
      if (joiningRef.current || roleRef.current !== "guest") {
        return;
      }

      if (!localStreamRef.current) {
        return;
      }

      const sessionId = offer.sessionId ?? "default";
      const activePc = peerConnectionRef.current;
      if (
        sessionIdRef.current === sessionId &&
        activePc &&
        !isFailedState(activePc.connectionState) &&
        activePc.connectionState !== "closed"
      ) {
        return;
      }

      joiningRef.current = true;

      try {
        const pc = createSessionPeerConnection(sessionId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await publishAnswer(roomId, { sdp: answer, createdAt: Date.now(), sessionId });
      } catch {
        setError("Impossible de rejoindre la connexion audio.");
      } finally {
        joiningRef.current = false;
      }
    },
    [createSessionPeerConnection, roomId]
  );

  const canTransmit = useMemo(
    () => joinState === "ready" && role !== null && remoteActive && connectionState === "connected",
    [connectionState, joinState, remoteActive, role]
  );

  const startTalking = useCallback(async () => {
    if (!canTransmit || acquiringPttRef.current || isTransmitting) {
      return;
    }

    const activeRole = roleRef.current;
    if (!activeRole || !localTrackRef.current) {
      return;
    }

    acquiringPttRef.current = true;

    try {
      const hasLock = await tryAcquirePtt(roomId, activeRole);
      acquiringPttRef.current = false;

      if (!hasLock) {
        setTransientBusyMessage("Canal occupe");
        return;
      }

      if (!pressingRef.current) {
        await releasePtt(roomId, activeRole);
        return;
      }

      localTrackRef.current.enabled = true;
      setIsTransmitting(true);
      setBusyMessage(null);

      if (pttHeartbeatRef.current !== null) {
        window.clearInterval(pttHeartbeatRef.current);
      }

      pttHeartbeatRef.current = window.setInterval(() => {
        const roleNow = roleRef.current;
        if (!roleNow) {
          return;
        }

        void refreshPtt(roomId, roleNow).catch(() => {
          // Ignore heartbeat failures; lock TTL will recover.
        });
      }, PTT_HEARTBEAT_MS);
    } catch {
      acquiringPttRef.current = false;
      setTransientBusyMessage("Verrou PTT indisponible");
    }
  }, [canTransmit, isTransmitting, roomId, setTransientBusyMessage]);

  const handlePressStart = useCallback(() => {
    if (joinState !== "ready") {
      return;
    }

    pressingRef.current = true;
    void startTalking();
  }, [joinState, startTalking]);

  const handlePressEnd = useCallback(() => {
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
    roleRef.current = role;
  }, [role]);

  useEffect(() => {
    remoteActiveRef.current = remoteActive;
  }, [remoteActive]);

  useEffect(() => {
    if (!role) {
      return;
    }

    if (pttHolder !== role && isTransmitting) {
      void stopTalking();
    }
  }, [isTransmitting, pttHolder, role, stopTalking]);

  useEffect(() => {
    if (isTransmitting && (!remoteActive || connectionState !== "connected")) {
      void stopTalking();
    }
  }, [connectionState, isTransmitting, remoteActive, stopTalking]);

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
    if (role !== "host") {
      return;
    }

    if (!remoteActive) {
      if (peerConnectionRef.current) {
        closePeerConnection();
      }

      return;
    }

    const activePc = peerConnectionRef.current;
    const needsSession = !activePc || isFailedState(activePc.connectionState);
    if (!needsSession) {
      return;
    }

    const timer = window.setTimeout(() => {
      void startHostSession();
    }, 350);

    return () => {
      window.clearTimeout(timer);
    };
  }, [closePeerConnection, connectionState, remoteActive, role, startHostSession]);

  useEffect(() => {
    if (role !== "guest") {
      return;
    }

    if (offerUnsubRef.current) {
      offerUnsubRef.current();
      offerUnsubRef.current = null;
    }

    offerUnsubRef.current = listenForOffer(roomId, (offer) => {
      if (!remoteActiveRef.current) {
        return;
      }

      void startGuestSession(offer);
    });

    return () => {
      if (offerUnsubRef.current) {
        offerUnsubRef.current();
        offerUnsubRef.current = null;
      }
    };
  }, [role, roomId, startGuestSession]);

  useEffect(() => {
    if (role !== "guest" || remoteActive) {
      return;
    }

    if (peerConnectionRef.current) {
      closePeerConnection();
    }
  }, [closePeerConnection, remoteActive, role]);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      if (!roomId || !isValidPin) {
        setJoinState("error");
        setError("PIN invalide.");
        return;
      }

      try {
        const join = await getOrCreateRoomRole(roomId);
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

        roleRef.current = join.role;
        setRole(join.role);
        setJoinState("ready");
        setError(null);

        await ensurePttDoc(roomId);
        if (cancelled) {
          return;
        }

        pttUnsubRef.current = watchPttState(roomId, (pttState) => {
          if (!cancelled) {
            setPttHolder(pttState.holder);
          }
        });

        roomUnsubRef.current = subscribeRoom(roomId, (room) => {
          if (cancelled || !roleRef.current) {
            return;
          }

          const targetRole = otherRole(roleRef.current);
          setRemoteActive(isRoleActive(room, targetRole));
        });

        await heartbeatRoom(roomId, join.role);
        if (cancelled) {
          return;
        }

        heartbeatIntervalRef.current = window.setInterval(() => {
          const activeRole = roleRef.current;
          if (!activeRole) {
            return;
          }

          void heartbeatRoom(roomId, activeRole).catch(() => {
            // Keep retrying on next heartbeat.
          });
        }, ROOM_HEARTBEAT_MS);
      } catch {
        setJoinState("error");
        setError("Permission micro ou configuration Firebase invalide.");
      }
    };

    const beforeUnload = () => {
      const activeRole = roleRef.current;
      if (!activeRole) {
        return;
      }

      void releasePtt(roomId, activeRole).catch(() => {
        // Best effort.
      });

      void leaveRoom(roomId, activeRole).catch(() => {
        // Best effort.
      });
    };

    window.addEventListener("beforeunload", beforeUnload);
    void setup();

    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", beforeUnload);

      void stopTalking();
      closePeerConnection();

      if (roomUnsubRef.current) {
        roomUnsubRef.current();
        roomUnsubRef.current = null;
      }

      if (pttUnsubRef.current) {
        pttUnsubRef.current();
        pttUnsubRef.current = null;
      }

      if (offerUnsubRef.current) {
        offerUnsubRef.current();
        offerUnsubRef.current = null;
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

      const activeRole = roleRef.current;
      if (activeRole) {
        void leaveRoom(roomId, activeRole).catch(() => {
          // Best effort.
        });
      }
    };
  }, [closePeerConnection, roomId, stopTalking]);

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

    if (!remoteActive) {
      return "En attente";
    }

    if (connectionState === "connected") {
      return pttHolder !== "none" && pttHolder !== role ? "Occupe" : "Connecte";
    }

    if (connectionState === "connecting" || connectionState === "new") {
      return "Connexion";
    }

    if (isFailedState(connectionState)) {
      return "Reconnexion";
    }

    return "Connexion";
  }, [connectionState, joinState, pttHolder, remoteActive, role]);

  const channelOwnerLabel = useMemo(() => {
    if (pttHolder === "none") {
      return "Personne";
    }

    if (pttHolder === role) {
      return "Moi";
    }

    return "Autre";
  }, [pttHolder, role]);

  const bothConnected = useMemo(
    () => joinState === "ready" && role !== null && remoteActive,
    [joinState, remoteActive, role]
  );

  const statusClass = useMemo(() => statusLabel.toLowerCase().replaceAll(" ", "-"), [statusLabel]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <span className="brand-mark">TALKY</span>
        <div className="connection-dots" aria-label="Statut de connexion">
          <span className={`connection-dot ${joinState === "ready" ? "on" : ""}`} />
          <span className={`connection-dot ${bothConnected ? "on" : ""}`} />
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
            <p className="subtle">Room complete: deja 2 personnes.</p>
            <Link className="ghost-btn link-btn" href="/">
              Retour
            </Link>
          </>
        ) : (
          <>
            <div className="row">
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
                    event.currentTarget.setPointerCapture(event.pointerId);
                    handlePressStart();
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onPointerUp={(event) => {
                    event.preventDefault();
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                    handlePressEnd();
                  }}
                  onPointerCancel={handlePressEnd}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  {isTransmitting ? "Parle..." : "Maintenir pour parler"}
                </button>
              </div>
            </div>

            <p className="speaker-line">Canal pris par: {channelOwnerLabel}</p>
            <p className="subtle">Role: {role ?? "..."}</p>
            <p className="subtle">PIN: {roomId}</p>
            <p className="subtle">Utilisateurs connectes: {bothConnected ? "2/2" : "1/2"}</p>

            {!remoteActive && joinState === "ready" && (
              <p className="subtle">En attente de la deuxieme personne...</p>
            )}

            {busyMessage && <p className="warn-line">{busyMessage}</p>}
          </>
        )}

        {error && <p className="error-line">{error}</p>}
      </section>

      <audio ref={remoteAudioRef} autoPlay playsInline />
    </main>
  );
}
