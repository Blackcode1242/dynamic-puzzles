import './style.css';
import {
  PUZZLE_TYPES,
  ERROR_EFFECTS,
  DEFAULT_SYMBOLS,
  makePuzzle,
  validateAttempt,
  attemptLabel,
  toPublicState,
  createDemoPuzzles,
} from './model.js';
import {
  connectToOwlbear,
  publishPublicState,
  submitAttempt as sendRemoteAttempt,
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
  return getPuzzle(state.selectedPuzzleId) || currentPublicPuzzles()[0] || null;
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
  render();
}

function compactPublicState(publicState) {
  const next = structuredClone(publicState);
  const measure = () => new TextEncoder().encode(JSON.stringify(next)).length;
  if (measure() > ROOM_METADATA_LIMIT) {
    for (const puzzle of next.puzzles) puzzle.history = (puzzle.history || []).slice(-6);
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
    });
    state.connected = connection.connected;
    state.role = connection.role;
    state.roomId = connection.roomId;
    state.playerName = connection.playerName || 'Jogador';
    state.demoMode = !connection.connected;
    state.playerNameDraft = state.playerName;

    if (state.role === 'GM') {
      state.privatePuzzles = loadPrivatePuzzles();
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

function recordAttempt(privatePuzzle, payload, actor) {
  const publicPuzzle = privatePuzzle.public;
  if (publicPuzzle.solved) return { ok: false, message: 'Este enigma já foi resolvido.' };
  if (publicPuzzle.locked) return { ok: false, message: 'Este enigma está bloqueado. Peça ao mestre para reiniciá-lo.' };
  const correct = validateAttempt(privatePuzzle, payload);
  publicPuzzle.attemptsUsed += 1;
  const submitted = attemptLabel(privatePuzzle, payload).slice(0, 110);
  const entry = {
    id: crypto.randomUUID(),
    actor: safeText(actor || 'Jogador', 48),
    submitted,
    result: correct ? 'success' : 'failure',
    at: Date.now(),
  };
  publicPuzzle.history = [...(publicPuzzle.history || []), entry].slice(-15);
  publicPuzzle.updatedAt = Date.now();

  if (correct) {
    publicPuzzle.solved = true;
    publicPuzzle.locked = false;
    publicPuzzle.reveal = privatePuzzle.reward;
  } else {
    if (publicPuzzle.errorEffect !== 'none') publicPuzzle.consequenceCount += 1;
    if (publicPuzzle.errorEffect === 'clock') publicPuzzle.clockCount += 1;
    if (publicPuzzle.errorEffect === 'alarm') publicPuzzle.alarmCount += 1;
    if (publicPuzzle.errorEffect === 'lockdown') publicPuzzle.locked = true;
    if (publicPuzzle.attemptLimit > 0 && publicPuzzle.attemptsUsed >= publicPuzzle.attemptLimit) {
      publicPuzzle.locked = true;
    }
  }
  return {
    ok: correct,
    message: correct
      ? `Enigma resolvido: ${privatePuzzle.title}`
      : publicPuzzle.locked
        ? 'Resposta incorreta. O enigma foi bloqueado.'
        : 'Resposta incorreta. A consequência foi registrada.',
  };
}

async function processAttempt(request) {
  if (state.role !== 'GM') return;
  const privatePuzzle = getPrivatePuzzle(request?.puzzleId);
  if (!privatePuzzle) return;
  const result = recordAttempt(privatePuzzle, request.payload, request.playerName || 'Jogador');
  await saveAndPublish();
  if (state.connected) showNotification(result.message, result.ok ? 'SUCCESS' : 'WARNING');
  if (state.demoMode) setNotice(result.message, result.ok ? 'success' : 'warning');
}

async function submitPayload(payload) {
  const puzzle = getSelectedPuzzle();
  if (!puzzle) return;
  if (puzzle.solved || puzzle.locked) {
    setNotice(puzzle.solved ? 'Este enigma já foi solucionado.' : 'Este enigma está bloqueado.', 'warning');
    return;
  }

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
  const result = recordAttempt(privatePuzzle, payload, state.demoMode ? 'Você (teste)' : 'Teste do mestre');
  await saveAndPublish();
  setNotice(result.message, result.ok ? 'success' : 'warning');
  if (state.connected) showNotification(result.message, result.ok ? 'SUCCESS' : 'WARNING');
}

function statusChip(puzzle) {
  if (puzzle.solved) return '<span class="pill pill-success"><span class="dot"></span> Resolvido</span>';
  if (puzzle.locked) return '<span class="pill pill-danger"><span class="dot"></span> Bloqueado</span>';
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
      ${state.role === 'GM' ? `<button class="tab ${state.tab === 'master' ? 'active' : ''}" data-action="tab-master"><span class="tab-icon">⚙</span> Estúdio do mestre</button>` : ''}
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
            <button class="puzzle-nav-item ${selected?.id === puzzle.id ? 'selected' : ''}" data-action="select-puzzle" data-id="${escapeHtml(puzzle.id)}">
              <span class="puzzle-number">${String(index + 1).padStart(2, '0')}</span>
              <span class="puzzle-nav-copy"><strong>${escapeHtml(puzzle.title)}</strong><small>${escapeHtml(TYPE_LABELS[puzzle.type] || puzzle.type)}</small></span>
              <span class="nav-state ${puzzle.solved ? 'done' : puzzle.locked ? 'locked' : ''}"></span>
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
  const consequence = [];
  if (puzzle.clockCount) consequence.push(`<span class="counter counter-clock">◷ Relógio +${puzzle.clockCount}</span>`);
  if (puzzle.alarmCount) consequence.push(`<span class="counter counter-alarm">♢ Alarmes ${puzzle.alarmCount}</span>`);
  const attemptsLabel = puzzle.attemptLimit > 0 ? `${puzzle.attemptsUsed} / ${puzzle.attemptLimit}` : `${puzzle.attemptsUsed} / ∞`;
  return `
    <div class="puzzle-heading-row">
      <div><span class="eyebrow">${escapeHtml(TYPE_LABELS[puzzle.type] || 'ENIGMA')} · DESAFIO ATIVO</span><h1>${escapeHtml(puzzle.title)}</h1></div>
      ${statusChip(puzzle)}
    </div>
    ${puzzle.description ? `<p class="puzzle-description">${escapeHtml(puzzle.description)}</p>` : ''}
    <div class="puzzle-meta-row"><span>⌁ Tentativas <b>${escapeHtml(attemptsLabel)}</b></span>${consequence.join('')}</div>
    <section class="challenge-card">
      <div class="challenge-topline"><span class="challenge-kicker">INTERFACE DO DESAFIO</span><span class="challenge-coord">DP / ${escapeHtml(puzzle.id.slice(0, 5).toUpperCase())}</span></div>
      ${puzzle.instructions ? `<div class="instruction-box"><span class="instruction-icon">✧</span><p>${escapeHtml(puzzle.instructions)}</p></div>` : ''}
      ${puzzle.solved ? renderSolved(puzzle) : puzzle.locked ? renderLocked(puzzle) : renderPlayerControls(puzzle)}
    </section>
    ${renderHistory(puzzle)}
  `;
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
    case 'sequence': return renderSequence(puzzle);
    case 'wires': return renderWires(puzzle);
    case 'document': return renderDocument(puzzle);
    case 'switches': return renderSwitches(puzzle);
    default: return '<p class="muted">Tipo de enigma não suportado.</p>';
  }
}

