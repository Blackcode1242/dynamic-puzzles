export const PUZZLE_TYPES = [
  { id: 'lock', label: 'Cadeado', description: 'Código numérico ou alfabético' },
  { id: 'terminal', label: 'Terminal', description: 'Usuário, senha e comandos' },
  { id: 'cipher', label: 'Cifra', description: 'Texto cifrado e decodificação' },
  { id: 'sequence', label: 'Sequência de símbolos', description: 'Descubra a ordem correta' },
  { id: 'wires', label: 'Fios coloridos', description: 'Escolha o fio correto' },
  { id: 'document', label: 'Documento rasgado', description: 'Reconstrua os fragmentos' },
  { id: 'switches', label: 'Painel de interruptores', description: 'Acerte a combinação de chaves' },
];

export const ERROR_EFFECTS = [
  { id: 'none', label: 'Sem consequência' },
  { id: 'clock', label: 'Avançar relógio' },
  { id: 'alarm', label: 'Disparar alarme' },
  { id: 'lockdown', label: 'Bloquear imediatamente' },
];

export const DEFAULT_SYMBOLS = ['◆', '●', '▲', '■', '✦', '☾'];
export const DEFAULT_WIRES = [
  { id: 'red', label: 'Vermelho', color: '#f87171' },
  { id: 'blue', label: 'Azul', color: '#60a5fa' },
  { id: 'yellow', label: 'Amarelo', color: '#facc15' },
  { id: 'green', label: 'Verde', color: '#4ade80' },
];

export function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pt-BR');
}

export function makePuzzle(values, previous = null) {
  const id = previous?.id || crypto.randomUUID();
  const title = String(values.title || '').trim() || 'Enigma sem título';
  const description = String(values.description || '').trim();
  const instructions = String(values.instructions || '').trim();
  const attemptLimit = Math.max(0, Math.min(99, Number(values.attemptLimit) || 0));
  const errorEffect = ERROR_EFFECTS.some((effect) => effect.id === values.errorEffect)
    ? values.errorEffect
    : 'none';
  const reward = {
    title: String(values.rewardTitle || '').trim(),
    content: String(values.rewardContent || '').trim(),
    url: String(values.rewardUrl || '').trim().slice(0, 500),
  };
  const oldPublic = previous?.public || {};
  const oldSecret = previous?.secret || {};
  const type = values.type || previous?.type || 'lock';
  let secret = {};
  let config = {};

  if (type === 'lock') {
    const code = String(values.answer || '').trim();
    secret = { code };
    config = { mode: values.lockMode === 'wheel' ? 'wheel' : 'keypad', wheelLength: Math.max(1, code.length || 4) };
  } else if (type === 'terminal') {
    const commands = String(values.acceptedCommands || '')
      .split(/[\n,;]/)
      .map((item) => item.trim())
      .filter(Boolean);
    secret = {
      username: String(values.username || '').trim(),
      password: String(values.password || '').trim(),
      commands,
    };
    config = { terminalLabel: String(values.terminalLabel || 'TERMINAL // ACESSO RESTRITO').trim() };
  } else if (type === 'cipher') {
    secret = { solution: String(values.answer || '').trim() };
    config = {
      cipherText: String(values.cipherText || '').trim(),
      method: ['caesar', 'substitution', 'wheel'].includes(values.cipherMethod) ? values.cipherMethod : 'caesar',
      shift: Math.max(-25, Math.min(25, Number(values.shift) || 0)),
    };
  } else if (type === 'sequence') {
    const symbols = String(values.availableSymbols || DEFAULT_SYMBOLS.join(' '))
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 16);
    const sequence = String(values.answerSequence || '')
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    secret = { sequence };
    config = { symbols: symbols.length ? symbols : DEFAULT_SYMBOLS };
  } else if (type === 'wires') {
    const wires = String(values.wireColors || 'Vermelho, Azul, Amarelo, Verde')
      .split(/[\n,;]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((label, index) => ({ id: `wire-${index}`, label, color: colorForWire(label, index) }));
    const requestedWire = String(values.correctWire || wires[0]?.id || 'wire-0');
    secret = { correctWire: wires.some((wire) => wire.id === requestedWire) ? requestedWire : (wires[0]?.id || 'wire-0') };
    config = { wires: wires.length ? wires : DEFAULT_WIRES };
  } else if (type === 'document') {
    const lines = String(values.fragments || '')
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
    const fragments = lines.map((text, index) => ({ id: `fragment-${index}`, text }));
    const shuffled = [...fragments];
    // Public fragment order is always scrambled, including after a master edit.
    shuffle(shuffled);
    secret = { order: fragments.map((fragment) => fragment.id) };
    config = { fragments: shuffled };
  } else if (type === 'switches') {
    const pattern = String(values.switchPattern || '10110')
      .replace(/[^01]/g, '')
      .slice(0, 10)
      .split('')
      .map((bit) => bit === '1');
    secret = { pattern };
    config = { switchCount: Math.max(2, pattern.length || 5) };
  } else {
    throw new Error(`Tipo de enigma não reconhecido: ${type}`);
  }

  const publicPuzzle = {
    id,
    title,
    type,
    description,
    instructions,
    config,
    attemptLimit,
    errorEffect,
    attemptsUsed: oldPublic.attemptsUsed || 0,
    consequenceCount: oldPublic.consequenceCount || 0,
    clockCount: oldPublic.clockCount || 0,
    alarmCount: oldPublic.alarmCount || 0,
    solved: oldPublic.solved || false,
    locked: oldPublic.locked || false,
    history: oldPublic.history || [],
    reveal: oldPublic.reveal || null,
    updatedAt: Date.now(),
  };

  // Editing a solved/used puzzle keeps its public progress. Creating a new puzzle starts clean.
  if (!previous) {
    publicPuzzle.attemptsUsed = 0;
    publicPuzzle.consequenceCount = 0;
    publicPuzzle.clockCount = 0;
    publicPuzzle.alarmCount = 0;
    publicPuzzle.solved = false;
    publicPuzzle.locked = false;
    publicPuzzle.history = [];
    publicPuzzle.reveal = null;
  }

  return { id, type, title, secret: Object.keys(secret).length ? secret : oldSecret, reward, public: publicPuzzle };
}

