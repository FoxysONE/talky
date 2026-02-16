"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const MIN_ROOM_LENGTH = 22;

function createRoomId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export default function HomePage() {
  const router = useRouter();
  const [roomInput, setRoomInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canJoin = useMemo(() => roomInput.trim().length >= MIN_ROOM_LENGTH, [roomInput]);

  const handleCreateRoom = () => {
    const roomId = createRoomId();
    router.push(`/r/${roomId}`);
  };

  const handleJoinRoom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const roomId = roomInput.trim();

    if (roomId.length < MIN_ROOM_LENGTH) {
      setError(`Room invalide: minimum ${MIN_ROOM_LENGTH} caracteres.`);
      return;
    }

    setError(null);
    router.push(`/r/${roomId}`);
  };

  return (
    <main className="app-shell">
      <section className="card reveal">
        <p className="eyebrow">Talky</p>
        <h1 className="brand">Talkie-walkie web minimaliste</h1>
        <p className="subtle">2 personnes, un lien secret, maintenir pour parler.</p>

        <button type="button" className="action-btn" onClick={handleCreateRoom}>
          Creer une room
        </button>

        <form className="controls" onSubmit={handleJoinRoom}>
          <label htmlFor="room-id" className="subtle">
            Rejoindre avec un roomId
          </label>
          <input
            id="room-id"
            className="text-input"
            type="text"
            value={roomInput}
            onChange={(event) => setRoomInput(event.target.value)}
            placeholder="Colle le roomId ici"
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" className="ghost-btn" disabled={!canJoin}>
            Rejoindre
          </button>
        </form>

        {error && <p className="error-line">{error}</p>}
      </section>
    </main>
  );
}

