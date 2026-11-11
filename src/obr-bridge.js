import OBR from '@owlbear-rodeo/sdk';

export const EXTENSION_ID = 'com.dynamicpuzzles.extension';
export const ROOM_METADATA_KEY = `${EXTENSION_ID}/room-state`;
export const BROADCAST_CHANNEL = `${EXTENSION_ID}/v1`;

let currentRole = 'GM';
let connected = false;
let handlers = {};

function waitForReady() {
  return new Promise((resolve) => OBR.onReady(resolve));
}

export async function connectToOwlbear(callbacks = {}) {
  handlers = callbacks;
  if (!OBR.isAvailable) {
    return {
      connected: false,
      role: 'GM',
      roomId: 'demo-room',
      playerName: 'Mestre (demonstração)',
      publicState: null,
    };
  }

  await waitForReady();
  connected = true;
  currentRole = await OBR.player.getRole();
  const roomId = OBR.room.id || 'unknown-room';
  const playerName = await OBR.player.getName().catch(() => 'Jogador');

  OBR.room.onMetadataChange((metadata) => {
    const publicState = metadata?.[ROOM_METADATA_KEY];
    if (publicState && handlers.onPublicState) handlers.onPublicState(publicState);
  });

  OBR.broadcast.onMessage(BROADCAST_CHANNEL, (event) => {
    const message = event?.data;
    if (currentRole === 'GM' && message?.type === 'attempt' && handlers.onAttempt) {
      handlers.onAttempt({
        puzzleId: message.puzzleId,
        payload: message.payload,
        playerName: String(message.playerName || 'Jogador').slice(0, 48),
      });
    }
  });

  const metadata = await OBR.room.getMetadata();
  const publicState = metadata?.[ROOM_METADATA_KEY] || null;

  return { connected: true, role: currentRole, roomId, playerName, publicState };
}

export async function publishPublicState(publicState) {
  if (!connected || currentRole !== 'GM') return;
  await OBR.room.setMetadata({ [ROOM_METADATA_KEY]: publicState });
}

export async function submitAttempt(puzzleId, payload, playerName) {
  if (!connected || currentRole !== 'PLAYER') return false;
  await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, {
    type: 'attempt',
    puzzleId,
    payload,
    playerName: String(playerName || 'Jogador').slice(0, 48),
    sentAt: Date.now(),
  });
  return true;
}

export function showNotification(message, type = 'INFO') {
  if (!connected) return;
  OBR.notification.show(message, type);
}