function colorForWire(label, index) {
  const key = normalize(label);
  if (key.includes('vermelh') || key.includes('red')) return '#f87171';
  if (key.includes('azul') || key.includes('blue')) return '#60a5fa';
  if (key.includes('amarel') || key.includes('yellow')) return '#facc15';
  if (key.includes('verd') || key.includes('green')) return '#4ade80';
  if (key.includes('roxo') || key.includes('purple')) return '#c084fc';
  if (key.includes('laranj') || key.includes('orange')) return '#fb923c';
  return ['#f87171', '#60a5fa', '#facc15', '#4ade80', '#c084fc', '#fb923c', '#f472b6', '#94a3b8'][index % 8];
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  // A document should not accidentally look solved just because the shuffle matched the answer.
  if (items.length > 1 && items.every((item, index) => item.id === `fragment-${index}`)) {
    [items[0], items[1]] = [items[1], items[0]];
  }
}

export function validateAttempt(puzzle, payload) {
  if (!puzzle || !payload || puzzle.public.solved || puzzle.public.locked) return false;
  const secret = puzzle.secret || {};

  switch (puzzle.type) {
    case 'lock':
      return normalizeCode(payload.value) === normalizeCode(secret.code);
    case 'terminal': {
      const credentialsMatch = normalize(payload.username) === normalize(secret.username)
        && normalize(payload.password) === normalize(secret.password)
        && Boolean(secret.username || secret.password);
      const commandMatch = (secret.commands || []).some((command) => normalize(command) === normalize(payload.command));
      return credentialsMatch || commandMatch;
    }
    case 'cipher':
      return normalize(payload.value) === normalize(secret.solution);
    case 'sequence':
      return sameArray(payload.value, secret.sequence, normalize);
    case 'wires':
      return String(payload.value) === String(secret.correctWire);
    case 'document':
      return sameArray(payload.order, secret.order, String);
    case 'switches':
      return sameArray(payload.value, secret.pattern, Boolean);
    default:
      return false;
  }
}

function normalizeCode(value) {
  return normalize(value).replace(/[\s-]/g, '');
}

function sameArray(actual, expected, transform = (value) => value) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  return actual.every((value, index) => transform(value) === transform(expected[index]));
}

export function attemptLabel(puzzle, payload) {
  if (!payload) return 'Tentativa enviada';
  switch (puzzle.type) {
    case 'terminal':
      return payload.command ? `Comando: ${payload.command}` : `Login: ${payload.username || '—'}`;
    case 'sequence':
      return (payload.value || []).join(' → ');
    case 'wires':
      return puzzle.public.config.wires.find((wire) => wire.id === payload.value)?.label || 'Fio selecionado';
    case 'document':
      return `Documento remontado (${(payload.order || []).length} partes)`;
    case 'switches':
      return `Painel: ${(payload.value || []).map((bit) => bit ? '1' : '0').join('')}`;
    default:
      return String(payload.value || '').slice(0, 100) || 'Tentativa enviada';
  }
}

