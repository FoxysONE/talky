const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }]
};

interface CreatePeerArgs {
  localStream: MediaStream;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
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
// Signaling helpers are now handled directly in the room page for mesh connections.
