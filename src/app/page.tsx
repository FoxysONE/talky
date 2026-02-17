"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const PIN_LENGTH = 4;
const PIN_KEY = "talky_pin";

function createPin(): string {
  const value = Math.floor(Math.random() * 10000);
  return value.toString().padStart(PIN_LENGTH, "0");
}

function normalizePin(value: string): string {
  return value.replaceAll(/\D/g, "").slice(0, PIN_LENGTH);
}

export default function HomePage() {
  const router = useRouter();
  const [roomInput, setRoomInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [localPin, setLocalPin] = useState<string | null>(null);

  const canJoin = useMemo(() => roomInput.trim().length === PIN_LENGTH, [roomInput]);

  useEffect(() => {
    const saved = window.localStorage.getItem(PIN_KEY);
    if (saved && saved.length === PIN_LENGTH) {
      setLocalPin(saved);
      setRoomInput(saved);
      return;
    }

    const newPin = createPin();
    window.localStorage.setItem(PIN_KEY, newPin);
    setLocalPin(newPin);
    setRoomInput(newPin);
  }, []);

  const handleCreateRoom = () => {
    const pin = localPin ?? createPin();
    if (!localPin) {
      window.localStorage.setItem(PIN_KEY, pin);
      setLocalPin(pin);
      setRoomInput(pin);
    }
    router.push(`/r/${pin}`);
  };

  const handleJoinRoom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const roomId = roomInput.trim();

    if (roomId.length !== PIN_LENGTH) {
      setError(`PIN invalide: ${PIN_LENGTH} chiffres.`);
      return;
    }

    setError(null);
    router.push(`/r/${roomId}`);
  };

  return (
    <main className="app-shell retro">
      <header className="topbar retro-panel">
        <span className="brand-mark">TALKY</span>
        <span className="topbar-sub">RETRO LINK MODE</span>
      </header>

      <section className="hero reveal retro-panel">
        <div className="screen">
          <p className="eyebrow">TALKIE</p>
          <h1 className="brand">Talky</h1>
          <p className="subtle">P2P mesh, PIN local 4 chiffres.</p>
        </div>

        <div className="hero-actions">
          <div className="talkie-face compact">
            <div className="speaker-grill" aria-hidden="true" />
            <div className="knob-row" aria-hidden="true">
              <span className="knob">CH 1</span>
              <span className="knob">VOL</span>
              <span className="knob">BAT</span>
            </div>
          </div>

          <button type="button" className="action-btn" onClick={handleCreateRoom}>
            Lancer room
          </button>

          <form className="controls" onSubmit={handleJoinRoom}>
            <label htmlFor="room-id" className="subtle">
              PIN (4 chiffres)
            </label>
            <input
              id="room-id"
              className="text-input"
              type="text"
              value={roomInput}
              onChange={(event) => setRoomInput(normalizePin(event.target.value))}
              placeholder="0000"
              spellCheck={false}
              autoComplete="off"
              inputMode="numeric"
            />
            <button type="submit" className="ghost-btn" disabled={!canJoin}>
              Rejoindre
            </button>
          </form>

          {localPin && <p className="subtle">PIN local: {localPin}</p>}
          {error && <p className="error-line">{error}</p>}
        </div>
      </section>
    </main>
  );
}