export function toPublicState(privatePuzzles, updatedAt = Date.now()) {
  return {
    schema: 1,
    updatedAt,
    puzzles: privatePuzzles.map((puzzle) => ({
      ...puzzle.public,
      // The reward is intentionally absent until the master validates a correct attempt.
      reveal: puzzle.public.solved ? puzzle.reward : null,
    })),
  };
}

export function createDemoPuzzles() {
  const examples = [
    makePuzzle({
      type: 'lock', title: 'Cofre do Arquivista', description: 'Um pequeno cadeado protege os registros da expedição.',
      instructions: 'O bilhete diz: “o ano em que a expedição desapareceu”.', answer: '1847', lockMode: 'keypad',
      attemptLimit: '4', errorEffect: 'clock', rewardTitle: 'Diário encontrado', rewardContent: 'Entre as páginas, há um mapa marcado com tinta azul.'
    }),
    makePuzzle({
      type: 'terminal', title: 'Terminal da Estação', description: 'Um terminal antigo aguarda autenticação.',
      instructions: 'Experimente as credenciais ou descubra o comando administrativo.', username: 'admin', password: 'nebula',
      acceptedCommands: 'override\nopen vault', terminalLabel: 'ESTAÇÃO // NÓ CENTRAL', attemptLimit: '5', errorEffect: 'alarm',
      rewardTitle: 'Porta destravada', rewardContent: 'O mecanismo da porta emite um estalo pesado.'
    }),
    makePuzzle({
      type: 'cipher', title: 'Mensagem interceptada', description: 'Uma mensagem foi cifrada antes de chegar ao grupo.',
      instructions: 'A cifra é de César. O deslocamento está indicado no rodapé: +3.', cipherText: 'FKDYH HVWD QR DUPDULR',
      cipherMethod: 'caesar', shift: '3', answer: 'CHAVE ESTA NO ARMARIO', attemptLimit: '3', errorEffect: 'none',
      rewardTitle: 'Pista decifrada', rewardContent: 'A chave está no armário atrás da tapeçaria.'
    }),
    makePuzzle({
      type: 'sequence', title: 'Ritual dos quatro selos', description: 'Os símbolos devem ser pressionados na ordem correta.',
      instructions: 'A inscrição diz: “noite, chama, pedra, céu”.', availableSymbols: '☾ ◆ ■ ✦ ● ▲', answerSequence: '☾ ◆ ■ ✦',
      attemptLimit: '3', errorEffect: 'clock', rewardTitle: 'Selo desfeito', rewardContent: 'A barreira mágica desaparece.'
    }),
    makePuzzle({
      type: 'wires', title: 'Reator instável', description: 'Um dos cabos mantém o reator em funcionamento.',
      instructions: 'A etiqueta diz: “corte o fio que não conduz energia”.', wireColors: 'Vermelho, Azul, Amarelo, Verde', correctWire: 'wire-3',
      attemptLimit: '2', errorEffect: 'alarm', rewardTitle: 'Reator estabilizado', rewardContent: 'A luz de emergência muda de vermelho para azul.'
    }),
    makePuzzle({
      type: 'document', title: 'Bilhete rasgado', description: 'Quatro pedaços de um bilhete foram espalhados.',
      instructions: 'Organize as partes para revelar a mensagem completa.',
      fragments: 'Abaixo da terceira pedra\nexiste uma pequena alavanca.\nPuxe-a somente depois\nde apagar as duas tochas.',
      attemptLimit: '0', errorEffect: 'none', rewardTitle: 'Bilhete restaurado', rewardContent: 'O bilhete indica uma passagem secreta sob o altar.'
    }),
    makePuzzle({
      type: 'switches', title: 'Painel de contenção', description: 'A sequência de interruptores precisa corresponder ao padrão.',
      instructions: 'Procure as marcas quase apagadas na lateral do painel.', switchPattern: '10110',
      attemptLimit: '3', errorEffect: 'lockdown', rewardTitle: 'Contenção liberada', rewardContent: 'A trava magnética se abre com um ruído grave.'
    }),
  ];
  return examples;
}