function renderLock(puzzle) {
  if (puzzle.config.mode === 'wheel') {
    return `<form class="control-form" data-form="attempt-lock-wheel"><div class="field-label">AJUSTE OS DISCOS</div><div class="wheel-row">${Array.from({ length: puzzle.config.wheelLength }, (_, index) => `<select class="wheel-select" data-wheel aria-label="Disco ${index + 1}">${'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((symbol) => `<option>${symbol}</option>`).join('')}</select>`).join('')}</div><button class="button button-primary button-wide" type="submit">Confirmar combinação <span>→</span></button></form>`;
  }
  return `<form class="control-form" data-form="attempt-lock"><label class="field-label" for="lock-value">DIGITE A COMBINAÇÃO</label><input id="lock-value" class="code-input" name="value" data-lock-input maxlength="32" autocomplete="off" placeholder="••••••" /><div class="keypad">${'1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((key) => `<button type="button" class="key" data-action="append-key" data-key="${key}">${key}</button>`).join('')}</div><div class="control-actions"><button class="button button-quiet" type="button" data-action="clear-lock">Limpar</button><button class="button button-primary" type="submit">Destravar <span>→</span></button></div></form>`;
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

function renderSwitches(puzzle) {
  const count = puzzle.config.switchCount || 5;
  if (state.switches.length !== count) state.switches = Array.from({ length: count }, () => false);
  return `<div class="switch-game"><div class="field-label">PAINEL DE CONTROLE · ${count} CANAIS</div><div class="switch-row">${state.switches.map((enabled, index) => `<button type="button" class="switch-cell ${enabled ? 'on' : ''}" data-action="toggle-switch" data-index="${index}"><span class="switch-track"><i></i></span><b>${String(index + 1).padStart(2, '0')}</b><small>${enabled ? 'LIGADO' : 'DESLIGADO'}</small></button>`).join('')}</div><div class="switch-readout"><span>ESTADO DO CIRCUITO</span><strong>${state.switches.map((bit) => bit ? '1' : '0').join('')}</strong></div><button class="button button-primary button-wide" type="button" data-action="submit-switches">Aplicar combinação <span>→</span></button></div>`;
}

function renderHistory(puzzle) {
  const history = [...(puzzle.history || [])].reverse();
  return `<section class="history-section"><div class="section-heading"><div><span class="eyebrow">REGISTRO DA SALA</span><h3>Histórico de tentativas</h3></div><span class="history-total">${history.length.toString().padStart(2, '0')} EVENTOS</span></div>${history.length ? `<div class="history-list">${history.map((entry) => `<div class="history-item"><span class="history-result ${entry.result === 'success' ? 'success' : 'failure'}">${entry.result === 'success' ? '✓' : '×'}</span><span class="history-player">${escapeHtml(entry.actor)}</span><span class="history-submitted">${escapeHtml(entry.submitted)}</span><span class="history-time">${new Date(entry.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span></div>`).join('')}</div>` : '<p class="history-empty">Nenhuma tentativa registrada. O registro aparecerá aqui para todos os jogadores.</p>'}</section>`;
}

function renderMaster() {
  if (state.editorDraft) return renderEditor();
  const puzzles = state.privatePuzzles;
  const solved = puzzles.filter((puzzle) => puzzle.public.solved).length;
  const alarms = puzzles.reduce((sum, puzzle) => sum + puzzle.public.alarmCount, 0);
  const clocks = puzzles.reduce((sum, puzzle) => sum + puzzle.public.clockCount, 0);
  return `<section class="master-layout">
    <div class="master-intro"><div><span class="eyebrow">CONTROLE DE CAMPANHA</span><h1>Estúdio do mestre</h1><p>Crie, configure e acompanhe os desafios da sua sala.</p></div><button class="button button-primary" data-action="new-puzzle" ${puzzles.length >= MAX_PUZZLES ? 'disabled' : ''}>＋ Novo enigma</button></div>
    <div class="stats-grid"><div class="stat-card"><span>ENIGMAS CRIADOS</span><strong>${String(puzzles.length).padStart(2, '0')}</strong><small>Limite local: ${MAX_PUZZLES}</small></div><div class="stat-card"><span>RESOLVIDOS</span><strong class="stat-green">${String(solved).padStart(2, '0')}</strong><small>${puzzles.length ? Math.round((solved / puzzles.length) * 100) : 0}% da sala</small></div><div class="stat-card"><span>RELÓGIOS AVANÇADOS</span><strong class="stat-amber">${String(clocks).padStart(2, '0')}</strong><small>Consequências registradas</small></div><div class="stat-card"><span>ALARMES DISPARADOS</span><strong class="stat-red">${String(alarms).padStart(2, '0')}</strong><small>Consequências registradas</small></div></div>
    <div class="master-section-heading"><div><span class="eyebrow">BIBLIOTECA DE DESAFIOS</span><h2>Seus enigmas</h2></div><span class="muted-small">As soluções não são compartilhadas com os jogadores.</span></div>
    ${puzzles.length ? `<div class="master-puzzle-grid">${puzzles.map((puzzle, index) => `<article class="master-puzzle-card"><div class="master-card-top"><span class="master-card-number">${String(index + 1).padStart(2, '0')}</span>${statusChip(puzzle.public)}</div><h3>${escapeHtml(puzzle.title)}</h3><p>${escapeHtml(TYPE_LABELS[puzzle.type] || puzzle.type)}</p><div class="master-card-meta"><span>⌁ ${puzzle.public.attemptsUsed} tentativa(s)</span><span>${puzzle.public.history.length} eventos</span></div><div class="master-card-actions"><button class="button button-quiet" data-action="edit-puzzle" data-id="${escapeHtml(puzzle.id)}">Editar</button><button class="icon-button" data-action="reset-puzzle" data-id="${escapeHtml(puzzle.id)}" title="Zerar progresso">↺</button><button class="icon-button danger" data-action="delete-puzzle" data-id="${escapeHtml(puzzle.id)}" title="Excluir enigma">×</button></div></article>`).join('')}</div>` : `<div class="empty-master"><div class="empty-orbit small">✧</div><h3>Nenhum enigma por enquanto</h3><p>Crie seu primeiro desafio ou carregue exemplos para explorar o sistema.</p><div class="empty-actions"><button class="button button-primary" data-action="new-puzzle">Criar primeiro enigma</button><button class="button button-quiet" data-action="seed-demo">Carregar exemplos</button></div></div>`}
    ${puzzles.length ? `<div class="master-footer-actions"><button class="button button-quiet" data-action="seed-demo" ${puzzles.length + 7 > MAX_PUZZLES ? 'disabled' : ''}>＋ Adicionar conjunto de exemplos</button><button class="button button-quiet" data-action="export-backup">Exportar backup privado ↓</button><label class="button button-quiet file-button">Importar backup ↑<input type="file" accept="application/json" data-action="import-backup" hidden /></label></div>` : ''}
    <div class="security-note"><span>◈</span><div><strong>Respostas protegidas por separação de dados</strong><p>As soluções e a configuração privada ficam no armazenamento local do navegador do mestre. A sala recebe somente as informações públicas dos desafios e os resultados das tentativas.</p></div></div>
  </section>`;
}

function renderEditor() {
  const draft = state.editorDraft || {};
  const type = draft.type || 'lock';
  const typeOptions = PUZZLE_TYPES.map((item) => `<option value="${item.id}" ${type === item.id ? 'selected' : ''}>${item.label}</option>`).join('');
  return `<section class="editor-layout"><div class="editor-top"><button class="back-link" data-action="cancel-editor">← Voltar ao estúdio</button><span class="eyebrow">${state.editorId ? 'EDITAR DESAFIO' : 'NOVO DESAFIO'}</span></div><div class="editor-title"><div><h1>${state.editorId ? 'Editar enigma' : 'Criar enigma'}</h1><p>Defina o que os jogadores verão e mantenha a solução somente com o mestre.</p></div><span class="editor-step">CONFIGURAÇÃO / 01</span></div><form class="editor-form" data-form="puzzle-editor">
    <div class="editor-columns"><div class="editor-main-column">
      <section class="editor-card"><div class="editor-card-heading"><span class="editor-icon">◇</span><div><h3>Identidade do desafio</h3><p>O conteúdo apresentado aos jogadores.</p></div></div>
        <label class="form-field"><span>Nome do enigma</span><input name="title" required maxlength="80" value="${escapeHtml(draft.title || '')}" placeholder="Ex.: Cofre da biblioteca" /></label>
        <label class="form-field"><span>Tipo de interação</span><select name="type" data-editor-type>${typeOptions}</select></label>
        <label class="form-field"><span>Descrição curta</span><textarea name="description" maxlength="300" rows="2" placeholder="Contextualize o desafio para o grupo…">${escapeHtml(draft.description || '')}</textarea></label>
        <label class="form-field"><span>Instruções / pistas visíveis</span><textarea name="instructions" maxlength="400" rows="3" placeholder="O que os jogadores sabem antes de tentar?">${escapeHtml(draft.instructions || '')}</textarea></label>
      </section>
      <section class="editor-card"><div class="editor-card-heading"><span class="editor-icon">⌘</span><div><h3>Configuração da interação</h3><p>Defina a solução correta. Este campo não será enviado aos jogadores.</p></div></div>${renderTypeFields(type, draft)}</section>
      <section class="editor-card"><div class="editor-card-heading"><span class="editor-icon">✧</span><div><h3>Recompensa ao resolver</h3><p>O conteúdo só aparece na sala depois da resposta correta.</p></div></div>
        <label class="form-field"><span>Título da recompensa</span><input name="rewardTitle" maxlength="60" value="${escapeHtml(draft.rewardTitle || '')}" placeholder="Ex.: Documento recuperado" /></label>
        <label class="form-field"><span>Conteúdo revelado</span><textarea name="rewardContent" maxlength="600" rows="3" placeholder="Texto, pista, instrução ou descrição do item…">${escapeHtml(draft.rewardContent || '')}</textarea></label>
        <label class="form-field"><span>Link de documento ou item (opcional)</span><input name="rewardUrl" type="url" value="${escapeHtml(draft.rewardUrl || '')}" maxlength="500" placeholder="https://…" /></label>
      </section>
    </div><aside class="editor-side-column">
      <section class="editor-card"><div class="editor-card-heading"><span class="editor-icon">⚑</span><div><h3>Regras de tentativa</h3><p>Controle a pressão e as consequências.</p></div></div>
        <label class="form-field"><span>Limite de tentativas</span><input name="attemptLimit" type="number" min="0" max="99" value="${escapeHtml(draft.attemptLimit ?? 3)}" /><small>Use 0 para tentativas ilimitadas.</small></label>
        <label class="form-field"><span>Ao errar, acontece…</span><select name="errorEffect">${ERROR_EFFECTS.map((effect) => `<option value="${effect.id}" ${(draft.errorEffect || 'none') === effect.id ? 'selected' : ''}>${effect.label}</option>`).join('')}</select></label>
        <div class="rule-explainer"><b>Como as consequências funcionam</b><p>Relógio e alarme são contadores compartilhados. Bloqueio imediato encerra novas tentativas até o mestre reiniciar o enigma.</p></div>
      </section>
      <div class="editor-save-card"><span class="save-shield">◈</span><strong>Pronto para a sala?</strong><p>A solução fica privada no dispositivo do mestre. Apenas o desafio e seu progresso são publicados.</p><button class="button button-primary button-wide" type="submit">${state.editorId ? 'Salvar alterações' : 'Criar enigma'} <span>→</span></button><button class="button button-quiet button-wide" type="button" data-action="cancel-editor">Cancelar</button></div>
    </aside></div>
  </form></section>`;
}

function renderTypeFields(type, draft) {
  const input = (name, label, value, placeholder = '', typeName = 'text') => `<label class="form-field"><span>${label}</span><input name="${name}" type="${typeName}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}" /></label>`;
  const textarea = (name, label, value, placeholder = '') => `<label class="form-field"><span>${label}</span><textarea name="${name}" rows="3" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value ?? '')}</textarea></label>`;
  if (type === 'lock') return `<div class="form-two-columns">${input('answer', 'Resposta correta', draft.answer, 'Ex.: 0482')}
    <label class="form-field"><span>Tipo de mecanismo</span><select name="lockMode"><option value="keypad" ${(draft.lockMode || 'keypad') === 'keypad' ? 'selected' : ''}>Teclado</option><option value="wheel" ${draft.lockMode === 'wheel' ? 'selected' : ''}>Discos giratórios</option></select></label></div><p class="field-help">O teclado aceita letras e números. Os discos exibem a quantidade de caracteres da resposta.</p>`;
  if (type === 'terminal') return `${input('terminalLabel', 'Identificação do terminal', draft.terminalLabel || 'TERMINAL // ACESSO RESTRITO')}${input('username', 'Usuário correto', draft.username, 'Ex.: admin')}${input('password', 'Senha correta', draft.password, 'Senha de acesso', 'text')}${textarea('acceptedCommands', 'Comandos aceitos (um por linha)', draft.acceptedCommands, 'help\nopen vault\noverride')}<p class="field-help">O terminal aceita o login correto ou qualquer um dos comandos cadastrados. Os comandos válidos não são exibidos automaticamente.</p>`;
  if (type === 'cipher') return `${textarea('cipherText', 'Texto cifrado', draft.cipherText, 'Ex.: FKR UD QXEV')}${input('answer', 'Texto original / resposta', draft.answer, 'A mensagem decifrada')}
    <div class="form-two-columns"><label class="form-field"><span>Tipo de cifra</span><select name="cipherMethod"><option value="caesar" ${(draft.cipherMethod || 'caesar') === 'caesar' ? 'selected' : ''}>César</option><option value="substitution" ${draft.cipherMethod === 'substitution' ? 'selected' : ''}>Substituição</option><option value="wheel" ${draft.cipherMethod === 'wheel' ? 'selected' : ''}>Roda de cifras</option></select></label>${input('shift', 'Deslocamento (César)', draft.shift ?? 3, '3', 'number')}</div><p class="field-help">O tipo e o deslocamento são mostrados como pistas. A validação compara a mensagem digitada com a resposta.</p>`;
  if (type === 'sequence') return `${input('availableSymbols', 'Símbolos disponíveis', draft.availableSymbols || DEFAULT_SYMBOLS.join(' '), '◆ ● ▲ ■ ✦')}${input('answerSequence', 'Sequência correta (separada por espaço)', draft.answerSequence, '◆ ▲ ● ■')}<p class="field-help">Os símbolos disponíveis aparecem como botões. A ordem correta permanece privada.</p>`;
  if (type === 'wires') {
    const colors = draft.wireColors || 'Vermelho, Azul, Amarelo, Verde';
    const labels = colors.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
    const correct = draft.correctWire || 'wire-0';
    return `${textarea('wireColors', 'Fios disponíveis (separados por vírgula)', colors, 'Vermelho, Azul, Amarelo, Verde')}<label class="form-field"><span>Fio correto</span><select name="correctWire">${labels.map((label, index) => `<option value="wire-${index}" ${correct === `wire-${index}` ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label><p class="field-help">O jogador vê todos os fios e escolhe um para cortar. A cor correta fica privada.</p>`;
  }
  if (type === 'document') return `${textarea('fragments', 'Fragmentos na ordem correta (um por linha)', draft.fragments, 'Primeiro trecho…\nSegundo trecho…\nTerceiro trecho…')}<p class="field-help">Os fragmentos são embaralhados na sala. Os jogadores precisam reorganizá-los antes de confirmar.</p>`;
  if (type === 'switches') return `${input('switchPattern', 'Combinação correta (0 = desligado, 1 = ligado)', draft.switchPattern || '10110', '10110')}<p class="field-help">Use de 2 a 10 posições. A combinação correta nunca é enviada ao painel público.</p>`;
  return '<p class="field-help">Selecione um tipo de interação.</p>';
}

function render() {
  if (!root) return;
  root.innerHTML = `${renderHeader()}${renderTabs()}<div class="app-content">${renderNotice()}${state.tab === 'master' && state.role === 'GM' ? renderMaster() : renderRoom()}</div><footer class="app-footer"><span> DYNAMIC PUZZLES <i>·</i> v0.1.0</span><span>${state.demoMode ? 'Demonstração local — nenhuma sala conectada' : 'Dados sincronizados pela sala do Owlbear Rodeo'}</span></footer>`;
}

function readForm(form) {
  return Object.fromEntries(new FormData(form).entries());
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
  };
  if (puzzle.type === 'lock') Object.assign(draft, { answer: puzzle.secret.code, lockMode: puzzle.public.config.mode });
  if (puzzle.type === 'terminal') Object.assign(draft, { username: puzzle.secret.username, password: puzzle.secret.password, acceptedCommands: (puzzle.secret.commands || []).join('\n'), terminalLabel: puzzle.public.config.terminalLabel });
  if (puzzle.type === 'cipher') Object.assign(draft, { answer: puzzle.secret.solution, cipherText: puzzle.public.config.cipherText, cipherMethod: puzzle.public.config.method, shift: puzzle.public.config.shift });
  if (puzzle.type === 'sequence') Object.assign(draft, { availableSymbols: puzzle.public.config.symbols.join(' '), answerSequence: puzzle.secret.sequence.join(' ') });
  if (puzzle.type === 'wires') Object.assign(draft, { wireColors: puzzle.public.config.wires.map((wire) => wire.label).join(', '), correctWire: puzzle.secret.correctWire });
  if (puzzle.type === 'document') {
    const fragments = new Map(puzzle.public.config.fragments.map((fragment) => [fragment.id, fragment.text]));
    Object.assign(draft, { fragments: puzzle.secret.order.map((id) => fragments.get(id) || '').join('\n') });
  }
  if (puzzle.type === 'switches') Object.assign(draft, { switchPattern: puzzle.secret.pattern.map((bit) => bit ? '1' : '0').join('') });
  return draft;
}

function validateEditor(values) {
  if (!values.title?.trim()) return 'Dê um nome ao enigma.';
  if (values.type === 'lock' && !values.answer?.trim()) return 'Informe a combinação correta do cadeado.';
  if (values.type === 'terminal' && !values.username?.trim() && !values.password?.trim() && !values.acceptedCommands?.trim()) return 'Configure um login ou pelo menos um comando aceito.';
  if (values.type === 'cipher' && (!values.answer?.trim() || !values.cipherText?.trim())) return 'Informe o texto cifrado e a resposta correta.';
  if (values.type === 'sequence' && (!values.answerSequence?.trim() || !values.availableSymbols?.trim())) return 'Configure os símbolos e a sequência correta.';
  if (values.type === 'wires' && !values.wireColors?.trim()) return 'Informe ao menos um fio.';
  if (values.type === 'document' && values.fragments?.split('\n').filter((part) => part.trim()).length < 2) return 'O documento precisa de pelo menos dois fragmentos.';
  if (values.type === 'switches' && values.switchPattern?.replace(/[^01]/g, '').length < 2) return 'O painel precisa de pelo menos dois interruptores.';
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
  if (action === 'dismiss-notice') { state.notice = ''; return render(); }
  if (action === 'select-puzzle') {
    state.selectedPuzzleId = id; state.sequence = []; state.selectedWireId = null; state.fragmentOrder = []; state.switches = []; state.cipherOffset = 0; state.notice = ''; return render();
  }
  if (action === 'new-puzzle') {
    state.editorId = null;
    state.editorDraft = { type: 'lock', attemptLimit: 3, errorEffect: 'none', lockMode: 'keypad' };
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
    saveAndPublish(); return setNotice('Enigma removido da sala.', 'success');
  }
  if (action === 'reset-puzzle') {
    const puzzle = getPrivatePuzzle(id);
    if (!puzzle) return;
    puzzle.public.attemptsUsed = 0;
    puzzle.public.consequenceCount = 0;
    puzzle.public.clockCount = 0;
    puzzle.public.alarmCount = 0;
    puzzle.public.solved = false;
    puzzle.public.locked = false;
    puzzle.public.history = [];
    puzzle.public.reveal = null;
    saveAndPublish(); return setNotice('Progresso do enigma reiniciado.', 'success');
  }
  if (action === 'seed-demo') {
    if (state.privatePuzzles.length + 7 > MAX_PUZZLES) return setNotice('Não há espaço para adicionar os sete exemplos. Exclua alguns enigmas primeiro.', 'warning');
    state.privatePuzzles = [...state.privatePuzzles, ...createDemoPuzzles()];
    saveAndPublish(); return setNotice('Sete exemplos adicionados à biblioteca.', 'success');
  }
  if (action === 'append-key') {
    const input = root.querySelector('[data-lock-input]');
    if (input && input.value.length < 32) input.value += button.dataset.key;
    return;
  }
  if (action === 'clear-lock') { const input = root.querySelector('[data-lock-input]'); if (input) input.value = ''; return; }
  if (action === 'sequence-add') { if (state.sequence.length < 16) state.sequence.push(button.dataset.symbol); return render(); }
  if (action === 'sequence-remove') { state.sequence.splice(Number(button.dataset.index), 1); return render(); }
  if (action === 'sequence-clear') { state.sequence = []; return render(); }
  if (action === 'submit-sequence') { const value = [...state.sequence]; state.sequence = []; return submitPayload({ value }); }
  if (action === 'select-wire') { state.selectedWireId = id; return render(); }
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
    state.switches[index] = !state.switches[index]; return render();
  }
  if (action === 'submit-switches') { const value = [...state.switches]; return submitPayload({ value }); }
  if (action === 'export-backup') return exportBackup();
}

function onChange(event) {
  if (event.target.matches('[data-cipher-offset]')) {
    state.cipherOffset = Number(event.target.value) || 0;
    return render();
  }
  if (event.target.matches('[data-editor-type]')) {
    const form = event.target.closest('form');
    const values = readForm(form);
    state.editorDraft = { ...state.editorDraft, ...values, type: event.target.value };
    return render();
  }
  if (event.target.matches('[data-action="import-backup"]')) return importBackup(event.target.files?.[0]);
}

function exportBackup() {
  const data = {
    app: 'Dynamic Puzzles',
    version: '0.1.0',
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
root.addEventListener('dragstart', (event) => {
  const row = event.target.closest('[data-fragment-row]');
  if (!row) return;
  state.draggedFragmentId = row.dataset.fragmentId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', state.draggedFragmentId);
});
root.addEventListener('dragover', (event) => {
  if (event.target.closest('[data-fragment-row]')) event.preventDefault();
});
root.addEventListener('drop', (event) => {
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
