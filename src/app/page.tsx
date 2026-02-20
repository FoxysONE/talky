"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const PIN_LENGTH = 4;
const PIN_KEY    = "talky_pin";

function createPin(): string {
  return Math.floor(Math.random() * 10000).toString().padStart(PIN_LENGTH, "0");
}

function normalizePin(v: string): string {
  return v.replaceAll(/\D/g, "").slice(0, PIN_LENGTH);
}

export default function HomePage() {
  const router = useRouter();
  const [roomInput, setRoomInput] = useState("");
  const [error,     setError    ] = useState<string | null>(null);
  const [localPin,  setLocalPin ] = useState<string | null>(null);

  const canJoin = useMemo(() => roomInput.trim().length === PIN_LENGTH, [roomInput]);

  useEffect(() => {
    const saved = window.localStorage.getItem(PIN_KEY);
    if (saved && saved.length === PIN_LENGTH) {
      setLocalPin(saved);
      setRoomInput(saved);
      return;
    }
    const pin = createPin();
    window.localStorage.setItem(PIN_KEY, pin);
    setLocalPin(pin);
    setRoomInput(pin);
  }, []);

  const handleCreate = () => {
    const pin = localPin ?? createPin();
    if (!localPin) {
      window.localStorage.setItem(PIN_KEY, pin);
      setLocalPin(pin);
      setRoomInput(pin);
    }
    router.push(`/r/${pin}`);
  };

  const handleJoin = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const id = roomInput.trim();
    if (id.length !== PIN_LENGTH) { setError("FREQ INVALIDE"); return; }
    setError(null);
    router.push(`/r/${id}`);
  };

  return (
    <main className="shell">
      <div className="device">

        {/* Antenne */}
        <div className="device-antenna" aria-hidden="true">
          <div className="antenna-shaft" />
        </div>

        {/* Marque + LEDs */}
        <div className="device-topstrip">
          <span className="brand-text">TALKY</span>
          <div className="led-row" aria-hidden="true">
            <span className="led-dot on" />
            <span className="led-dot" />
          </div>
        </div>

        {/* Grille haut-parleur */}
        <div className="speaker-holes" aria-hidden="true" />

        {/* Écran LCD — PIN affiché comme fréquence */}
        <div className="lcd-screen">
          <span className="lcd-label">CANAL</span>
          <div className="lcd-freq">
            <span className="lcd-prefix">462.</span>
            <span className="lcd-pin">{roomInput || "0000"}</span>
          </div>
          <span className="lcd-sub">
            {localPin ? `MEM\u00a0${localPin}\u00a0\u00b7\u00a0SIMPLEX` : "MHz\u00a0\u00b7\u00a0SIMPLEX"}
          </span>
        </div>

        {/* Contrôles */}
        <div className="device-panel">

          {/* Bouton principal */}
          <button type="button" className="btn-launch" onClick={handleCreate}>
            LANCER
          </button>

          <div className="panel-sep" aria-hidden="true" />

          {/* Syntonisation */}
          <form className="tune-form" onSubmit={handleJoin}>
            <span className="tune-label">SYNTONISER</span>
            <div className="tune-row">
              <span className="tune-prefix">462.</span>
              <input
                id="room-id"
                className="tune-input"
                type="text"
                value={roomInput}
                onChange={(e) => setRoomInput(normalizePin(e.target.value))}
                placeholder="0000"
                spellCheck={false}
                autoComplete="off"
                inputMode="numeric"
              />
              <button type="submit" className="tune-btn" disabled={!canJoin}>
                &#x21B5;
              </button>
            </div>
          </form>

          {error && <p className="device-msg error">{error}</p>}

        </div>

        {/* Trous microphone */}
        <div className="mic-holes" aria-hidden="true" />

      </div>
    </main>
  );
}
