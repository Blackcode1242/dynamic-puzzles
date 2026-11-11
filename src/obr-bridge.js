import OBR from '@owlbear-rodeo/sdk';

export const EXTENSION_ID = 'com.dynamicpuzzles.extension';
export const ROOM_METADATA_KEY = `${EXTENSION_ID}/room-state`;
export const BROADCAST_CHANNEL = `${EXTENSION_ID}/v1`;

let currentRole = 'GM';
let connected = false;
let handlers = {};
let partyPlayers = [];
let currentPlayer = null;

function waitForReady() {
  return new Promise((resolve) => OBR.onReady(resolve));
}

function normalizePlayer(player, fallback = {}) {
  const id = String(player?.id || fallback.id || '');
  if (!id) return null;
  return {
    id,
    connectionId: String(player?.connectionId || fallback.connectionId || ''),
    name: String(player?.name || player?.metadata?.name || fallback.name || `Jogador ${id.slice(0, 6)}`),
    role: String(player?.role || fallback.role || 'PLAYER'),
    color: String(player?.color || fallback.color || '#a78bfa'),
  };
}

function publishParty(players) {
  partyPlayers = (players || []).map((player) => normalizePlayer(player)).filter(Boolean);
  if (currentPlayer && !partyPlayers.some((player) => player.id === currentPlayer.id)) {
    partyPlayers.unshift(currentPlayer);
  }
  handlers.onPartyChange?.([...partyPlayers]);
}

async function refreshParty() {
  if (!connected) return [];
  const others = await OBR.party.getPlayers().catch(() => []);
  publishParty([...(others || []), currentPlayer]);
  return [...partyPlayers];
}

export async function connectToOwlbear(callbacks = {}) {
  handlers = callbacks;
  if (!OBR.isAvailable) {
    return {
      connected: false,
      role: 'GM',
      roomId: 'demo-room',
      playerId: 'demo-player',
      playerName: 'Mestre (demonstração)',
      partyPlayers: [],
      publicState: null,
    };
  }

  await waitForReady();
  connected = true;
  currentRole = await OBR.player.getRole();
  const roomId = OBR.room.id || 'unknown-room';
  const playerName = await OBR.player.getName().catch(() => 'Jogador');
  const playerId = String(OBR.player.id || await OBR.player.getId());
  const connectionId = await OBR.player.getConnectionId().catch(() => '');
  currentPlayer = normalizePlayer({ id: playerId, connectionId, name: playerName, role: currentRole });
  await refreshParty();

  OBR.room.onMetadataChange((metadata) => {
    const publicState = metadata?.[ROOM_METADATA_KEY];
    if (publicState && handlers.onPublicState) handlers.onPublicState(publicState);
  });

  OBR.party.onChange((players) => publishParty([...(players || []), currentPlayer]));

  OBR.broadcast.onMessage(BROADCAST_CHANNEL, (event) => {
    const message = event?.data;
    if (!message || typeof message !== 'object') return;
    const sender = partyPlayers.find((player) => player.connectionId && player.connectionId === event.connectionId);
    const senderId = sender?.id || null;
    const senderName = sender?.name || String(message.playerName || 'Jogador').slice(0, 48);

    if (currentRole === 'GM' && message.type === 'attempt' && handlers.onAttempt) {
      handlers.onAttempt({
        puzzleId: String(message.puzzleId || ''),
        payload: message.payload,
        playerId: senderId,
        playerName: senderName,
        connectionId: String(event.connectionId || ''),
      });
    }
    if (message.type === 'activity' && handlers.onActivity && senderId && senderId !== currentPlayer?.id) {
      handlers.onActivity({
        puzzleId: String(message.puzzleId || ''),
        playerId: senderId,
        playerName: senderName,
        activity: String(message.activity || 'interagindo com o enigma').slice(0, 90),
        at: Number(message.sentAt) || Date.now(),
      });
    }
  });

  const metadata = await OBR.room.getMetadata();
  const publicState = metadata?.[ROOM_METADATA_KEY] || null;

  return {
    connected: true,
    role: currentRole,
    roomId,
    playerId,
    playerName,
    partyPlayers: [...partyPlayers],
    publicState,
  };
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

export async function sendActivity(puzzleId, activity) {
  if (!connected || currentRole !== 'PLAYER') return false;
  await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, {
    type: 'activity',
    puzzleId,
    activity: String(activity || 'interagindo com o enigma').slice(0, 90),
    sentAt: Date.now(),
  });
  return true;
}

export function showNotification(message, type = 'INFO') {
  if (!connected) return;
  OBR.notification.show(message, type);
}
