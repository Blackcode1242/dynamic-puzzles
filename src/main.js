import './style.css';
import {
  PUZZLE_TYPES,
  ERROR_EFFECTS,
  DEFAULT_SYMBOLS,
  makePuzzle,
  evaluateAttempt,
  attemptLabel,
  toPublicState,
  createDemoPuzzles,
  PUZZLE_TEMPLATES,
  getPuzzleTemplate,
  recalculateSequenceLocks,
  PARTICIPATION_MODES,
  canPlayerInteract,
} from './model.js';
import {
  connectToOwlbear,
  publishPublicState,
  submitAttempt as sendRemoteAttempt,
  sendActivity,
  showNotification,
} from './obr-bridge.js';

const root = document.querySelector('#app');
const PRIVATE_STORAGE_PREFIX = 'dynamic-puzzles:private:v1:';
const MAX_PUZZLES = 20;
const ROOM_METADATA_LIMIT = 13_500;
const TYPE_LABELS = Object.fromEntries(PUZZLE_TYPES.map((type) => [type.id, type.label]));

const state = {
  connected: false,
  role: 'GM',
  roomId: 'demo-room',
  playerName: 'Mestre (demonstração)',
  playerId: 'demo-player',
  partyPlayers: [],
  activePlayers: {},
  demoMode: true,
  tab: 'room',
  selectedPuzzleId: null,
  publicState: { schema: 1, puzzles: [] },
  privatePuzzles: [],
  editorDraft: null,
  editorId: null,
  notice: '',
  noticeTone: 'info',
  sequence: [],
  selectedWireId: null,
  fragmentOrder: [],
  switches: [],
  playerNameDraft: '',
  cipherOffset: 0,
  draggedFragmentId: null,
  runePlacements: [],
  selectedRuneId: null,
  draggedRuneId: null,
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeText(value, max = 600) {
  return String(value ?? '').trim().slice(0, max);
}

function getPrivateStorageKey() {
  return `${PRIVATE_STORAGE_PREFIX}${state.roomId}`;
}

function loadPrivatePuzzles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(getPrivateStorageKey()) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePrivatePuzzles() {
  try {
    localStorage.setItem(getPrivateStorageKey(), JSON.stringify(state.privatePuzzles));
    return true;
  } catch (error) {
    console.error('Não foi possível salvar os enigmas privados:', error);
    setNotice('O navegador não conseguiu salvar as respostas neste dispositivo. Verifique o armazenamento local.', 'error');
    return false;
  }
}

function currentPublicPuzzles() {
  return state.publicState?.puzzles || [];
}

function getPuzzle(id) {
  return currentPublicPuzzles().find((puzzle) => puzzle.id === id) || null;
}

function getPrivatePuzzle(id) {
  return state.privatePuzzles.find((puzzle) => puzzle.id === id) || null;
}

function getSelectedPuzzle() {
  const puzzle = getPuzzle(state.selectedPuzzleId) || currentPublicPuzzles()[0] || null;
  if (!puzzle || state.role === 'GM' || puzzle.participationMode !== 'individual') return puzzle;
  return { ...puzzle, ...(puzzle.playerProgress?.[state.playerId] || {}), playerProgress: puzzle.playerProgress || {} };
}

function setNotice(message, tone = 'info') {
  state.notice = message;
  state.noticeTone = tone;
  render();
}

function setPublicState(publicState) {
  if (!publicState || !Array.isArray(publicState.puzzles)) return;
  state.publicState = publicState;
  if (!state.selectedPuzzleId || !getPuzzle(state.selectedPuzzleId)) {
    state.selectedPuzzleId = publicState.puzzles[0]?.id || null;
  }
  state.sequence = [];
  state.selectedWireId = null;
  state.fragmentOrder = [];
  state.switches = [];
  state.runePlacements = [];
  state.selectedRuneId = null;
  render();
}

function compactPublicState(publicState) {
  const next = structuredClone(publicState);
  const measure = () => new TextEncoder().encode(JSON.stringify(next)).length;
  if (measure() > ROOM_METADATA_LIMIT) {
    for (const puzzle of next.puzzles) {
      puzzle.history = (puzzle.history || []).slice(-6);
      for (const progress of Object.values(puzzle.playerProgress || {})) {
        if (Array.isArray(progress.history)) progress.history = progress.history.slice(-3);
      }
    }
  }
  if (measure() > ROOM_METADATA_LIMIT) {
    for (const puzzle of next.puzzles) {
      puzzle.history = [];
      for (const progress of Object.values(puzzle.playerProgress || {})) delete progress.history;
    }
  }
  return next;
}

async function publishCurrentState() {
  const rawState = toPublicState(state.privatePuzzles);
  const publicState = compactPublicState(rawState);
  const size = new TextEncoder().encode(JSON.stringify(publicState)).length;
  if (size > ROOM_METADATA_LIMIT) {
    setNotice('O estado compartilhado ultrapassou o limite seguro de 13,5 KB do Owlbear. Reduza textos ou remova alguns enigmas.', 'error');
    return false;
  }
  state.publicState = publicState;
  try {
    if (state.connected) await publishPublicState(publicState);
    render();
    return true;
  } catch (error) {
    console.error('Falha ao sincronizar com Owlbear:', error);
    setNotice('Não foi possível sincronizar com a sala do Owlbear. Confira a conexão e tente novamente.', 'error');
    return false;
  }
}

function saveAndPublish() {
  if (state.role === 'GM' && !savePrivatePuzzles()) return Promise.resolve(false);
  return publishCurrentState();
}

async function bootstrap() {
  try {
    const connection = await connectToOwlbear({
      onPublicState: (publicState) => setPublicState(publicState),
      onAttempt: (request) => queueAttempt(request),
      onPartyChange: (players) => {
        const editorForm = root.querySelector('form[data-form="puzzle-editor"]');
        if (editorForm) state.editorDraft = { ...state.editorDraft, ...readForm(editorForm) };
        state.partyPlayers = players;
        render();
      },
      onActivity: (activity) => { state.activePlayers[activity.playerId] = activity; refreshActivityIndicator(); },
    });
    state.connected = connection.connected;
    state.role = connection.role;
    state.roomId = connection.roomId;
    state.playerName = connection.playerName || 'Jogador';
    state.playerId = connection.playerId || 'demo-player';
    state.partyPlayers = connection.partyPlayers || [];
    state.demoMode = !connection.connected;
    state.playerNameDraft = state.playerName;

    if (state.role === 'GM') {
      state.privatePuzzles = loadPrivatePuzzles();
      recalculateSequenceLocks(state.privatePuzzles);
      if (state.demoMode && state.privatePuzzles.length === 0) {
        state.privatePuzzles = createDemoPuzzles();
        savePrivatePuzzles();
      }
      if (state.privatePuzzles.length) {
        state.publicState = toPublicState(state.privatePuzzles);
        if (state.connected) {
          try { await publishCurrentState(); } catch (error) { console.warn(error); }
        }
      } else if (connection.publicState) {
        state.publicState = connection.publicState;
        state.notice = 'Este mestre não tem as respostas privadas salvas neste navegador. Os enigmas existentes estão visíveis, mas não podem ser validados por este dispositivo.';
        state.noticeTone = 'warning';
      }
    } else {
      state.publicState = connection.publicState || { schema: 1, puzzles: [] };
      if (!connection.publicState) {
        state.notice = 'Aguardando o mestre publicar os enigmas nesta sala.';
        state.noticeTone = 'info';
      }
    }
    state.selectedPuzzleId = state.publicState.puzzles?.[0]?.id || null;
    render();
  } catch (error) {
    console.error('Erro ao iniciar Dynamic Puzzles:', error);
    state.demoMode = true;
    state.connected = false;
    state.role = 'GM';
    state.privatePuzzles = createDemoPuzzles();
    state.publicState = toPublicState(state.privatePuzzles);
    state.selectedPuzzleId = state.publicState.puzzles[0]?.id || null;
    setNotice('O SDK do Owlbear não respondeu. A extensão abriu em modo de demonstração local.', 'warning');
  }
}

function recordAttempt(privatePuzzle, payload, actor, playerId = 'shared') {
  const individual = privatePuzzle.public.participationMode === 'individual';
  const storedPublic = privatePuzzle.public;
  const playerProgress = individual ? (storedPublic.playerProgress?.[playerId] || {}) : null;
  const workingPuzzle = individual ? { ...privatePuzzle, public: { ...storedPublic, attemptsUsed: playerProgress.attemptsUsed || 0, consequenceCount: playerProgress.consequenceCount || 0, clockCount: playerProgress.clockCount || 0, alarmCount: playerProgress.alarmCount || 0, solved: Boolean(playerProgress.solved), locked: Boolean(playerProgress.locked), questionIndex: playerProgress.questionIndex || 0, solvedQuestionIds: playerProgress.solvedQuestionIds || [], history: storedPublic.history || [], reveal: playerProgress.solved ? privatePuzzle.reward : null } } : privatePuzzle;
  const publicPuzzle = workingPuzzle.public;
  if (publicPuzzle.sequenceLocked) return { ok: false, solved: false, message: 'Esta etapa ainda depende da conclusão do enigma anterior.' };
  if (publicPuzzle.solved) return { ok: false, solved: false, message: 'Este enigma já foi resolvido.' };
  if (publicPuzzle.locked) return { ok: false, solved: false, message: 'Este enigma está bloqueado. Peça ao mestre para reiniciá-lo.' };
  const evaluation = evaluateAttempt(workingPuzzle, payload);
  const correct = evaluation.correct;
  const solved = evaluation.solved;
  if (evaluation.progressUpdate) {
    publicPuzzle.questionIndex = evaluation.progressUpdate.questionIndex;
    publicPuzzle.solvedQuestionIds = evaluation.progressUpdate.solvedQuestionIds;
  }
  // No Hack Social, respostas corretas avançam o progresso; o limite conta apenas erros.
  if (privatePuzzle.type !== 'social' || !correct) publicPuzzle.attemptsUsed += 1;
  const submitted = attemptLabel(workingPuzzle, payload).slice(0, 110);
  const entry = {
    id: crypto.randomUUID(),
    actor: safeText(actor || 'Jogador', 48),
    actorId: String(playerId || ''),
    submitted,
    result: solved ? 'success' : correct ? 'progress' : 'failure',
    feedback: evaluation.feedback || null,
    at: Date.now(),
  };
  publicPuzzle.history = [...(publicPuzzle.history || []), entry].slice(-15);
  publicPuzzle.updatedAt = Date.now();

  if (solved) {
    publicPuzzle.solved = true;
    publicPuzzle.locked = false;
    publicPuzzle.reveal = privatePuzzle.reward;
  } else if (!correct) {
    if (publicPuzzle.errorEffect !== 'none') publicPuzzle.consequenceCount += 1;
    if (publicPuzzle.errorEffect === 'clock') publicPuzzle.clockCount += 1;
    if (publicPuzzle.errorEffect === 'alarm') publicPuzzle.alarmCount += 1;
    if (publicPuzzle.errorEffect === 'lockdown') publicPuzzle.locked = true;
    if (publicPuzzle.attemptLimit > 0 && publicPuzzle.attemptsUsed >= publicPuzzle.attemptLimit) {
      publicPuzzle.locked = true;
    }
  }

  if (individual) {
    const individualHistory = [...(playerProgress.history || []), entry].slice(-15);
    storedPublic.playerProgress = { ...(storedPublic.playerProgress || {}), [playerId]: { attemptsUsed: publicPuzzle.attemptsUsed, consequenceCount: publicPuzzle.consequenceCount, clockCount: publicPuzzle.clockCount, alarmCount: publicPuzzle.alarmCount, solved: publicPuzzle.solved, locked: publicPuzzle.locked, questionIndex: publicPuzzle.questionIndex, solvedQuestionIds: publicPuzzle.solvedQuestionIds, history: individualHistory, updatedAt: Date.now() } };
    const allProgress = Object.values(storedPublic.playerProgress);
    storedPublic.attemptsUsed = allProgress.reduce((sum, item) => sum + (item.attemptsUsed || 0), 0);
    storedPublic.consequenceCount = allProgress.reduce((sum, item) => sum + (item.consequenceCount || 0), 0);
    storedPublic.clockCount = allProgress.reduce((sum, item) => sum + (item.clockCount || 0), 0);
    storedPublic.alarmCount = allProgress.reduce((sum, item) => sum + (item.alarmCount || 0), 0);
    const participantIds = state.partyPlayers.filter((player) => player.role === 'PLAYER').map((player) => player.id);
    const everyoneFinished = participantIds.length > 0 && participantIds.every((id) => storedPublic.playerProgress[id]?.solved);
    if (everyoneFinished || (state.demoMode && solved)) {
      storedPublic.solved = true;
      storedPublic.reveal = privatePuzzle.reward;
    }
    storedPublic.updatedAt = Date.now();
  }
  const message = solved
    ? `Enigma resolvido: ${privatePuzzle.title}`
    : correct
      ? evaluation.feedback?.text || 'Etapa concluída. Continue o desafio.'
      : publicPuzzle.locked
        ? 'Resposta incorreta. O enigma foi bloqueado.'
        : evaluation.feedback?.text || 'Resposta incorreta. A consequência foi registrada.';
  return { ok: correct, solved, message, feedback: evaluation.feedback };
}

async function processAttempt(request) {
  if (state.role !== 'GM') return;
  const privatePuzzle = getPrivatePuzzle(request?.puzzleId);
  if (!privatePuzzle) return;
  const playerId = request.playerId || request.connectionId || '';
  if (!playerId) return;
  if (privatePuzzle.public.participationMode === 'controlled' && !request.playerId) { setNotice('Não foi possível identificar com segurança o jogador que enviou a tentativa.', 'warning'); return; }
  if (!canPlayerInteract(privatePuzzle.public, playerId, 'PLAYER')) { setNotice(`${request.playerName || 'O jogador'} tentou interagir sem permissão neste enigma.`, 'warning'); return; }
  const result = recordAttempt(privatePuzzle, request.payload, request.playerName || 'Jogador', playerId);
  recalculateSequenceLocks(state.privatePuzzles);
  await saveAndPublish();
  if (state.connected) showNotification(result.message, result.ok ? 'SUCCESS' : 'WARNING');
  if (state.demoMode) setNotice(result.message, result.ok ? 'success' : 'warning');
}

async function submitPayload(payload) {
  const puzzle = getSelectedPuzzle();
  if (!puzzle) return;
  if (state.connected && state.role === 'PLAYER') sendActivity(puzzle.id, 'enviando uma tentativa');
  if (puzzle.sequenceLocked && state.role === 'PLAYER') {
    setNotice('Esta etapa será liberada quando o enigma anterior da sequência for resolvido.', 'warning');
    return;
  }
  if (puzzle.solved || puzzle.locked) {
    setNotice(puzzle.solved ? 'Este enigma já foi solucionado.' : 'Este enigma está bloqueado.', 'warning');
    return;
  }

  if (state.role === 'PLAYER' && !canPlayerInteract(puzzle, state.playerId, state.role)) { setNotice('Este enigma está em modo colaborativo com controle. Aguarde o mestre liberar sua participação.', 'warning'); return; }
  if (state.connected && state.role === 'PLAYER') {
    try {
      await sendRemoteAttempt(puzzle.id, payload, state.playerNameDraft || state.playerName);
      setNotice('Tentativa enviada ao mestre. O resultado aparecerá assim que a sala for atualizada.', 'info');
    } catch (error) {
      console.error(error);
      setNotice('Não foi possível enviar sua tentativa. Verifique sua conexão com a sala.', 'error');
    }
    return;
  }

  const privatePuzzle = getPrivatePuzzle(puzzle.id);
  if (!privatePuzzle) {
    setNotice('O mestre precisa abrir a extensão no dispositivo onde as respostas privadas foram configuradas.', 'warning');
    return;
  }
  const result = recordAttempt(privatePuzzle, payload, state.demoMode ? 'Você (teste)' : 'Teste do mestre', state.playerId);
  recalculateSequenceLocks(state.privatePuzzles);
  await saveAndPublish();
  setNotice(result.message, result.ok ? 'success' : 'warning');
  if (state.connected) showNotification(result.message, result.ok ? 'SUCCESS' : 'WARNING');
}

function statusChip(puzzle) {
  if (puzzle.solved) return '<span class="pill pill-success"><span class="dot"></span> Resolvido</span>';
  if (puzzle.locked) return '<span class="pill pill-danger"><span class="dot"></span> Bloqueado</span>';
  if (puzzle.sequenceLocked) return '<span class="pill pill-neutral"><span class="dot"></span> Aguardando etapa</span>';
  return '<span class="pill pill-neutral"><span class="dot"></span> Em aberto</span>';
}

function renderHeader() {
  const roleText = state.demoMode ? 'MODO DEMONSTRAÇÃO' : state.role === 'GM' ? 'MESTRE' : 'JOGADOR';
  return `
    <header class="topbar">
      <div class="brand-lockup">
        <div class="brand-mark"><span>✦</span></div>
        <div><div class="brand-name">DYNAMIC <b>PUZZLES</b></div><div class="brand-subtitle">SALA DE ENIGMAS INTERATIVOS</div></div>
      </div>
      <div class="topbar-right">
        <span class="connection-pill ${state.connected ? 'is-connected' : 'is-demo'}"><i></i>${escapeHtml(roleText)}</span>
        <span class="room-label">${state.demoMode ? 'Ambiente local' : `Sala ${escapeHtml(state.roomId.slice(0, 7))}`}</span>
      </div>
    </header>`;
}

function renderTabs() {
  return `
    <nav class="tabs" aria-label="Navegação principal">
      <button class="tab ${state.tab === 'room' ? 'active' : ''}" data-action="tab-room"><span class="tab-icon">◈</span> Sala de enigmas</button>
      ${state.role === 'GM' ? `<button class="tab ${state.tab === 'master' ? 'active' : ''}" data-action="tab-master"><span class="tab-icon">⚙</span> Estúdio do mestre</button><button class="tab ${state.tab === 'library' ? 'active' : ''}" data-action="tab-library"><span class="tab-icon">▦</span> Modelos</button><button class="tab ${state.tab === 'guide' ? 'active' : ''}" data-action="tab-guide"><span class="tab-icon">☷</span> Guia do mestre</button>` : ''}
    </nav>`;
}

function renderNotice() {
  if (!state.notice) return '';
  return `<div class="notice notice-${escapeHtml(state.noticeTone)}"><span class="notice-mark">${state.noticeTone === 'success' ? '✓' : state.noticeTone === 'error' ? '!' : 'i'}</span><span>${escapeHtml(state.notice)}</span><button class="notice-close" data-action="dismiss-notice" aria-label="Fechar aviso">×</button></div>`;
}

function renderRoom() {
  const puzzles = currentPublicPuzzles();
  const selected = getSelectedPuzzle();
  if (!puzzles.length) {
    return `<section class="empty-room"><div class="empty-orbit">✧</div><p class="eyebrow">SALA SEM ENIGMAS</p><h1>O mistério começa aqui.</h1><p>O mestre ainda não publicou nenhum desafio nesta sala.</p>${state.role === 'GM' ? `<button class="button button-primary" data-action="tab-master">Criar primeiro enigma <span>↗</span></button>` : '<span class="muted">Aguardando configuração do mestre…</span>'}</section>`;
  }
  return `
    <section class="room-layout">
      <aside class="puzzle-sidebar">
        <div class="sidebar-heading"><div><span class="eyebrow">ARQUIVO DA SALA</span><h2>Desafios</h2></div><span class="count-badge">${puzzles.length.toString().padStart(2, '0')}</span></div>
        <div class="puzzle-list">
          ${puzzles.map((puzzle, index) => `
            <button class="puzzle-nav-item ${selected?.id === puzzle.id ? 'selected' : ''} ${puzzle.sequenceLocked && state.role === 'PLAYER' ? 'sequence-waiting' : ''}" data-action="select-puzzle" data-id="${escapeHtml(puzzle.id)}">
              <span class="puzzle-number">${String(index + 1).padStart(2, '0')}</span>
              <span class="puzzle-nav-copy"><strong>${escapeHtml(puzzle.title)}</strong><small>${escapeHtml(TYPE_LABELS[puzzle.type] || puzzle.type)}</small></span>
              <span class="nav-state ${puzzle.solved ? 'done' : puzzle.locked || (puzzle.sequenceLocked && state.role === 'PLAYER') ? 'locked' : ''}"></span>
            </button>`).join('')}
        </div>
        <div class="sidebar-foot"><span class="live-indicator"></span> Estado compartilhado da sala</div>
      </aside>
      <main class="puzzle-stage">
        ${selected ? renderPuzzleWorkspace(selected) : ''}
      </main>
    </section>`;
}

function renderPuzzleWorkspace(puzzle) {
  const canInteract = canPlayerInteract(puzzle, state.playerId, state.role);
  const modeLabel = PARTICIPATION_MODES.find((mode) => mode.id === (puzzle.participationMode || 'shared'))?.label || 'Compartilhado';
  const activity = Object.values(state.activePlayers).filter((item) => item.puzzleId === puzzle.id && Date.now() - item.at < 12000);
  const consequence = [];
  if (puzzle.clockCount) consequence.push(`<span class="counter counter-clock">◷ Relógio +${puzzle.clockCount}</span>`);
  if (puzzle.alarmCount) consequence.push(`<span class="counter counter-alarm">♢ Alarmes ${puzzle.alarmCount}</span>`);
  const attemptsNoun = puzzle.type === 'social' ? 'Erros' : 'Tentativas';
  const attemptsLabel = puzzle.attemptLimit > 0 ? `${puzzle.attemptsUsed} / ${puzzle.attemptLimit}` : `${puzzle.attemptsUsed} / ∞`;
  return `
    <div class="puzzle-heading-row">
      <div><span class="eyebrow">${escapeHtml(TYPE_LABELS[puzzle.type] || 'ENIGMA')} · ${escapeHtml(modeLabel.toUpperCase())}</span><h1>${escapeHtml(puzzle.title)}</h1></div>
      ${statusChip(puzzle)}
    </div>
    ${puzzle.description ? `<p class="puzzle-description">${escapeHtml(puzzle.description)}</p>` : ''}
    <div class="puzzle-meta-row"><span>⌁ ${attemptsNoun} <b>${escapeHtml(attemptsLabel)}</b></span>${consequence.join('')}${puzzle.sequenceName ? `<span class="counter counter-sequence">▤ ${escapeHtml(puzzle.sequenceName)} · etapa ${puzzle.sequenceOrder}</span>` : ''}</div>
    ${renderRevealedHints(puzzle)}
    <div class="multiplayer-activity" data-multiplayer-activity ${activity.length ? '' : 'hidden'}><span class="live-indicator"></span>${activity.map((item) => `<span>${escapeHtml(item.playerName)} está ${escapeHtml(item.activity)}</span>`).join(' · ')}</div>
    <section class="challenge-card">
      <div class="challenge-topline"><span class="challenge-kicker">INTERFACE DO DESAFIO</span><span class="challenge-coord">DP / ${escapeHtml(puzzle.id.slice(0, 5).toUpperCase())}</span></div>
      ${puzzle.instructions ? `<div class="instruction-box"><span class="instruction-icon">✧</span><p>${escapeHtml(puzzle.instructions)}</p></div>` : ''}
      ${!canInteract && state.role === 'PLAYER' ? '<div class="result-panel result-locked"><div class="result-icon">⌑</div><div><span class="eyebrow">AGUARDANDO AUTORIZAÇÃO</span><h2>Você está acompanhando</h2><p>O mestre ainda não liberou sua interação neste enigma.</p></div></div>' : puzzle.sequenceLocked ? renderSequenceWaiting(puzzle) : puzzle.solved ? renderSolved(puzzle) : puzzle.locked ? renderLocked(puzzle) : renderPlayerControls(puzzle)}
    </section>
    ${renderHistory(puzzle)}
  `;
}

function refreshActivityIndicator() {
  const container = root.querySelector('[data-multiplayer-activity]');
  if (!container) return;
  const puzzle = getSelectedPuzzle();
  const activity = Object.values(state.activePlayers).filter((item) => item.puzzleId === puzzle?.id && Date.now() - item.at < 12000);
  container.hidden = activity.length === 0;
  container.innerHTML = activity.length
    ? `<span class="live-indicator"></span>${activity.map((item) => `<span>${escapeHtml(item.playerName)} está ${escapeHtml(item.activity)}</span>`).join(' · ')}`
    : '';
}

function renderRevealedHints(puzzle) {
  const hints = puzzle.revealedHints || [];
  if (!hints.length) return '';
  return `<section class="revealed-hints"><div class="revealed-hints-heading"><span class="eyebrow">PISTAS LIBERADAS PELO MESTRE</span><span>${hints.length} / ${puzzle.hintCount || hints.length}</span></div><div class="revealed-hint-list">${hints.map((hint, index) => `<article class="revealed-hint"><span>${String(index + 1).padStart(2, '0')}</span><p>${escapeHtml(typeof hint === 'string' ? hint : hint.text)}</p></article>`).join('')}</div></section>`;
}

function renderSequenceWaiting(puzzle) {
  return `<div class="result-panel result-locked"><div class="result-icon">⌁</div><div><span class="eyebrow">SEQUÊNCIA EM ANDAMENTO</span><h2>Esta etapa ainda não foi liberada</h2><p>Conclua a etapa anterior de <b>${escapeHtml(puzzle.sequenceName)}</b> para abrir este desafio. O mestre controla a ordem pela configuração da sequência.</p></div></div>`;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function renderSolved(puzzle) {
  if (puzzle.participationMode === 'individual' && !puzzle.reveal) return `<div class="result-panel result-success"><div class="result-icon">✓</div><div><span class="eyebrow">PROGRESSO INDIVIDUAL</span><h2>Desafio concluído por você</h2><p>Seu progresso foi concluído. Os demais jogadores continuam com suas próprias tentativas.</p></div></div>`;
  const rewardUrl = safeHttpUrl(puzzle.reveal?.url);
  return `<div class="result-panel result-success"><div class="result-icon">✓</div><div><span class="eyebrow">ACESSO CONCEDIDO</span><h2>Enigma solucionado</h2><p>O mestre liberou o conteúdo abaixo para todos na sala.</p>${puzzle.reveal?.title ? `<h3 class="reveal-title">${escapeHtml(puzzle.reveal.title)}</h3>` : ''}${puzzle.reveal?.content ? `<div class="reveal-content">${escapeHtml(puzzle.reveal.content)}</div>` : ''}${rewardUrl ? `<a class="button button-primary reward-link" href="${escapeHtml(rewardUrl)}" target="_blank" rel="noopener noreferrer">Abrir documento / item <span>↗</span></a>` : ''}${!puzzle.reveal?.content && !rewardUrl ? '<div class="reveal-content">Nenhum conteúdo adicional foi configurado.</div>' : ''}</div></div>`;
}

function renderLocked(puzzle) {
  return `<div class="result-panel result-locked"><div class="result-icon">⌑</div><div><span class="eyebrow">SISTEMA EM BLOQUEIO</span><h2>Acesso temporariamente negado</h2><p>O limite de tentativas foi atingido ou uma consequência bloqueou o mecanismo. Peça ao mestre para reiniciar o enigma.</p></div></div>`;
}

function renderPlayerControls(puzzle) {
  switch (puzzle.type) {
    case 'lock': return renderLock(puzzle);
    case 'terminal': return renderTerminal(puzzle);
    case 'cipher': return renderCipher(puzzle);
    case 'frequency': return renderFrequency(puzzle);
    case 'sequence': return renderSequence(puzzle);
    case 'wires': return renderWires(puzzle);
    case 'document': return renderDocument(puzzle);
    case 'switches': return renderSwitches(puzzle);
    case 'social': return renderSocial(puzzle);
    case 'runes': return renderRunes(puzzle);
    default: return '<p class="muted">Tipo de enigma não suportado.</p>';
  }
}

function renderLock(puzzle) {
  if (puzzle.config.mode === 'deduction') {
    const count = puzzle.config.diceCount || 4;
    const sides = puzzle.config.diceSides || 6;
    const grouped = puzzle.config.feedbackMode === 'grouped';
    return `<form class="control-form dice-lock-form" data-form="attempt-dice-lock"><div class="dice-lock-summary"><span class="field-label">DEDUÇÃO DA COMBINAÇÃO</span><strong>${count} × D${sides}</strong><small>${grouped ? 'Retorno agrupado · sem revelar posições' : 'Retorno individual · posição por posição'}</small></div><div class="dice-guess-grid">${Array.from({ length: count }, (_, index) => `<label class="dice-guess-cell"><span>DADO ${String(index + 1).padStart(2, '0')}</span><select data-dice-guess aria-label="Palpite do dado ${index + 1}">${Array.from({ length: sides }, (_, face) => `<option value="${face + 1}">${face + 1}</option>`).join('')}</select></label>`).join('')}</div><p class="field-help">Escolha um valor para cada dado. “Alto” indica que o valor secreto é maior que seu palpite; “baixo” indica que é menor. No modo agrupado, só a quantidade de cada resultado é revelada.</p><button class="button button-primary button-wide" type="submit">Testar combinação <span>→</span></button></form>`;
  }
  if (puzzle.config.mode === 'wheel') {
    return `<form class="control-form" data-form="attempt-lock-wheel"><div class="field-label">AJUSTE OS DISCOS</div><div class="wheel-row">${Array.from({ length: puzzle.config.wheelLength }, (_, index) => `<select class="wheel-select" data-wheel aria-label="Disco ${index + 1}">${'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((symbol) => `<option>${symbol}</option>`).join('')}</select>`).join('')}</div><button class="button button-primary button-wide" type="submit">Confirmar combinação <span>→</span></button></form>`;
  }
  return `<form class="control-form" data-form="attempt-lock"><label class="field-label" for="lock-value">DIGITE A COMBINAÇÃO</label><input id="lock-value" class="code-input" name="value" data-lock-input maxlength="32" autocomplete="off" placeholder="••••••" /><div class="keypad">${'1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((key) => `<button type="button" class="key" data-action="append-key" data-key="${key}">${key}</button>`).join('')}</div><div class="control-actions"><button class="button button-quiet" type="button" data-action="clear-lock">Limpar</button><button class="button button-primary" type="submit">Destravar <span>→</span></button></div></form>`;
}


function renderFrequency(puzzle) {
  const config = puzzle.config || {};
  const channels = config.channels || [];
  const step = Number(config.frequencyStep || 0.1);
  const center = Math.min(config.frequencyMax, Math.max(config.frequencyMin,
    Math.round(((config.frequencyMin + config.frequencyMax) / 2) / step) * step));
  const feedback = [...(puzzle.history || [])].reverse().find((entry) => entry.feedback?.mode === 'frequency')?.feedback;
  const level = Math.max(0, Math.min(4, Number(feedback?.signalLevel) || 0));
  const signalLabels = ['Sem sinal', 'Sinal fraco', 'Sinal moderado', 'Sinal forte', 'Sinal estabilizado'];
  return `<div class="frequency-console">
    <div class="frequency-console-head"><div><span class="field-label">RECEPTOR DE ONDAS</span><strong>SCANNER // RF-07</strong></div><span class="frequency-live"><i></i> BUSCANDO TRANSMISSÃO</span></div>
    <form class="control-form frequency-form" data-form="attempt-frequency">
      <label class="form-field"><span>CANAL DE RECEPÇÃO</span><select name="channelId" required>${channels.map((channel,index)=>`<option value="${escapeHtml(channel.id)}" ${index===0?'selected':''}>${escapeHtml(channel.label)}</option>`).join('')}</select></label>
      <div class="frequency-tuner"><div class="frequency-readout"><span class="field-label">FREQUÊNCIA SINTONIZADA</span><output data-frequency-value>${Number(center).toFixed(1).replace('.',',')} MHz</output></div>
        <input class="frequency-range" type="range" name="frequency" min="${escapeHtml(config.frequencyMin)}" max="${escapeHtml(config.frequencyMax)}" step="${escapeHtml(step)}" value="${escapeHtml(center)}" data-frequency-range aria-label="Ajustar frequência"/>
        <div class="frequency-range-labels"><span>${escapeHtml(config.frequencyMin)} MHz</span><span>${escapeHtml(config.frequencyMax)} MHz</span></div></div>
      ${config.useAmplitude?`<div class="frequency-tuner"><div class="frequency-readout"><span class="field-label">AMPLITUDE</span><output data-amplitude-value>50%</output></div><input class="frequency-range" type="range" name="amplitude" min="${escapeHtml(config.amplitudeMin)}" max="${escapeHtml(config.amplitudeMax)}" step="${escapeHtml(config.amplitudeStep||1)}" value="${escapeHtml((config.amplitudeMin+config.amplitudeMax)/2)}" data-amplitude-range aria-label="Ajustar amplitude"/><div class="frequency-range-labels"><span>${escapeHtml(config.amplitudeMin)}%</span><span>${escapeHtml(config.amplitudeMax)}%</span></div></div>`:''}
      <button class="button button-primary button-wide" type="submit">Verificar sintonia <span>→</span></button>
    </form>
    <section class="frequency-signal" aria-live="polite"><div class="frequency-signal-top"><span class="field-label">INTENSIDADE DO SINAL</span><strong>${escapeHtml(feedback?.text||'Aguardando varredura…')}</strong></div>
      <div class="signal-meter" role="img" aria-label="${level} de 4 níveis de sinal">${Array.from({length:4},(_,i)=>`<i class="${i<level?'active':''}"></i>`).join('')}</div><small>${level?signalLabels[level]:'Ajuste o receptor e envie uma tentativa para medir o sinal.'}</small></section>
  </div>`;
}

function renderSocial(puzzle) {
  const questions = puzzle.config.questions || [];
  const required = puzzle.config.requiredAnswers || questions.length;
  const solvedIds = puzzle.solvedQuestionIds || [];
  const progress = puzzle.config.mode === 'sequential' ? (puzzle.questionIndex || 0) : solvedIds.length;
  const investigative = puzzle.config.mode === 'investigative';
  const available = questions.map((question, index) => ({ ...question, index })).filter((question) => !solvedIds.includes(question.id));
  if (investigative) {
    const first = available[0];
    return `<div class="social-game"><div class="social-progress"><div><span class="field-label">INFORMAÇÕES DESCOBERTAS</span><strong>${progress} / ${required}</strong></div><span class="social-mode-tag">MODO INVESTIGATIVO</span></div><div class="social-question-list">${questions.map((question, index) => `<div class="social-question ${solvedIds.includes(question.id) ? 'answered' : ''}"><span>${String(index + 1).padStart(2, '0')}</span><p>${escapeHtml(question.prompt)}</p><b>${solvedIds.includes(question.id) ? '✓' : '?'}</b></div>`).join('')}</div><form class="control-form" data-form="attempt-social"><label class="form-field"><span>Qual informação você descobriu?</span><select name="questionIndex">${available.map((question) => `<option value="${question.index}" ${question.index === first?.index ? 'selected' : ''}>${String(question.index + 1).padStart(2, '0')} · ${escapeHtml(question.prompt)}</option>`).join('')}</select></label><label class="form-field"><span>Resposta</span><input class="text-input" name="answer" maxlength="160" autocomplete="off" placeholder="Digite a informação que encontrou" required /></label><button class="button button-primary button-wide" type="submit" ${available.length ? '' : 'disabled'}>Confirmar informação <span>→</span></button></form></div>`;
  }
  const index = puzzle.questionIndex || 0;
  const current = questions[index];
  return `<div class="social-game"><div class="social-progress"><div><span class="field-label">PERGUNTAS RESPONDIDAS</span><strong>${progress} / ${required}</strong></div><span class="social-mode-tag">MODO SEQUENCIAL</span></div>${current ? `<div class="social-current-question"><span class="eyebrow">PERGUNTA ${String(index + 1).padStart(2, '0')}</span><h3>${escapeHtml(current.prompt)}</h3></div><form class="control-form" data-form="attempt-social"><input type="hidden" name="questionIndex" value="${index}" /><label class="form-field"><span>Resposta</span><input class="text-input" name="answer" maxlength="160" autocomplete="off" placeholder="Digite sua resposta" required /></label><button class="button button-primary button-wide" type="submit">Enviar resposta <span>→</span></button></form>` : '<p class="field-help">Todas as perguntas foram respondidas. O mestre deve liberar o resultado ou reiniciar o desafio.</p>'}</div>`;
}

function renderTerminal(puzzle) {
  return `<form class="terminal-shell" data-form="attempt-terminal"><div class="terminal-title"><span class="terminal-lights"><i></i><i></i><i></i></span><span>${escapeHtml(puzzle.config.terminalLabel || 'TERMINAL // ACESSO RESTRITO')}</span><span class="terminal-online">● ONLINE</span></div><div class="terminal-screen"><p class="terminal-line">DYNAMIC OS [versão 2.4.1]</p><p class="terminal-line dim">Conexão segura estabelecida.</p><p class="terminal-line warning">Autenticação necessária.</p><div class="terminal-fields"><label>USUÁRIO<input name="username" autocomplete="off" placeholder="identificação" /></label><label>SENHA<input name="password" type="password" autocomplete="off" placeholder="••••••••" /></label></div><div class="terminal-command"><label for="terminal-command">COMANDO</label><div><span>&gt;</span><input id="terminal-command" name="command" autocomplete="off" placeholder="digite um comando" /></div></div></div><div class="control-actions"><button class="button button-quiet" type="submit" data-mode="command">Executar comando</button><button class="button button-primary" type="submit" data-mode="login">Autenticar <span>→</span></button></div></form>`;
}

function renderCipher(puzzle) {
  const methods = { caesar: 'CÉSAR', substitution: 'SUBSTITUIÇÃO', wheel: 'RODA DE CIFRAS' };
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const wheelOffset = ((state.cipherOffset % 26) + 26) % 26;
  const wheelInner = alphabet.slice(wheelOffset) + alphabet.slice(0, wheelOffset);
  return `<div class="cipher-card"><div class="cipher-header"><span>TRANSMISSÃO CRIPTOGRAFADA</span><span>${escapeHtml(methods[puzzle.config.method] || 'CIFRA')}</span></div><div class="cipher-text">${escapeHtml(puzzle.config.cipherText || '—')}</div>${puzzle.config.method === 'caesar' ? `<div class="cipher-shift">DESLOCAMENTO INDICADO <b>${puzzle.config.shift > 0 ? '+' : ''}${puzzle.config.shift}</b></div>` : ''}${puzzle.config.method === 'wheel' ? `<div class="cipher-wheel"><div class="wheel-alphabet"><span>ANEL EXTERNO</span><b>${alphabet}</b></div><div class="wheel-alphabet inner"><span>ANEL INTERNO · ROTAÇÃO ${wheelOffset}</span><b>${wheelInner}</b></div><label class="wheel-control">GIRAR ANEL<select data-cipher-offset>${Array.from({length: 26}, (_, index) => `<option value="${index}" ${wheelOffset === index ? 'selected' : ''}>${index} posições</option>`).join('')}</select></label></div>` : ''}</div><form class="control-form" data-form="attempt-cipher"><label class="field-label" for="cipher-answer">MENSAGEM DECIFRADA</label><input id="cipher-answer" class="text-input" name="value" autocomplete="off" placeholder="Digite a mensagem original" /><button class="button button-primary button-wide" type="submit">Enviar decodificação <span>→</span></button></form>`;
}

function renderSequence(puzzle) {
  const symbols = puzzle.config.symbols || DEFAULT_SYMBOLS;
  return `<div class="sequence-game"><div class="field-label">SELECIONE OS SÍMBOLOS NA ORDEM</div><div class="symbol-tray">${symbols.map((symbol) => `<button class="symbol-button" type="button" data-action="sequence-add" data-symbol="${escapeHtml(symbol)}">${escapeHtml(symbol)}</button>`).join('')}</div><div class="sequence-output"><span class="field-label">SUA SEQUÊNCIA</span><div class="sequence-slots">${state.sequence.length ? state.sequence.map((symbol, index) => `<button type="button" class="sequence-chip" data-action="sequence-remove" data-index="${index}">${escapeHtml(symbol)} <small>×</small></button>`).join('') : '<span class="sequence-placeholder">Os símbolos aparecerão aqui…</span>'}</div></div><div class="control-actions"><button class="button button-quiet" type="button" data-action="sequence-clear">Limpar sequência</button><button class="button button-primary" type="button" data-action="submit-sequence">Verificar ordem <span>→</span></button></div></div>`;
}

function renderWires(puzzle) {
  const wires = puzzle.config.wires || [];
  return `<div class="wire-game"><p class="field-label">ESCOLHA O FIO QUE DEVE SER CORTADO</p><div class="wire-list">${wires.map((wire) => `<button type="button" class="wire-choice ${state.selectedWireId === wire.id ? 'selected' : ''}" data-action="select-wire" data-id="${escapeHtml(wire.id)}"><span class="wire-swatch" style="--wire-color:${escapeHtml(wire.color)}"></span><span>${escapeHtml(wire.label)}</span><span class="wire-radio"></span></button>`).join('')}</div><button class="button button-primary button-wide" type="button" data-action="submit-wire" ${state.selectedWireId ? '' : 'disabled'}>Cortar fio selecionado <span>→</span></button></div>`;
}

function renderDocument(puzzle) {
  const fragments = puzzle.config.fragments || [];
  const order = state.fragmentOrder.length ? state.fragmentOrder : fragments.map((fragment) => fragment.id);
  const lookup = new Map(fragments.map((fragment) => [fragment.id, fragment]));
  return `<div class="document-game"><div class="document-heading"><span class="field-label">REMONTE O DOCUMENTO</span><span class="document-hint">Use ↑ e ↓ para reorganizar</span></div><div class="fragment-stack">${order.map((id, index) => { const fragment = lookup.get(id); return `<div class="fragment-row" draggable="true" data-fragment-row data-fragment-id="${escapeHtml(id)}"><span class="fragment-grip">⠿</span><span class="fragment-index">${String(index + 1).padStart(2, '0')}</span><span class="fragment-text">${escapeHtml(fragment?.text || '')}</span><div class="fragment-actions"><button type="button" aria-label="Mover para cima" data-action="move-fragment" data-index="${index}" data-direction="-1" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" aria-label="Mover para baixo" data-action="move-fragment" data-index="${index}" data-direction="1" ${index === order.length - 1 ? 'disabled' : ''}>↓</button></div></div>`; }).join('')}</div><button class="button button-primary button-wide" type="button" data-action="submit-document">Confirmar documento <span>→</span></button></div>`;
}

function renderRunes(puzzle) {
  const size = Number(puzzle.config.gridSize || 3);
  const runes = puzzle.config.runes || [];
  const placements = state.runePlacements;
  const used = new Set(placements.map((item) => item.runeId));
  const occupied = new Map(placements.map((item) => [item.position, item]));
  const cells = Array.from({ length: size * size }, (_, position) => {
    const placed = occupied.get(position);
    const rune = runes.find((item) => item.id === placed?.runeId);
    return `<div class="rune-cell-wrap"><button type="button" class="rune-cell ${placed ? 'occupied' : ''} ${state.selectedRuneId && !placed ? 'target' : ''}" data-action="place-rune" data-position="${position}" data-rune-cell data-position-id="${position}" aria-label="Posição ${position + 1}" ${placed ? 'draggable="true"' : ''}>${placed ? `<span class="rune-glyph" style="transform:rotate(${placed.rotation}deg)">${escapeHtml(rune?.symbol || '?')}</span><small>${String(placed.rotation).padStart(3, '0')}°</small>` : `<span class="rune-empty">${String(position + 1).padStart(2, '0')}</span>`}</button>${placed ? `<div class="rune-cell-tools"><button type="button" data-action="rotate-rune" data-position="${position}" aria-label="Girar runa">↻</button><button type="button" data-action="remove-rune" data-position="${position}" aria-label="Retirar runa">×</button></div>` : ''}</div>`;
  }).join('');
  return `<div class="rune-game"><div class="rune-board-wrap"><div class="rune-board" style="--rune-grid-size:${size}">${cells}</div></div>
    <div class="rune-tray"><span class="field-label">RUNAS DISPONÍVEIS · ARRASTE OU SELECIONE</span><div class="rune-tray-items">${runes.map((rune) => `<button type="button" class="rune-token ${used.has(rune.id) ? 'used' : ''} ${state.selectedRuneId === rune.id ? 'selected' : ''}" data-action="select-rune" data-id="${escapeHtml(rune.id)}" data-rune-token draggable="${!used.has(rune.id)}" ${used.has(rune.id) ? 'disabled' : ''}>${escapeHtml(rune.symbol)}</button>`).join('')}</div></div>
    <p class="field-help">Arraste uma runa até uma casa vazia ou selecione-a e toque na posição. Use os controles para girar ou retirar cada peça.</p>
    <div class="rune-actions"><button class="button button-quiet" type="button" data-action="clear-runes">Limpar altar</button><button class="button button-primary" type="button" data-action="submit-runes" ${placements.length < 2 ? 'disabled' : ''}>Ativar o altar <span>→</span></button></div></div>`;
}

function renderSwitches(puzzle) {
  const count = puzzle.config.switchCount || 5;
  if (state.switches.length !== count) state.switches = Array.from({ length: count }, () => false);
  return `<div class="switch-game"><div class="field-label">PAINEL DE CONTROLE · ${count} CANAIS</div><div class="switch-row">${state.switches.map((enabled, index) => `<button type="button" class="switch-cell ${enabled ? 'on' : ''}" data-action="toggle-switch" data-index="${index}"><span class="switch-track"><i></i></span><b>${String(index + 1).padStart(2, '0')}</b><small>${enabled ? 'LIGADO' : 'DESLIGADO'}</small></button>`).join('')}</div><div class="switch-readout"><span>ESTADO DO CIRCUITO</span><strong>${state.switches.map((bit) => bit ? '1' : '0').join('')}</strong></div><button class="button button-primary button-wide" type="button" data-action="submit-switches">Aplicar combinação <span>→</span></button></div>`;
}

function historyFeedbackText(feedback) {
  if (!feedback) return '';
  if (feedback.text) return feedback.text;
  if (feedback.mode === 'individual') {
    const labels = { high: 'alvo acima · aumente', low: 'alvo abaixo · diminua', exact: 'exato' };
    return (feedback.marks || []).map((mark, index) => `D${index + 1}: ${labels[mark] || mark}`).join('  /  ');
  }
  if (feedback.mode === 'grouped' && feedback.counts) {
    const { high = 0, low = 0, exact = 0 } = feedback.counts;
    return `${high} valor(es) secreto(s) acima · ${low} abaixo · ${exact} exato(s)`;
  }
  return '';
}

function renderHistory(puzzle) {
  const sourceHistory = puzzle.participationMode === 'individual' && state.role === 'GM'
    ? Object.values(puzzle.playerProgress || {}).flatMap((progress) => progress.history || [])
    : (puzzle.history || []);
  const history = [...sourceHistory].sort((a, b) => (b.at || 0) - (a.at || 0));
  const historyLabel = puzzle.participationMode === 'individual' ? 'Histórico de tentativas da sala' : 'Histórico de tentativas';
  return `<section class="history-section"><div class="section-heading"><div><span class="eyebrow">REGISTRO DA SALA</span><h3>${historyLabel}</h3></div><span class="history-total">${history.length.toString().padStart(2, '0')} EVENTOS</span></div>${history.length ? `<div class="history-list">${history.map((entry) => `<div class="history-item"><span class="history-result ${entry.result === 'success' ? 'success' : entry.result === 'progress' ? 'progress' : 'failure'}">${entry.result === 'success' ? '✓' : entry.result === 'progress' ? '↗' : '×'}</span><span class="history-player">${escapeHtml(entry.actor)}</span><span class="history-entry-copy"><span class="history-submitted">${escapeHtml(entry.submitted)}</span>${historyFeedbackText(entry.feedback) ? `<small class="history-feedback">${escapeHtml(historyFeedbackText(entry.feedback))}</small>` : ''}</span><span class="history-time">${new Date(entry.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span></div>`).join('')}</div>` : '<p class="history-empty">Nenhuma tentativa registrada. O registro aparecerá aqui para todos os jogadores.</p>'}</section>`;
}

function renderGuide() {
  const entries = [
    ['Cadeado · teclado ou discos', 'Configure uma senha de letras e números. Escolha teclado para digitação ou discos para ajustar cada caractere. Use quando a fechadura tem uma combinação conhecida por pistas, códigos ou documentos.', 'Exemplo: quatro caracteres que aparecem em um diário, data ou etiqueta. O mestre pode limitar tentativas e associar erros a um alarme ou avanço do relógio.'],
    ['Destrancamento por dados', 'Escolha a quantidade de dados (1 a 20), o tipo (d4, d6, d8, d10 ou d12), a combinação secreta na ordem e o formato de feedback. Cada posição é comparada ao valor secreto daquela mesma posição.', 'Individual: cada dado recebe “acima, diminua”, “abaixo, aumente” ou “exato”. Agrupado: a sala recebe apenas a contagem de resultados acima, abaixo e exatos, sem revelar quais posições acertaram. Exemplo: 4d8 com senha 6-2-7-3. Use o limite de tentativas para representar a resistência da fechadura.'],
    ['Sintonia de frequência', 'Defina a faixa, o intervalo de ajuste, os canais disponíveis e a frequência/canal secretos. O jogador escolhe um canal e ajusta o receptor até encontrar o sinal.', 'A interferência altera a precisão do indicador, não a solução correta. Na configuração avançada, também é possível exigir amplitude como segundo controle.'],
    ['Hack Social', 'Insira uma linha por pergunta no formato: pergunta | resposta | variações. Separe respostas alternativas por ponto e vírgula. Escolha Sequencial para exigir a ordem definida ou Investigativo para permitir que o grupo responda às perguntas em qualquer ordem. Defina quantas informações corretas bastam para liberar o acesso.', 'Exemplo: “Qual o nome do cachorro? | Thor | Thorinho;Trovão”. No modo investigativo, as perguntas ficam visíveis e o grupo escolhe qual informação já descobriu. No sequencial, a próxima pergunta só aparece depois de acertar a atual. O mestre deve validar manualmente o teste inicial de Intuição antes de liberar o minigame, caso queira seguir essa etapa do playtest.'],
    ['Terminal', 'Configure usuário, senha e/ou comandos permitidos. O jogador pode autenticar com as credenciais ou executar um dos comandos cadastrados.', 'Exemplo: “admin” + senha ou comando “open vault”. Use falhas para disparar alarmes, bloqueios ou relógios de segurança.'],
    ['Cifra', 'Escolha César, substituição ou roda de cifras. Insira o texto cifrado e a solução que o grupo deve enviar. Nas cifras de César, configure o deslocamento.', 'Exemplo: uma carta interceptada com a mensagem “A CHAVE ESTÁ NO ARMÁRIO”. Dê pistas graduais sobre método e deslocamento.'],
    ['Sequência de símbolos', 'Defina os símbolos disponíveis e a sequência correta. Os jogadores montam a ordem selecionando os símbolos.', 'Exemplo: um ritual exige Lua → Chama → Pedra → Estrela. A ordem pode vir de inscrições, estações do ano ou anotações encontradas.'],
    ['Fios coloridos', 'Liste as cores ou identificações dos fios e escolha qual é o correto. Os jogadores selecionam um fio para cortar.', 'Exemplo: um painel de explosivos com quatro fios. Descreva pistas visuais ou documentos que ajudem a deduzir a escolha.'],
    ['Documento rasgado', 'Escreva cada fragmento em uma linha, já na ordem correta. A extensão embaralha as partes para os jogadores reorganizarem.', 'Exemplo: um bilhete dividido em quatro pedaços que revela a ordem para abrir uma passagem. Não use para informação que o grupo precisa receber obrigatoriamente.'],
    ['Painel de interruptores', 'Defina uma sequência de 0 e 1: 0 significa desligado e 1 ligado. Use de 2 a 10 interruptores.', 'Exemplo: alinhar cinco alavancas para ativar uma ponte. As marcas no painel, símbolos ou pistas no cenário podem indicar o padrão.'],
  ];
  return `<section class="guide-layout"><div class="master-intro"><div><span class="eyebrow">REFERÊNCIA DE MESA</span><h1>Guia do mestre</h1><p>Como preparar, conduzir e encaixar cada minigame na sua campanha.</p></div><button class="button button-quiet" data-action="tab-master">← Voltar ao estúdio</button></div><section class="guide-intro-card"><h2>O papel do minigame na cena</h2><p>Apresente o desafio como parte do cenário, deixe claro o que os personagens podem observar e permita que os jogadores usem as pistas que encontraram. O minigame deve materializar a ação dos personagens, não substituir a investigação nem decidir sozinho o que a história exige.</p><p>Configure antes da sessão o que está em jogo, quantas tentativas são aceitáveis e o que acontece se o grupo falhar. Recompensa pode ser uma pista, documento, item, acesso a uma área ou mudança no cenário. Cada tipo também tem um modelo demonstrativo, um modo simples para começar e opções avançadas para personalizar a dificuldade.</p></section><div class="guide-grid">${entries.map(([title, setup, example], index) => `<article class="guide-entry"><div class="guide-entry-top"><span>${String(index + 1).padStart(2, '0')}</span><h3>${title}</h3></div><h4>Como configurar</h4><p>${setup}</p><h4>Como usar na campanha</h4><p>${example}</p></article>`).join('')}</div><section class="guide-intro-card"><h2>Tentativas, pressão e consequências</h2><p><b>Limite 0:</b> tentativas ilimitadas. Um limite maior permite experimentação; um limite baixo torna o erro perigoso. Em caso de falha, escolha entre não aplicar consequência, avançar um relógio, disparar um alarme ou bloquear o desafio. O relógio e o alarme são contadores internos da extensão: o mestre ainda decide como isso aparece no mundo do jogo.</p><p><b>Recompensas:</b> o conteúdo configurado só aparece para a sala após a validação do mestre. Use textos curtos, handouts externos ou links HTTPS para entregar a próxima pista.</p><p><b>Jogo em grupo:</b> todas as pessoas da sala podem enviar tentativas. O histórico registra jogador, palpite, feedback e horário. Em desafios de dedução, incentive a mesa a discutir hipóteses antes de gastar tentativas.</p></section><section class="guide-intro-card"><h2>Modelos, modos de configuração e dicas</h2><p><b>Modelo demonstrativo:</b> abra a aba Modelos, escolha um tipo e use um cenário pronto como ponto de partida. O modelo é editável e não é publicado até você salvar o enigma.</p><p><b>Modo simples:</b> mostra somente os campos essenciais para colocar o desafio em jogo. <b>Modo avançado:</b> libera limites, consequências, dicas graduais e encadeamento de etapas. Os valores avançados já configurados são preservados quando você alterna para o modo simples.</p><p><b>Dicas graduais:</b> escreva até cinco dicas, da mais sutil à mais direta. No Estúdio do mestre, libere uma por vez. Somente as dicas já liberadas são compartilhadas com os jogadores.</p><p><b>Sequências:</b> use o mesmo nome de sequência em vários enigmas e numere as etapas. A primeira etapa fica disponível; as seguintes são liberadas quando a anterior for concluída. Reordenar etapas altera a progressão.</p></section><section class="guide-source-note"><span class="eyebrow">REFERÊNCIA DE ORDEM PARANORMAL II</span><p>O Hack Social e o destrancamento por dados foram inspirados nas regras de desafios de acesso do primeiro playtest (seção “Desafios de Acesso”, páginas 24–25). O playtest descreve teste de Intuição antes das perguntas sociais e uma senha de fechadura formada por resultados ordenados; a extensão oferece opções configuráveis para adaptar esses procedimentos à mesa. O segundo playtest apresenta graus de relação e benefícios de apoio como referência narrativa adicional, mas não define a mecânica de Hack Social.</p><p>Esta extensão é independente e não substitui os documentos oficiais. Ela não lê fichas, não realiza testes de perícia automaticamente e não aplica regras específicas de personagem: o mestre faz esses julgamentos durante a sessão.</p></section></section>`;
}

function renderMaster() {
  if (state.editorDraft) return renderEditor();
  const puzzles = state.privatePuzzles;
  const solved = puzzles.filter((puzzle) => puzzle.public.solved).length;
  const alarms = puzzles.reduce((sum, puzzle) => sum + puzzle.public.alarmCount, 0);
  const clocks = puzzles.reduce((sum, puzzle) => sum + puzzle.public.clockCount, 0);
  return `<section class="master-layout">
    <div class="master-intro"><div><span class="eyebrow">CONTROLE DE CAMPANHA</span><h1>Estúdio do mestre</h1><p>Crie, configure e acompanhe os desafios da sua sala.</p></div><div class="master-intro-actions"><button class="button button-quiet" data-action="tab-library">Biblioteca de modelos</button><button class="button button-primary" data-action="new-puzzle" ${puzzles.length >= MAX_PUZZLES ? 'disabled' : ''}>＋ Novo enigma</button></div></div>
    <div class="stats-grid"><div class="stat-card"><span>ENIGMAS CRIADOS</span><strong>${String(puzzles.length).padStart(2, '0')}</strong><small>Limite local: ${MAX_PUZZLES}</small></div><div class="stat-card"><span>RESOLVIDOS</span><strong class="stat-green">${String(solved).padStart(2, '0')}</strong><small>${puzzles.length ? Math.round((solved / puzzles.length) * 100) : 0}% da sala</small></div><div class="stat-card"><span>RELÓGIOS AVANÇADOS</span><strong class="stat-amber">${String(clocks).padStart(2, '0')}</strong><small>Consequências registradas</small></div><div class="stat-card"><span>ALARMES DISPARADOS</span><strong class="stat-red">${String(alarms).padStart(2, '0')}</strong><small>Consequências registradas</small></div></div>
    <div class="master-section-heading"><div><span class="eyebrow">BIBLIOTECA DE DESAFIOS</span><h2>Seus enigmas</h2></div><span class="muted-small">As soluções não são compartilhadas com os jogadores.</span></div>
    ${puzzles.length ? `<div class="master-puzzle-grid">${puzzles.map((puzzle, index) => `<article class="master-puzzle-card"><div class="master-card-top"><span class="master-card-number">${String(index + 1).padStart(2, '0')}</span>${statusChip(puzzle.public)}</div><h3>${escapeHtml(puzzle.title)}</h3><p>${escapeHtml(TYPE_LABELS[puzzle.type] || puzzle.type)}</p><div class="master-card-meta"><span>⌁ ${puzzle.public.attemptsUsed} ${puzzle.type === 'social' ? 'erro(s)' : 'tentativa(s)'}</span><span>${puzzle.public.participationMode === 'individual' ? Object.values(puzzle.public.playerProgress || {}).reduce((sum, item) => sum + (item.history?.length || 0), 0) : puzzle.public.history.length} eventos</span></div>${puzzle.public.participationMode === 'individual' ? `<div class="master-card-chain">Progresso individual: ${Object.values(puzzle.public.playerProgress || {}).filter((item) => item.solved).length}/${state.partyPlayers.filter((player) => player.role === 'PLAYER').length || Object.keys(puzzle.public.playerProgress || {}).length} concluído(s)</div>` : ''}${puzzle.public.sequenceName ? `<div class="master-card-chain">▤ ${escapeHtml(puzzle.public.sequenceName)} · etapa ${puzzle.public.sequenceOrder}</div>` : ''}${(puzzle.hints || []).length ? `<div class="master-card-hints"><span>Dicas: ${puzzle.public.revealedHints?.length || 0}/${puzzle.hints.length}</span><button class="button button-quiet button-mini" data-action="release-hint" data-id="${escapeHtml(puzzle.id)}" ${(puzzle.public.revealedHints?.length || 0) >= puzzle.hints.length ? 'disabled' : ''}>Liberar próxima dica</button></div>` : ''}<div class="master-card-actions"><button class="button button-quiet" data-action="edit-puzzle" data-id="${escapeHtml(puzzle.id)}">Editar</button><button class="icon-button" data-action="reset-puzzle" data-id="${escapeHtml(puzzle.id)}" title="Zerar progresso">↺</button><button class="icon-button danger" data-action="delete-puzzle" data-id="${escapeHtml(puzzle.id)}" title="Excluir enigma">×</button></div></article>`).join('')}</div>` : `<div class="empty-master"><div class="empty-orbit small">✧</div><h3>Nenhum enigma por enquanto</h3><p>Crie seu primeiro desafio ou carregue exemplos para explorar o sistema.</p><div class="empty-actions"><button class="button button-primary" data-action="new-puzzle">Criar primeiro enigma</button><button class="button button-quiet" data-action="seed-demo">Carregar exemplos</button></div></div>`}
    ${puzzles.length ? `<div class="master-footer-actions"><button class="button button-quiet" data-action="seed-demo" ${puzzles.length + 11 > MAX_PUZZLES ? 'disabled' : ''}>＋ Adicionar conjunto de exemplos</button><button class="button button-quiet" data-action="export-backup">Exportar backup privado ↓</button><label class="button button-quiet file-button">Importar backup ↑<input type="file" accept="application/json" data-action="import-backup" hidden /></label></div>` : ''}
    <div class="security-note"><span>◈</span><div><strong>Respostas protegidas por separação de dados</strong><p>As soluções e a configuração privada ficam no armazenamento local do navegador do mestre. A sala recebe somente as informações públicas dos desafios e os resultados das tentativas.</p></div></div>
  </section>`;
}

function renderEditor() {
  const draft = state.editorDraft || {};
  const type = draft.type || 'lock';
  const advanced = draft.editorMode === 'advanced';
  const template = type === 'lock' && draft.lockMode === 'deduction'
    ? PUZZLE_TEMPLATES.find((item) => item.id === 'lock-dice')
    : type === 'lock' && draft.lockMode === 'wheel'
      ? PUZZLE_TEMPLATES.find((item) => item.id === 'lock-wheel')
      : (PUZZLE_TEMPLATES.find((item) => item.type === type && !['lock-dice', 'lock-wheel'].includes(item.id)) || PUZZLE_TEMPLATES.find((item) => item.type === type));
  const typeOptions = PUZZLE_TYPES.map((item) => `<option value="${item.id}" ${type === item.id ? 'selected' : ''}>${item.label}</option>`).join('');
  const participationMode = draft.participationMode || 'shared';
  const allowedIds = Array.isArray(draft.allowedPlayerIds) ? draft.allowedPlayerIds : [];
  const onlinePlayerIds = state.partyPlayers.filter((player) => player.role !== 'GM').map((player) => player.id);
  const participantOptions = state.partyPlayers.filter((player) => player.role !== 'GM').map((player) => `<label class="multiplayer-player-option"><input type="checkbox" name="allowedPlayerIds" value="${escapeHtml(player.id)}" ${allowedIds.includes(player.id) ? 'checked' : ''}/><span>${escapeHtml(player.name)}</span></label>`).join('') + allowedIds.filter((id) => !onlinePlayerIds.includes(id)).map((id) => `<input type="hidden" name="allowedPlayerIds" value="${escapeHtml(id)}"/>`).join('');
  const hiddenAdvanced = advanced ? '' : `
    <input type="hidden" name="attemptLimit" value="${escapeHtml(draft.attemptLimit ?? 0)}" />
    <input type="hidden" name="errorEffect" value="${escapeHtml(draft.errorEffect || 'none')}" />
    <input type="hidden" name="sequenceName" value="${escapeHtml(draft.sequenceName || '')}" />
    <input type="hidden" name="sequenceOrder" value="${escapeHtml(draft.sequenceOrder ?? 1)}" />
    <textarea name="hints" hidden>${escapeHtml(draft.hints || '')}</textarea>`;
  return `<section class="editor-layout"><div class="editor-top"><button class="back-link" data-action="cancel-editor">← Voltar ao estúdio</button><span class="eyebrow">${state.editorId ? 'EDITAR DESAFIO' : 'NOVO DESAFIO'}</span></div><div class="editor-title"><div><h1>${state.editorId ? 'Editar enigma' : 'Criar enigma'}</h1><p>Comece pelo essencial e aprofunde as regras quando quiser.</p></div><span class="editor-step">CONFIGURAÇÃO / 01</span></div><form class="editor-form" data-form="puzzle-editor">
    <section class="editor-mode-card"><div><span class="eyebrow">NÍVEL DE CONFIGURAÇÃO</span><h3>${advanced ? 'Opções avançadas' : 'Configuração simples'}</h3><p>${advanced ? 'Personalize regras, dicas e encadeamento entre desafios.' : 'Configure o necessário para colocar o enigma em jogo. Você pode aprofundar depois.'}</p></div><div class="editor-mode-actions"><button type="button" class="mode-choice ${!advanced ? 'active' : ''}" data-action="editor-mode-simple">Simples</button><button type="button" class="mode-choice ${advanced ? 'active' : ''}" data-action="editor-mode-advanced">Avançado</button></div></section>
    <section class="editor-template-strip"><div class="editor-template-preview"><span class="eyebrow">DEMONSTRAÇÃO · ${escapeHtml(template?.label || 'ENIGMA')}</span><strong>${escapeHtml(template?.preview || 'Modelo de exemplo')}</strong><small>${escapeHtml(template?.description || '')}</small></div><button class="button button-quiet" type="button" data-action="load-template">Carregar exemplo deste tipo</button><button class="button button-quiet" type="button" data-action="tab-library">Ver todos os modelos</button></section>
    <div class="editor-columns"><div class="editor-main-column">
      <section class="editor-card multiplayer-editor-card"><div class="editor-card-heading"><span class="editor-icon">◎</span><div><h3>Participação dos jogadores</h3><p>Escolha como a mesa interage com este enigma.</p></div></div>
        <label class="form-field"><span>Modo de participação</span><select name="participationMode" data-editor-participation-mode>${PARTICIPATION_MODES.map((mode) => `<option value="${mode.id}" ${participationMode === mode.id ? 'selected' : ''}>${mode.label}</option>`).join('')}</select></label>
        <p class="field-help">${PARTICIPATION_MODES.find((mode) => mode.id === participationMode)?.description || ''}</p>
        ${participationMode === 'controlled' ? `<div class="multiplayer-player-list"><span class="field-label">QUEM PODE INTERAGIR</span>${participantOptions || '<small>Nenhum jogador conectado. Os jogadores aparecerão aqui quando entrarem na sala.</small>'}</div>` : ''}
      </section>
      <section class="editor-card"><div class="editor-card-heading"><span class="editor-icon">◇</span><div><h3>Identidade do desafio</h3><p>O conteúdo apresentado aos jogadores.</p></div></div>
        <label class="form-field"><span>Nome do enigma</span><input name="title" required maxlength="80" value="${escapeHtml(draft.title || '')}" placeholder="Ex.: Cofre da biblioteca" /></label>
        <label class="form-field"><span>Tipo de interação</span><select name="type" data-editor-type>${typeOptions}</select></label>
        <label class="form-field"><span>Descrição curta</span><textarea name="description" maxlength="300" rows="2" placeholder="Contextualize o desafio para o grupo…">${escapeHtml(draft.description || '')}</textarea></label>
        <label class="form-field"><span>Instruções / pistas visíveis</span><textarea name="instructions" maxlength="400" rows="3" placeholder="O que os jogadores sabem antes de tentar?">${escapeHtml(draft.instructions || '')}</textarea></label>
      </section>
      <section class="editor-card"><div class="editor-card-heading"><span class="editor-icon">⌘</span><div><h3>Configuração da interação</h3><p>Defina a solução correta. Este campo não será enviado aos jogadores.</p></div></div>${renderTypeFields(type, draft, advanced)}</section>
      ${advanced ? `<section class="editor-card"><div class="editor-card-heading"><span class="editor-icon">☷</span><div><h3>Dicas graduais</h3><p>Prepare pistas que o mestre pode liberar uma de cada vez.</p></div></div><label class="form-field"><span>Até cinco dicas (uma por linha, da mais sutil à mais direta)</span><textarea name="hints" rows="5" maxlength="1500" placeholder="Dica 1: observe o símbolo ao lado.\nDica 2: o símbolo representa o mês de nascimento.\nDica 3: procure a data no documento.">${escapeHtml(draft.hints || '')}</textarea><small>O texto das dicas ainda não liberadas fica privado. Só as dicas publicadas aparecem na sala dos jogadores.</small></label></section>` : ''}
      <section class="editor-card"><div class="editor-card-heading"><span class="editor-icon">✧</span><div><h3>Recompensa ao resolver</h3><p>O conteúdo só aparece na sala depois da resposta correta.</p></div></div>
        <label class="form-field"><span>Título da recompensa</span><input name="rewardTitle" maxlength="60" value="${escapeHtml(draft.rewardTitle || '')}" placeholder="Ex.: Documento recuperado" /></label>
        <label class="form-field"><span>Conteúdo revelado</span><textarea name="rewardContent" maxlength="600" rows="3" placeholder="Texto, pista, instrução ou descrição do item…">${escapeHtml(draft.rewardContent || '')}</textarea></label>
        <label class="form-field"><span>Link de documento ou item (opcional)</span><input name="rewardUrl" type="url" value="${escapeHtml(draft.rewardUrl || '')}" maxlength="500" placeholder="https://…" /></label>
      </section>
    </div><aside class="editor-side-column">
      ${advanced ? `<section class="editor-card"><div class="editor-card-heading"><span class="editor-icon">⚑</span><div><h3>Regras de tentativa</h3><p>Controle a pressão e as consequências.</p></div></div>
        <label class="form-field"><span>${type === 'social' ? 'Limite de respostas incorretas' : 'Limite de tentativas'}</span><input name="attemptLimit" type="number" min="0" max="99" value="${escapeHtml(draft.attemptLimit ?? 3)}" /><small>${type === 'social' ? 'Respostas corretas avançam o progresso sem consumir o limite. Use 0 para erros ilimitados.' : 'Use 0 para tentativas ilimitadas.'}</small></label>
        <label class="form-field"><span>Ao errar, acontece…</span><select name="errorEffect">${ERROR_EFFECTS.map((effect) => `<option value="${effect.id}" ${(draft.errorEffect || 'none') === effect.id ? 'selected' : ''}>${effect.label}</option>`).join('')}</select></label>
        <div class="rule-explainer"><b>Como as consequências funcionam</b><p>Relógio e alarme são contadores da extensão. O mestre decide como eles afetam a cena. Bloqueio encerra as tentativas até o reinício.</p></div>
      </section>
      <section class="editor-card"><div class="editor-card-heading"><span class="editor-icon">⇢</span><div><h3>Sequência de enigmas</h3><p>Encadeie desafios para formar uma sala de Escape Room.</p></div></div>
        <label class="form-field"><span>Nome da sequência (opcional)</span><input name="sequenceName" maxlength="60" value="${escapeHtml(draft.sequenceName || '')}" placeholder="Ex.: Cofre do laboratório" /></label>
        <label class="form-field"><span>Número da etapa</span><input name="sequenceOrder" type="number" min="1" max="99" value="${escapeHtml(draft.sequenceOrder ?? 1)}" /></label>
        <small class="field-help">Use o mesmo nome em vários enigmas. A etapa 1 abre primeiro; cada etapa seguinte é liberada ao resolver a anterior.</small>
      </section>` : `<div class="simple-default-card"><span class="eyebrow">PADRÕES SIMPLES</span><strong>Sem pressão extra</strong><p>Por padrão, as tentativas são ilimitadas e erros não disparam consequências. Ative o modo avançado para alterar isso, encadear desafios ou criar dicas graduais.</p></div>`}
      ${hiddenAdvanced}
      <div class="editor-save-card"><span class="save-shield">◈</span><strong>Pronto para a sala?</strong><p>A solução fica privada no dispositivo do mestre. Apenas o desafio e seu progresso são publicados.</p><button class="button button-primary button-wide" type="submit">${state.editorId ? 'Salvar alterações' : 'Criar enigma'} <span>→</span></button><button class="button button-quiet button-wide" type="button" data-action="cancel-editor">Cancelar</button></div>
    </aside></div>
  </form></section>`;
}

function renderTypeFields(type, draft, advanced = false) {
  const input = (name, label, value, placeholder = '', typeName = 'text') => `<label class="form-field"><span>${label}</span><input name="${name}" type="${typeName}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}" /></label>`;
  const textarea = (name, label, value, placeholder = '') => `<label class="form-field"><span>${label}</span><textarea name="${name}" rows="3" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value ?? '')}</textarea></label>`;
  if (type === 'lock') {
    const mode = draft.lockMode || 'keypad';
    const modeField = `<label class="form-field"><span>Tipo de mecanismo</span><select name="lockMode" data-editor-lock-mode><option value="keypad" ${mode === 'keypad' ? 'selected' : ''}>Teclado</option><option value="wheel" ${mode === 'wheel' ? 'selected' : ''}>Discos giratórios</option><option value="deduction" ${mode === 'deduction' ? 'selected' : ''}>Dedução por dados</option></select></label>`;
    if (mode === 'deduction') {
      const sides = Number(draft.diceSides || 6);
      return `${modeField}<div class="form-two-columns"><label class="form-field"><span>Quantidade de dados</span><input name="diceCount" type="number" min="1" max="20" value="${escapeHtml(draft.diceCount ?? 4)}" /></label><label class="form-field"><span>Tipo de dado</span><select name="diceSides">${[4, 6, 8, 10, 12].map((face) => `<option value="${face}" ${sides === face ? 'selected' : ''}>D${face}</option>`).join('')}</select></label></div>${input('diceAnswer', 'Combinação secreta (na ordem)', draft.diceAnswer || draft.answer, 'Ex.: 4, 3, 2, 1')}${advanced ? `<label class="form-field"><span>Formato de feedback</span><select name="feedbackMode"><option value="individual" ${(draft.feedbackMode || 'individual') === 'individual' ? 'selected' : ''}>Individual · cada posição</option><option value="grouped" ${draft.feedbackMode === 'grouped' ? 'selected' : ''}>Agrupado · totais sem posições</option></select></label>` : `<input type="hidden" name="feedbackMode" value="${escapeHtml(draft.feedbackMode || 'individual')}" />`}<p class="field-help">A quantidade pode variar de 1 a 20 dados. Escolha D4, D6, D8, D10 ou D12. Separe os valores secretos por vírgula, na ordem dos dados.</p>`;
    }
    return `<div class="form-two-columns">${input('answer', 'Resposta correta', draft.answer, 'Ex.: 0482')}${modeField}</div><p class="field-help">O teclado aceita letras e números. Os discos exibem a quantidade de caracteres da resposta.</p>`;
  }

  if (type === 'frequency') {
    const useAmplitude = draft.frequencyUseAmplitude === 'yes' || draft.frequencyUseAmplitude === true;
    const channels = String(draft.frequencyChannels || 'AM, FM, Emergência').split(/[\\n,;]+/).map((v)=>v.trim()).filter(Boolean);
    const extra = advanced ? `
      ${input('frequencyTolerance','Tolerância da frequência (MHz)',draft.frequencyTolerance??0.5,'0.5','number')}
      <label class="form-field"><span>Interferência</span><select name="frequencyInterference">
        <option value="none" ${draft.frequencyInterference==='none'?'selected':''}>Nenhuma</option>
        <option value="low" ${(draft.frequencyInterference||'low')==='low'?'selected':''}>Baixa</option>
        <option value="high" ${draft.frequencyInterference==='high'?'selected':''}>Alta</option>
      </select></label>
      ${useAmplitude?`<div class="form-divider-label">AJUSTES DE AMPLITUDE</div>
        <div class="form-two-columns">${input('frequencyAmplitudeMin','Amplitude mínima (%)',draft.frequencyAmplitudeMin??0,'0','number')}${input('frequencyAmplitudeMax','Amplitude máxima (%)',draft.frequencyAmplitudeMax??100,'100','number')}</div>
        <div class="form-two-columns">${input('frequencyAmplitudeStep','Intervalo (%)',draft.frequencyAmplitudeStep??1,'1','number')}${input('frequencyAmplitudeTarget','Amplitude secreta (%)',draft.frequencyAmplitudeTarget??65,'65','number')}</div>
        ${input('frequencyAmplitudeTolerance','Tolerância da amplitude (%)',draft.frequencyAmplitudeTolerance??5,'5','number')}`:''}`: `
      <input type="hidden" name="frequencyTolerance" value="${escapeHtml(draft.frequencyTolerance??0.5)}"/>
      <input type="hidden" name="frequencyInterference" value="${escapeHtml(draft.frequencyInterference||'low')}"/>
      <input type="hidden" name="frequencyAmplitudeMin" value="${escapeHtml(draft.frequencyAmplitudeMin??0)}"/>
      <input type="hidden" name="frequencyAmplitudeMax" value="${escapeHtml(draft.frequencyAmplitudeMax??100)}"/>
      <input type="hidden" name="frequencyAmplitudeStep" value="${escapeHtml(draft.frequencyAmplitudeStep??1)}"/>
      <input type="hidden" name="frequencyAmplitudeTarget" value="${escapeHtml(draft.frequencyAmplitudeTarget??65)}"/>
      <input type="hidden" name="frequencyAmplitudeTolerance" value="${escapeHtml(draft.frequencyAmplitudeTolerance??5)}"/>`;
    return `<div class="form-two-columns">${input('frequencyMin','Frequência mínima (MHz)',draft.frequencyMin??88,'88','number')}${input('frequencyMax','Frequência máxima (MHz)',draft.frequencyMax??108,'108','number')}</div>
      <div class="form-two-columns">${input('frequencyStep','Intervalo de sintonia (MHz)',draft.frequencyStep??0.1,'0.1','number')}${input('frequencyTarget','Frequência secreta (MHz)',draft.frequencyTarget??101.7,'101.7','number')}</div>
      ${textarea('frequencyChannels','Canais disponíveis',draft.frequencyChannels||'AM, FM, Emergência','AM, FM, Emergência')}
      ${input('frequencyTargetChannel','Canal correto (secreto)',draft.frequencyTargetChannel||channels[1]||channels[0]||'FM','FM')}
      <label class="form-field"><span>Usar controle adicional de amplitude?</span><select name="frequencyUseAmplitude" data-editor-frequency-amplitude><option value="no" ${!useAmplitude?'selected':''}>Não, somente frequência e canal</option><option value="yes" ${useAmplitude?'selected':''}>Sim, exigir amplitude</option></select></label>
      ${extra}<p class="field-help">A frequência e o canal secretos ficam privados no dispositivo do mestre. Os jogadores recebem somente a faixa e os canais disponíveis.</p>`;
  }

  if (type === 'social') {
    const questionCount = String(draft.socialQuestions || '').split(/\r?\n/).filter((line) => line.trim()).length;
    return `<label class="form-field"><span>Modo de investigação</span><select name="socialMode" data-editor-social-mode><option value="sequential" ${(draft.socialMode || 'sequential') === 'sequential' ? 'selected' : ''}>Sequencial · uma pergunta após a outra</option><option value="investigative" ${draft.socialMode === 'investigative' ? 'selected' : ''}>Investigativo · escolher perguntas em qualquer ordem</option></select></label><label class="form-field"><span>Perguntas e respostas (uma por linha)</span><textarea name="socialQuestions" rows="6" placeholder="Qual o nome do cachorro? | Thor&#10;Em que cidade nasceu? | Santos">${escapeHtml(draft.socialQuestions || '')}</textarea><small>${advanced ? 'Formato: pergunta | resposta correta | variações aceitas. As variações são opcionais e separadas por ponto e vírgula.' : 'Formato simples: pergunta | resposta. A quantidade de respostas definida no modelo é mantida; para alterá-la, use o modo avançado.'}</small></label>${advanced ? `<label class="form-field"><span>Quantas respostas corretas liberam o acesso?</span><input name="requiredAnswers" type="number" min="1" max="20" value="${escapeHtml(draft.requiredAnswers ?? questionCount ?? 1)}" /></label>` : `<input type="hidden" name="requiredAnswers" value="${escapeHtml(Math.min(Number(draft.requiredAnswers) || questionCount || 1, questionCount || 1))}" />`}<p class="field-help">As perguntas são públicas; as respostas e variações permanecem privadas.</p>`;
  }
  if (type === 'terminal') return `${input('username', 'Usuário correto', draft.username, 'Ex.: admin')}${input('password', 'Senha correta', draft.password, 'Senha de acesso', 'text')}${advanced ? `${input('terminalLabel', 'Identificação do terminal', draft.terminalLabel || 'TERMINAL // ACESSO RESTRITO')}${textarea('acceptedCommands', 'Comandos aceitos (um por linha)', draft.acceptedCommands, 'help\\nopen vault\\noverride')}` : `<input type="hidden" name="terminalLabel" value="${escapeHtml(draft.terminalLabel || 'TERMINAL // ACESSO RESTRITO')}" /><textarea name="acceptedCommands" hidden>${escapeHtml(draft.acceptedCommands || '')}</textarea>`}<p class="field-help">O terminal aceita o login correto ou qualquer comando previamente cadastrado.</p>`;
  if (type === 'cipher') return `${textarea('cipherText', 'Texto cifrado', draft.cipherText, 'Ex.: FKR UD QXEV')}${input('answer', 'Texto original / resposta', draft.answer, 'A mensagem decifrada')}${advanced ? `<div class="form-two-columns"><label class="form-field"><span>Tipo de cifra</span><select name="cipherMethod"><option value="caesar" ${(draft.cipherMethod || 'caesar') === 'caesar' ? 'selected' : ''}>César</option><option value="substitution" ${draft.cipherMethod === 'substitution' ? 'selected' : ''}>Substituição</option><option value="wheel" ${draft.cipherMethod === 'wheel' ? 'selected' : ''}>Roda de cifras</option></select></label>${input('shift', 'Deslocamento (César)', draft.shift ?? 3, '3', 'number')}</div>` : `<input type="hidden" name="cipherMethod" value="${escapeHtml(draft.cipherMethod || 'caesar')}" /><input type="hidden" name="shift" value="${escapeHtml(draft.shift ?? 3)}" />`}<p class="field-help">A validação compara a mensagem enviada com a resposta configurada.</p>`;
  if (type === 'sequence') return `${input('availableSymbols', 'Símbolos disponíveis', draft.availableSymbols || DEFAULT_SYMBOLS.join(' '), '◆ ● ▲ ■ ✦')}${input('answerSequence', 'Sequência correta (separada por espaço)', draft.answerSequence, '◆ ▲ ● ■')}<p class="field-help">Os símbolos disponíveis aparecem como botões. A ordem correta permanece privada.</p>`;
  if (type === 'wires') {
    const colors = draft.wireColors || 'Vermelho, Azul, Amarelo, Verde';
    const labels = colors.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
    const correct = draft.correctWire || 'wire-0';
    return `${textarea('wireColors', 'Fios disponíveis (separados por vírgula)', colors, 'Vermelho, Azul, Amarelo, Verde')}<label class="form-field"><span>Fio correto</span><select name="correctWire">${labels.map((label, index) => `<option value="wire-${index}" ${correct === `wire-${index}` ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label><p class="field-help">O jogador vê todos os fios e escolhe um para cortar. A cor correta fica privada.</p>`;
  }
  if (type === 'document') return `${textarea('fragments', 'Fragmentos na ordem correta (um por linha)', draft.fragments, 'Primeiro trecho…\\nSegundo trecho…\\nTerceiro trecho…')}<p class="field-help">Os fragmentos são embaralhados na sala. Os jogadores precisam reorganizá-los antes de confirmar.</p>`;
  if (type === 'switches') return `${input('switchPattern', 'Combinação correta (0 = desligado, 1 = ligado)', draft.switchPattern || '10110', '10110')}<p class="field-help">Use de 2 a 10 posições. A combinação correta nunca é enviada ao painel público.</p>`;
  if (type === 'runes') return `${input('runeSymbols', 'Runas disponíveis (separadas por espaço)', draft.runeSymbols || 'ᚠ ᚢ ᚦ ᚨ ᚱ ᚲ', 'ᚠ ᚢ ᚦ ᚨ ᚱ ᚲ')}
    <label class="form-field"><span>Dimensão do altar</span><select name="runeGridSize">${[2,3,4,5].map((size) => `<option value="${size}" ${Number(draft.runeGridSize || 3) === size ? 'selected' : ''}>${size} × ${size}</option>`).join('')}</select></label>
    ${textarea('runePattern', 'Padrão correto (uma runa por linha)', draft.runePattern || 'ᚠ | 1 | 0\\nᚢ | 3 | 90\\nᚦ | 7 | 180\\nᚨ | 9 | 270', 'ᚠ | 1 | 0\\nᚢ | 3 | 90')}
    <p class="field-help">Formato: símbolo | posição | rotação. As posições são numeradas da esquerda para a direita, de cima para baixo. Rotação: 0, 90, 180 ou 270 graus. O padrão secreto não é publicado.</p>`;
  return '<p class="field-help">Selecione um tipo de interação.</p>';
}

function renderTemplateLibrary() {
  return `<section class="template-library-layout"><div class="master-intro"><div><span class="eyebrow">MODELOS DE PARTIDA</span><h1>Biblioteca de modelos</h1><p>Todo tipo de enigma tem uma demonstração pronta. Use o modelo como está ou personalize no editor.</p></div><button class="button button-quiet" data-action="tab-master">${state.editorDraft ? '← Voltar à configuração' : '← Voltar ao estúdio'}</button></div><div class="template-library-grid">${PUZZLE_TEMPLATES.map((template, index) => `<article class="template-card"><div class="template-card-top"><span class="template-card-index">${String(index + 1).padStart(2, '0')}</span><span class="template-difficulty">${escapeHtml(template.difficulty)}</span></div><span class="eyebrow">${escapeHtml(template.label)}</span><h3>${escapeHtml(template.draft.title)}</h3><p>${escapeHtml(template.description)}</p><div class="template-demo-preview"><small>DEMONSTRAÇÃO</small><strong>${escapeHtml(template.preview)}</strong></div><div class="template-card-footer"><span>Modelo editável · não publicado</span><button class="button button-primary" data-action="use-template" data-id="${escapeHtml(template.id)}">Usar modelo <span>→</span></button></div></article>`).join('')}</div></section>`;
}

function render() {
  if (!root) return;
  root.innerHTML = `${renderHeader()}${renderTabs()}<div class="app-content">${renderNotice()}${state.tab === 'master' && state.role === 'GM' ? renderMaster() : state.tab === 'library' && state.role === 'GM' ? renderTemplateLibrary() : state.tab === 'guide' && state.role === 'GM' ? renderGuide() : renderRoom()}</div><footer class="app-footer"><span> DYNAMIC PUZZLES <i>·</i> v0.3.0</span><span>${state.demoMode ? 'Demonstração local — nenhuma sala conectada' : 'Dados sincronizados pela sala do Owlbear Rodeo'}</span></footer>`;
}

function readForm(form) {
  const data = new FormData(form);
  return { ...Object.fromEntries(data.entries()), allowedPlayerIds: data.getAll('allowedPlayerIds') };
}

function draftFromPrivate(puzzle) {
  const draft = {
    title: puzzle.title,
    type: puzzle.type,
    description: puzzle.public.description,
    instructions: puzzle.public.instructions,
    attemptLimit: puzzle.public.attemptLimit,
    errorEffect: puzzle.public.errorEffect,
    rewardTitle: puzzle.reward?.title || '',
    rewardContent: puzzle.reward?.content || '',
    rewardUrl: puzzle.reward?.url || '',
    hints: (puzzle.hints || []).join('\n'),
    sequenceName: puzzle.public.sequenceName || '',
    sequenceOrder: puzzle.public.sequenceOrder || 1,
    participationMode: puzzle.public.participationMode || 'shared',
    allowedPlayerIds: puzzle.public.allowedPlayerIds || [],
    editorMode: 'advanced',
  };
  if (puzzle.type === 'lock') {
    if (puzzle.public.config.mode === 'deduction') Object.assign(draft, { lockMode: 'deduction', diceCount: puzzle.public.config.diceCount, diceSides: puzzle.public.config.diceSides, diceAnswer: (puzzle.secret.combination || []).join(', '), feedbackMode: puzzle.public.config.feedbackMode });
    else Object.assign(draft, { answer: puzzle.secret.code, lockMode: puzzle.public.config.mode });
  }
  if (puzzle.type === 'frequency') Object.assign(draft, {
    frequencyMin:puzzle.public.config.frequencyMin, frequencyMax:puzzle.public.config.frequencyMax,
    frequencyStep:puzzle.public.config.frequencyStep, frequencyTarget:puzzle.secret.targetFrequency,
    frequencyTolerance:puzzle.secret.frequencyTolerance,
    frequencyChannels:(puzzle.public.config.channels||[]).map((c)=>c.label).join(', '),
    frequencyTargetChannel:puzzle.public.config.channels.find((c)=>c.id===puzzle.secret.targetChannelId)?.label||'',
    frequencyUseAmplitude:puzzle.secret.useAmplitude?'yes':'no',
    frequencyAmplitudeMin:puzzle.public.config.amplitudeMin, frequencyAmplitudeMax:puzzle.public.config.amplitudeMax,
    frequencyAmplitudeStep:puzzle.public.config.amplitudeStep, frequencyAmplitudeTarget:puzzle.secret.targetAmplitude,
    frequencyAmplitudeTolerance:puzzle.secret.amplitudeTolerance, frequencyInterference:puzzle.public.config.interference,
  });
  if (puzzle.type === 'social') Object.assign(draft, { socialMode: puzzle.public.config.mode, requiredAnswers: puzzle.public.config.requiredAnswers, socialQuestions: (puzzle.secret.questions || []).map((question) => `${question.prompt} | ${question.answers?.[0] || ''} | ${(question.answers || []).slice(1).join(';')}`).join('\n') });
  if (puzzle.type === 'terminal') Object.assign(draft, { username: puzzle.secret.username, password: puzzle.secret.password, acceptedCommands: (puzzle.secret.commands || []).join('\n'), terminalLabel: puzzle.public.config.terminalLabel });
  if (puzzle.type === 'cipher') Object.assign(draft, { answer: puzzle.secret.solution, cipherText: puzzle.public.config.cipherText, cipherMethod: puzzle.public.config.method, shift: puzzle.public.config.shift });
  if (puzzle.type === 'sequence') Object.assign(draft, { availableSymbols: puzzle.public.config.symbols.join(' '), answerSequence: puzzle.secret.sequence.join(' ') });
  if (puzzle.type === 'wires') Object.assign(draft, { wireColors: puzzle.public.config.wires.map((wire) => wire.label).join(', '), correctWire: puzzle.secret.correctWire });
  if (puzzle.type === 'document') {
    const fragments = new Map(puzzle.public.config.fragments.map((fragment) => [fragment.id, fragment.text]));
    Object.assign(draft, { fragments: puzzle.secret.order.map((id) => fragments.get(id) || '').join('\n') });
  }
  if (puzzle.type === 'switches') Object.assign(draft, { switchPattern: puzzle.secret.pattern.map((bit) => bit ? '1' : '0').join('') });
  if (puzzle.type === 'runes') Object.assign(draft, { runeSymbols: puzzle.public.config.runes.map((rune) => rune.symbol).join(' '), runeGridSize: puzzle.public.config.gridSize, runePattern: puzzle.secret.placements.map((item) => `${puzzle.public.config.runes.find((rune) => rune.id === item.runeId)?.symbol || ''} | ${item.position + 1} | ${item.rotation}`).join('\\n') });
  return draft;
}

function normalizeName(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('pt-BR'); }

function validateEditor(values) {
  if (!values.title?.trim()) return 'Dê um nome ao enigma.';
  if (values.type === 'lock') {
    if (values.lockMode === 'deduction') {
      const count = Number(values.diceCount); const sides = Number(values.diceSides);
      const combination = String(values.diceAnswer || '').split(/[\s,;.-]+/).filter(Boolean).map(Number);
      if (!Number.isInteger(count) || count < 1 || count > 20) return 'A quantidade de dados deve ficar entre 1 e 20.';
      if (![4, 6, 8, 10, 12].includes(sides)) return 'Escolha D4, D6, D8, D10 ou D12.';
      if (combination.length !== count || combination.some((value) => !Number.isInteger(value) || value < 1 || value > sides)) return `Informe exatamente ${count} valores inteiros entre 1 e ${sides}, na ordem correta.`;
    } else if (!values.answer?.trim()) return 'Informe a combinação correta do cadeado.';
  }
  if (values.type === 'frequency') {
    const min=Number(values.frequencyMin), max=Number(values.frequencyMax), step=Number(values.frequencyStep), target=Number(values.frequencyTarget), tol=Number(values.frequencyTolerance??0.5);
    const channels=String(values.frequencyChannels||'').split(/[\\n,;]+/).map(v=>v.trim()).filter(Boolean);
    if (![min,max,step,target,tol].every(Number.isFinite)) return 'Preencha os valores de frequência com números válidos.';
    if (max<=min || step<=0 || step>max-min) return 'A faixa ou o intervalo de sintonia é inválido.';
    if (target<min || target>max) return 'A frequência secreta precisa estar dentro da faixa configurada.';
    if (tol<0 || tol>max-min) return 'A tolerância da frequência é inválida.';
    if (!channels.length) return 'Adicione pelo menos um canal.';
    if (!channels.some(v=>normalizeName(v)===normalizeName(values.frequencyTargetChannel))) return 'O canal correto precisa corresponder a um dos canais disponíveis.';
    if (values.frequencyUseAmplitude==='yes') {
      const amin=Number(values.frequencyAmplitudeMin??0), amax=Number(values.frequencyAmplitudeMax??100), astep=Number(values.frequencyAmplitudeStep??1), atarget=Number(values.frequencyAmplitudeTarget??65), atol=Number(values.frequencyAmplitudeTolerance??5);
      if (![amin,amax,astep,atarget,atol].every(Number.isFinite)) return 'Preencha os valores de amplitude com números válidos.';
      if (amax<=amin || astep<=0 || astep>amax-amin || atarget<amin || atarget>amax || atol<0 || atol>amax-amin) return 'A faixa, amplitude secreta ou tolerância está inválida.';
    }
  }
  if (values.type === 'social') {
    const questions = String(values.socialQuestions || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.split('|').map((part) => part.trim()));
    if (!questions.length || questions.some((parts) => !parts[0] || !parts[1])) return 'Adicione pelo menos uma pergunta com resposta correta. Use pergunta | resposta | variações.';
    const required = Number(values.requiredAnswers);
    if (!Number.isInteger(required) || required < 1 || required > questions.length) return `A quantidade necessária deve ficar entre 1 e ${questions.length}.`;
  }
  if (values.type === 'terminal' && !values.username?.trim() && !values.password?.trim() && !values.acceptedCommands?.trim()) return 'Configure um login ou pelo menos um comando aceito.';
  if (values.type === 'cipher' && (!values.answer?.trim() || !values.cipherText?.trim())) return 'Informe o texto cifrado e a resposta correta.';
  if (values.type === 'sequence' && (!values.answerSequence?.trim() || !values.availableSymbols?.trim())) return 'Configure os símbolos e a sequência correta.';
  if (values.type === 'wires' && !values.wireColors?.trim()) return 'Informe ao menos um fio.';
  if (values.type === 'document' && values.fragments?.split('\n').filter((part) => part.trim()).length < 2) return 'O documento precisa de pelo menos dois fragmentos.';
  if (values.type === 'switches' && values.switchPattern?.replace(/[^01]/g, '').length < 2) return 'O painel precisa de pelo menos dois interruptores.';
  if (values.type === 'runes') {
    const symbols = [...new Set(String(values.runeSymbols || '').split(/[\\s,;]+/).filter(Boolean))];
    const size = Number(values.runeGridSize || 3);
    const rows = String(values.runePattern || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.split('|').map((part) => part.trim()));
    if (symbols.length < 2) return 'Adicione pelo menos duas runas disponíveis.';
    if (!Number.isInteger(size) || size < 2 || size > 5) return 'O altar deve ter entre 2×2 e 5×5 posições.';
    if (rows.length < 2) return 'Defina pelo menos duas runas no padrão correto.';
    const positions = rows.map((row) => Number(row[1]));
    if (rows.some((row) => !symbols.includes(row[0]) || !Number.isInteger(Number(row[1])) || Number(row[1]) < 1 || Number(row[1]) > size * size || ![0,90,180,270].includes(Number(row[2] || 0))) || new Set(rows.map((row) => row[0])).size !== rows.length || new Set(positions).size !== rows.length) return 'Revise o padrão: runa | posição | rotação (0, 90, 180 ou 270), sem repetir runas ou posições.';
  }
  if (String(values.hints || '').split('\n').filter((item) => item.trim()).length > 5) return 'Configure no máximo cinco dicas graduais.';
  if (String(values.sequenceName || '').trim()) {
    const order = Number(values.sequenceOrder || 1);
    if (!Number.isInteger(order) || order < 1 || order > 99) return 'A etapa da sequência deve ficar entre 1 e 99.';
    const matchingStages = state.privatePuzzles.filter((item) => item.id !== state.editorId && item.public.sequenceName && normalizeName(item.public.sequenceName) === normalizeName(values.sequenceName));
    const duplicate = matchingStages.find((item) => Number(item.public.sequenceOrder) === order);
    if (duplicate) return `A sequência “${values.sequenceName}” já tem uma etapa ${order}. Escolha outro número.`;
    if (order === 1 && matchingStages.some((item) => Number(item.public.sequenceOrder) < 1)) return 'A sequência tem uma etapa inválida. Revise a numeração.';
    if (order > 1 && !matchingStages.some((item) => Number(item.public.sequenceOrder) === 1)) return `Crie a etapa 1 da sequência “${values.sequenceName}” antes de adicionar outras etapas.`;
    if (order > 1 && !matchingStages.some((item) => Number(item.public.sequenceOrder) === order - 1)) return `Crie ou numere a etapa ${order - 1} antes da etapa ${order}.`;
  }
  return '';
}

async function onSubmit(event) {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const formType = form.dataset.form;
  if (formType === 'puzzle-editor') {
    const values = readForm(form);
    const validation = validateEditor(values);
    if (validation) return setNotice(validation, 'warning');
    const previous = state.editorId ? getPrivatePuzzle(state.editorId) : null;
    if (!previous && state.privatePuzzles.length >= MAX_PUZZLES) return setNotice(`O limite é de ${MAX_PUZZLES} enigmas por sala.`, 'warning');
    try {
      const puzzle = makePuzzle({
        ...values,
        participationMode: values.participationMode || 'shared',
        allowedPlayerIds: values.allowedPlayerIds || [],
        title: safeText(values.title, 80),
        description: safeText(values.description, 300),
        instructions: safeText(values.instructions, 400),
        rewardTitle: safeText(values.rewardTitle, 60),
        rewardContent: safeText(values.rewardContent, 600),
        rewardUrl: safeText(values.rewardUrl, 500),
      }, previous);
      if (previous) state.privatePuzzles = state.privatePuzzles.map((item) => item.id === previous.id ? puzzle : item);
      else state.privatePuzzles = [...state.privatePuzzles, puzzle];
      state.selectedPuzzleId = puzzle.id;
      recalculateSequenceLocks(state.privatePuzzles);
      state.editorDraft = null;
      state.editorId = null;
      state.tab = 'master';
      await saveAndPublish();
      setNotice(previous ? 'Enigma atualizado e sincronizado.' : 'Enigma criado e publicado na sala.', 'success');
    } catch (error) {
      console.error(error);
      setNotice(`Não foi possível criar o enigma: ${error.message}`, 'error');
    }
    return;
  }
  if (formType === 'attempt-lock') {
    return submitPayload({ value: safeText(new FormData(form).get('value'), 32) });
  }
  if (formType === 'attempt-lock-wheel') {
    const value = [...form.querySelectorAll('[data-wheel]')].map((select) => select.value).join('');
    return submitPayload({ value });
  }
  if (formType === 'attempt-dice-lock') {
    const guess = [...form.querySelectorAll('[data-dice-guess]')].map((select) => Number(select.value));
    return submitPayload({ guess });
  }
  if (formType === 'attempt-social') {
    const values = readForm(form);
    return submitPayload({ questionIndex: Number(values.questionIndex), answer: safeText(values.answer, 160) });
  }
  if (formType === 'attempt-frequency') {
    const values=readForm(form);
    return submitPayload({frequency:Number(values.frequency),channelId:safeText(values.channelId,40),...(values.amplitude!==undefined?{amplitude:Number(values.amplitude)}:{})});
  }
  if (formType === 'attempt-terminal') {
    const values = readForm(form);
    const mode = event.submitter?.dataset.mode || 'login';
    return submitPayload({ kind: 'terminal', username: safeText(values.username, 80), password: safeText(values.password, 80), command: mode === 'command' ? safeText(values.command, 100) : '' });
  }
  if (formType === 'attempt-cipher') return submitPayload({ value: safeText(new FormData(form).get('value'), 300) });
}

function onClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === 'tab-room') { state.tab = 'room'; state.notice = ''; return render(); }
  if (action === 'tab-master') { state.tab = 'master'; state.notice = ''; return render(); }
  if (action === 'tab-guide') { state.tab = 'guide'; state.notice = ''; return render(); }
  if (action === 'tab-library') { state.tab = 'library'; state.notice = ''; return render(); }
  if (action === 'editor-mode-simple' || action === 'editor-mode-advanced') { state.editorDraft = { ...state.editorDraft, ...readForm(root.querySelector('form[data-form=\"puzzle-editor\"]')), editorMode: action === 'editor-mode-advanced' ? 'advanced' : 'simple' }; return render(); }
  if (action === 'load-template' || action === 'use-template') {
    const templateKey = action === 'load-template'
      ? (state.editorDraft?.type === 'lock' && state.editorDraft?.lockMode === 'deduction'
        ? 'lock-dice'
        : state.editorDraft?.type === 'lock' && state.editorDraft?.lockMode === 'wheel'
          ? 'lock-wheel'
          : (state.editorDraft?.type || 'lock'))
      : (id || 'lock');
    const templateDraft = getPuzzleTemplate(templateKey);
    if (!templateDraft) return;
    state.editorId = action === 'load-template' ? state.editorId : null;
    state.editorDraft = { ...templateDraft, editorMode: state.editorDraft?.editorMode || 'simple', sequenceOrder: 1 };
    state.tab = 'master';
    state.notice = '';
    return render();
  }
  if (action === 'release-hint') {
    const puzzle = getPrivatePuzzle(id);
    if (!puzzle) return setNotice('Este enigma não tem respostas privadas neste navegador.', 'warning');
    const nextIndex = puzzle.public.revealedHints?.length || 0;
    const nextHint = puzzle.hints?.[nextIndex];
    if (!nextHint) return setNotice('Todas as dicas deste enigma já foram liberadas.', 'info');
    puzzle.public.revealedHints = [...(puzzle.public.revealedHints || []), { index: nextIndex + 1, text: nextHint, at: Date.now() }];
    puzzle.public.updatedAt = Date.now();
    saveAndPublish();
    return setNotice(`Dica ${nextIndex + 1} liberada para a sala.`, 'success');
  }
  if (action === 'dismiss-notice') { state.notice = ''; return render(); }
  if (action === 'select-puzzle') {
    state.selectedPuzzleId = id; state.sequence = []; state.selectedWireId = null; state.fragmentOrder = []; state.switches = []; state.cipherOffset = 0; state.notice = ''; return render();
  }
  if (action === 'new-puzzle') {
    state.editorId = null;
    state.editorDraft = { type: 'lock', attemptLimit: 0, errorEffect: 'none', lockMode: 'keypad', editorMode: 'simple', sequenceOrder: 1 };
    return render();
  }
  if (action === 'cancel-editor') { state.editorDraft = null; state.editorId = null; return render(); }
  if (action === 'edit-puzzle') {
    const puzzle = getPrivatePuzzle(id);
    if (!puzzle) return setNotice('As configurações privadas deste enigma não estão neste navegador.', 'warning');
    state.editorId = id; state.editorDraft = draftFromPrivate(puzzle); return render();
  }
  if (action === 'delete-puzzle') {
    if (!confirm('Excluir este enigma e suas respostas privadas?')) return;
    state.privatePuzzles = state.privatePuzzles.filter((puzzle) => puzzle.id !== id);
    state.selectedPuzzleId = state.privatePuzzles[0]?.id || null;
    recalculateSequenceLocks(state.privatePuzzles);
    saveAndPublish(); return setNotice('Enigma removido da sala.', 'success');
  }
  if (action === 'reset-puzzle') {
    const puzzle = getPrivatePuzzle(id);
    if (!puzzle) return;
    const sequenceName = puzzle.public.sequenceName;
    const targets = sequenceName
      ? state.privatePuzzles.filter((item) => normalizeName(item.public.sequenceName) === normalizeName(sequenceName) && Number(item.public.sequenceOrder) >= Number(puzzle.public.sequenceOrder))
      : [puzzle];
    for (const target of targets) {
      target.public.attemptsUsed = 0;
      target.public.consequenceCount = 0;
      target.public.clockCount = 0;
      target.public.alarmCount = 0;
      target.public.solved = false;
      target.public.locked = false;
      target.public.history = [];
      target.public.questionIndex = 0;
      target.public.solvedQuestionIds = [];
      target.public.reveal = null;
      target.public.revealedHints = [];
      target.public.playerProgress = {};
    }
    recalculateSequenceLocks(state.privatePuzzles);
    saveAndPublish(); return setNotice(sequenceName ? `Etapa e etapas seguintes reiniciadas (${targets.length}).` : 'Progresso do enigma reiniciado.', 'success');
  }
  if (action === 'seed-demo') {
    const examples = createDemoPuzzles();
    if (state.privatePuzzles.length + examples.length > MAX_PUZZLES) return setNotice(`Não há espaço para adicionar os ${examples.length} exemplos. Exclua alguns enigmas primeiro.`, 'warning');
    state.privatePuzzles = [...state.privatePuzzles, ...examples];
    saveAndPublish(); return setNotice(`${examples.length} exemplos adicionados à biblioteca.`, 'success');
  }
  if (action === 'append-key') {
    const input = root.querySelector('[data-lock-input]');
    if (input && input.value.length < 32) input.value += button.dataset.key;
    return;
  }
  if (action === 'clear-lock') { const input = root.querySelector('[data-lock-input]'); if (input) input.value = ''; return; }
  if (action === 'sequence-add') { if (state.sequence.length < 16) state.sequence.push(button.dataset.symbol); if (state.connected && state.role === 'PLAYER') sendActivity(getSelectedPuzzle()?.id, `montando sequência: ${state.sequence.join(' ')}`); return render(); }
  if (action === 'sequence-remove') { state.sequence.splice(Number(button.dataset.index), 1); return render(); }
  if (action === 'sequence-clear') { state.sequence = []; return render(); }
  if (action === 'submit-sequence') { const value = [...state.sequence]; state.sequence = []; return submitPayload({ value }); }
  if (action === 'select-wire') { state.selectedWireId = id; const wire = getSelectedPuzzle()?.config?.wires?.find((item) => item.id === id); if (state.connected && state.role === 'PLAYER') sendActivity(getSelectedPuzzle()?.id, `selecionou o fio ${wire?.label || ''}`); return render(); }
  if (action === 'submit-wire') { const value = state.selectedWireId; state.selectedWireId = null; return submitPayload({ value }); }
  if (action === 'move-fragment') {
    const puzzle = getSelectedPuzzle();
    const fragments = puzzle?.config.fragments || [];
    if (!state.fragmentOrder.length) state.fragmentOrder = fragments.map((fragment) => fragment.id);
    const index = Number(button.dataset.index);
    const destination = index + Number(button.dataset.direction);
    if (destination >= 0 && destination < state.fragmentOrder.length) {
      [state.fragmentOrder[index], state.fragmentOrder[destination]] = [state.fragmentOrder[destination], state.fragmentOrder[index]];
    }
    return render();
  }
  if (action === 'submit-document') {
    const puzzle = getSelectedPuzzle();
    if (!state.fragmentOrder.length) state.fragmentOrder = (puzzle?.config.fragments || []).map((fragment) => fragment.id);
    const order = [...state.fragmentOrder]; state.fragmentOrder = []; return submitPayload({ order });
  }
  if (action === 'toggle-switch') {
    const index = Number(button.dataset.index);
    state.switches[index] = !state.switches[index];
    if (state.connected && state.role === 'PLAYER') sendActivity(getSelectedPuzzle()?.id, `interruptores: ${state.switches.map((bit) => bit ? '1' : '0').join('')}`);
    return render();
  }
  if (action === 'submit-switches') { const value = [...state.switches]; return submitPayload({ value }); }
  if (action === 'select-rune') { state.selectedRuneId = id; return render(); }
  if (action === 'place-rune') { const position = Number(button.dataset.position); const existing = state.runePlacements.find((item) => item.position === position); if (existing) { state.selectedRuneId = existing.runeId; return render(); } if (!state.selectedRuneId) return; state.runePlacements = [...state.runePlacements.filter((item) => item.runeId !== state.selectedRuneId), { runeId: state.selectedRuneId, position, rotation: 0 }]; state.selectedRuneId = null; if (state.connected && state.role === 'PLAYER') sendActivity(getSelectedPuzzle()?.id, 'posicionando runas no altar'); return render(); }
  if (action === 'rotate-rune') { const item = state.runePlacements.find((rune) => rune.position === Number(button.dataset.position)); if (item) item.rotation = (item.rotation + 90) % 360; return render(); }
  if (action === 'remove-rune') { state.runePlacements = state.runePlacements.filter((item) => item.position !== Number(button.dataset.position)); return render(); }
  if (action === 'clear-runes') { state.runePlacements = []; state.selectedRuneId = null; return render(); }
  if (action === 'submit-runes') { const placements = state.runePlacements.map((item) => ({ ...item })); return submitPayload({ placements }); }
  if (action === 'export-backup') return exportBackup();
}

function onInput(event) {
  if (state.connected && state.role === 'PLAYER' && event.target.closest('form[data-form^="attempt-"]')) {
    if (event.target.matches('[data-frequency-range]')) sendActivity(getSelectedPuzzle()?.id, `sintonizando em ${Number(event.target.value).toFixed(1)} MHz`);
    else if (event.target.matches('[data-amplitude-range]')) sendActivity(getSelectedPuzzle()?.id, `ajustando amplitude para ${Number(event.target.value)}%`);
    else sendActivity(getSelectedPuzzle()?.id, 'preenchendo os controles do enigma');
  }
  if (event.target.matches('[data-frequency-range]')) {
    const out=root.querySelector('[data-frequency-value]');
    if (out) out.textContent=`${Number(event.target.value).toFixed(1).replace('.',',')} MHz`;
  }
  if (event.target.matches('[data-amplitude-range]')) {
    const out=root.querySelector('[data-amplitude-value]');
    if (out) out.textContent=`${Number(event.target.value).toLocaleString('pt-BR')}%`;
  }
}

function onChange(event) {
  if (event.target.matches('[data-cipher-offset]')) {
    state.cipherOffset = Number(event.target.value) || 0;
    return render();
  }
  if (event.target.matches('[data-editor-type], [data-editor-lock-mode], [data-editor-social-mode], [data-editor-frequency-amplitude], [data-editor-participation-mode]')) {
    const form = event.target.closest('form');
    const values = readForm(form);
    const type = event.target.matches('[data-editor-type]') ? event.target.value : (values.type || state.editorDraft?.type || 'lock');
    state.editorDraft = { ...state.editorDraft, ...values, type };
    return render();
  }
  if (event.target.matches('[data-action="import-backup"]')) return importBackup(event.target.files?.[0]);
}

function exportBackup() {
  const data = {
    app: 'Dynamic Puzzles',
    version: '0.3.0',
    exportedAt: new Date().toISOString(),
    roomHint: state.roomId,
    puzzles: state.privatePuzzles,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'dynamic-puzzles-backup.json';
  anchor.click();
  URL.revokeObjectURL(url);
  setNotice('Backup privado exportado. Guarde o arquivo em local seguro: ele contém as respostas.', 'success');
}

async function importBackup(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed.puzzles) || parsed.puzzles.length > MAX_PUZZLES) throw new Error('Arquivo inválido ou com muitos enigmas.');
    if (!confirm(`Importar ${parsed.puzzles.length} enigma(s)? Isso substituirá a biblioteca privada desta sala.`)) return;
    state.privatePuzzles = parsed.puzzles;
    for (const puzzle of state.privatePuzzles) {
      puzzle.hints ||= [];
      puzzle.public.revealedHints ||= [];
      puzzle.public.hintCount = puzzle.hints.length;
      puzzle.public.sequenceName ||= '';
      puzzle.public.sequenceOrder ||= 1;
    }
    recalculateSequenceLocks(state.privatePuzzles);
    state.selectedPuzzleId = state.privatePuzzles[0]?.id || null;
    await saveAndPublish();
    setNotice('Backup importado e publicado na sala.', 'success');
  } catch (error) {
    setNotice(`Falha ao importar backup: ${error.message}`, 'error');
  }
}

root.addEventListener('click', onClick);
root.addEventListener('submit', onSubmit);
root.addEventListener('change', onChange);
root.addEventListener('input', onInput);
root.addEventListener('dragstart', (event) => {
  const runeToken = event.target.closest('[data-rune-token]');
  const runeCell = event.target.closest('[data-rune-cell].occupied');
  if (runeToken) { state.draggedRuneId = runeToken.dataset.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', state.draggedRuneId); return; }
  if (runeCell) { state.draggedRuneId = state.runePlacements.find((item) => item.position === Number(runeCell.dataset.positionId))?.runeId || null; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', state.draggedRuneId || ''); return; }
  const row = event.target.closest('[data-fragment-row]');
  if (!row) return;
  state.draggedFragmentId = row.dataset.fragmentId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', state.draggedFragmentId);
});
root.addEventListener('dragover', (event) => {
  if (event.target.closest('[data-fragment-row], [data-rune-cell]')) event.preventDefault();
});
root.addEventListener('drop', (event) => {
  const runeTarget = event.target.closest('[data-rune-cell]');
  if (runeTarget) { event.preventDefault(); const runeId = state.draggedRuneId || event.dataTransfer.getData('text/plain'); const position = Number(runeTarget.dataset.positionId); const occupied = state.runePlacements.find((item) => item.position === position); const moving = state.runePlacements.find((item) => item.runeId === runeId); if (runeId && (!occupied || occupied.runeId === runeId)) { state.runePlacements = [...state.runePlacements.filter((item) => item.runeId !== runeId), { runeId, position, rotation: moving?.rotation || 0 }]; if (state.connected && state.role === 'PLAYER') sendActivity(getSelectedPuzzle()?.id, 'movendo runas no altar'); render(); } state.draggedRuneId = null; return; }
  const targetRow = event.target.closest('[data-fragment-row]');
  const sourceId = state.draggedFragmentId || event.dataTransfer.getData('text/plain');
  if (!targetRow || !sourceId || sourceId === targetRow.dataset.fragmentId) return;
  event.preventDefault();
  const puzzle = getSelectedPuzzle();
  const fragments = puzzle?.config.fragments || [];
  if (!state.fragmentOrder.length) state.fragmentOrder = fragments.map((fragment) => fragment.id);
  const from = state.fragmentOrder.indexOf(sourceId);
  const to = state.fragmentOrder.indexOf(targetRow.dataset.fragmentId);
  if (from >= 0 && to >= 0) {
    state.fragmentOrder.splice(to, 0, state.fragmentOrder.splice(from, 1)[0]);
    if (state.connected && state.role === 'PLAYER') sendActivity(puzzle?.id, 'reorganizando o documento');
    render();
  }
  state.draggedFragmentId = null;
});

let attemptQueue = Promise.resolve();
const originalProcessAttempt = processAttempt;
function queueAttempt(request) {
  attemptQueue = attemptQueue.then(() => originalProcessAttempt(request)).catch((error) => {
    console.error('Falha ao processar tentativa remota:', error);
    setNotice('O mestre não conseguiu processar uma tentativa. Verifique a conexão.', 'error');
  });
}

// Bootstrap is wired below with a serialized queue for simultaneous player submissions.
bootstrap();
