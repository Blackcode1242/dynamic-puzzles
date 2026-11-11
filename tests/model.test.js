import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makePuzzle,
  validateAttempt,
  toPublicState,
  normalize,
  evaluateAttempt,
  attemptLabel,
  recalculateSequenceLocks,
  PUZZLE_TEMPLATES,
  getPuzzleTemplate,
  createDemoPuzzles,
  PARTICIPATION_MODES,
  normalizeParticipationMode,
  canPlayerInteract,
} from '../src/model.js';

function makeFrequency(overrides = {}) {
  return makePuzzle({
    type: 'frequency',
    title: 'Teste de frequência',
    frequencyMin: '88',
    frequencyMax: '108',
    frequencyStep: '0.1',
    frequencyTarget: '101.7',
    frequencyTolerance: '0.5',
    frequencyChannels: 'AM, FM, Emergência',
    frequencyTargetChannel: 'FM',
    frequencyUseAmplitude: 'no',
    frequencyAmplitudeMin: '0',
    frequencyAmplitudeMax: '100',
    frequencyAmplitudeStep: '1',
    frequencyAmplitudeTarget: '65',
    frequencyAmplitudeTolerance: '5',
    frequencyInterference: 'none',
    ...overrides,
  });
}

test('normaliza acentos, caixa e espaços para respostas textuais', () => {
  assert.equal(normalize('  AÇÃO   SECRETA  '), 'acao secreta');
});

test('cadeado valida código sem espaços ou hífens', () => {
  const puzzle = makePuzzle({ type: 'lock', answer: 'A-19 B', title: 'Cadeado' });
  assert.equal(validateAttempt(puzzle, { value: 'a19b' }), true);
  assert.equal(validateAttempt(puzzle, { value: 'a19c' }), false);
});

test('terminal aceita credenciais ou comando configurado', () => {
  const puzzle = makePuzzle({ type: 'terminal', username: 'admin', password: 'Nebula', acceptedCommands: 'override\nopen vault' });
  assert.equal(validateAttempt(puzzle, { username: 'ADMIN', password: 'nebula' }), true);
  assert.equal(validateAttempt(puzzle, { command: 'OPEN VAULT' }), true);
  assert.equal(validateAttempt(puzzle, { username: 'admin', password: 'wrong', command: '' }), false);
});

test('cifra valida a mensagem decifrada', () => {
  const puzzle = makePuzzle({ type: 'cipher', answer: 'A chave está aqui' });
  assert.equal(validateAttempt(puzzle, { value: 'a CHAVE ESTA AQUI' }), true);
});

test('sequência exige a ordem exata dos símbolos', () => {
  const puzzle = makePuzzle({ type: 'sequence', availableSymbols: '◆ ● ▲ ■', answerSequence: '◆ ▲ ●' });
  assert.equal(validateAttempt(puzzle, { value: ['◆', '▲', '●'] }), true);
  assert.equal(validateAttempt(puzzle, { value: ['●', '▲', '◆'] }), false);
});

test('fios valida o identificador do fio correto', () => {
  const puzzle = makePuzzle({ type: 'wires', wireColors: 'Vermelho, Azul, Verde', correctWire: 'wire-2' });
  assert.equal(validateAttempt(puzzle, { value: 'wire-2' }), true);
  assert.equal(validateAttempt(puzzle, { value: 'wire-0' }), false);
});

test('documento valida a ordem privada, sem publicá-la', () => {
  const puzzle = makePuzzle({ type: 'document', fragments: 'Parte um\nParte dois\nParte três' });
  assert.equal(validateAttempt(puzzle, { order: puzzle.secret.order }), true);
  const publicPuzzle = toPublicState([puzzle]).puzzles[0];
  assert.equal('secret' in publicPuzzle, false);
  assert.notDeepEqual(publicPuzzle.config.fragments.map((fragment) => fragment.id), puzzle.secret.order);
});

test('painel valida cada posição do padrão de interruptores', () => {
  const puzzle = makePuzzle({ type: 'switches', switchPattern: '10110' });
  assert.equal(validateAttempt(puzzle, { value: [true, false, true, true, false] }), true);
  assert.equal(validateAttempt(puzzle, { value: [true, true, true, true, false] }), false);
});

test('estado público não contém recompensa antes da solução nem objeto secreto', () => {
  const puzzle = makePuzzle({ type: 'lock', answer: '7391', rewardTitle: 'Mapa', rewardContent: 'Norte' });
  const publicState = toPublicState([puzzle]);
  const serialized = JSON.stringify(publicState);
  assert.equal(serialized.includes('7391'), false);
  assert.equal(serialized.includes('Norte'), false);
  assert.equal('secret' in publicState.puzzles[0], false);
});

test('link da recompensa permanece privado até a resolução', () => {
  const puzzle = makePuzzle({ type: 'lock', answer: '1234', rewardTitle: 'Mapa', rewardUrl: 'https://example.com/mapa' });
  assert.equal(toPublicState([puzzle]).puzzles[0].reveal, null);
  puzzle.public.solved = true;
  assert.equal(toPublicState([puzzle]).puzzles[0].reveal.url, 'https://example.com/mapa');
});

test('cadeado por dados aceita quantidade e faces configuráveis e indica o alvo acima/abaixo', () => {
  const puzzle = makePuzzle({
    type: 'lock', lockMode: 'deduction', diceCount: '5', diceSides: '12',
    diceAnswer: '6, 2, 11, 4, 1', feedbackMode: 'individual',
  });
  assert.equal(puzzle.public.config.diceCount, 5);
  assert.equal(puzzle.public.config.diceSides, 12);
  const result = evaluateAttempt(puzzle, { guess: [5, 4, 11, 2, 12] });
  assert.deepEqual(result.feedback.marks, ['high', 'low', 'exact', 'high', 'low']);
  assert.equal(result.solved, false);
  assert.equal(validateAttempt(puzzle, { guess: [6, 2, 11, 4, 1] }), true);
});

test('cadeado por dados no modo agrupado não revela posições', () => {
  const puzzle = makePuzzle({
    type: 'lock', lockMode: 'deduction', diceCount: '4', diceSides: '8',
    diceAnswer: '6, 2, 7, 3', feedbackMode: 'grouped',
  });
  const result = evaluateAttempt(puzzle, { guess: [5, 4, 7, 8] });
  assert.deepEqual(result.feedback, { mode: 'grouped', counts: { high: 1, low: 2, exact: 1 } });
  assert.equal('marks' in result.feedback, false);
});

test('cadeado por dados rejeita valores fora das faces configuradas', () => {
  const puzzle = makePuzzle({ type: 'lock', lockMode: 'deduction', diceCount: '2', diceSides: '4', diceAnswer: '1, 4' });
  const result = evaluateAttempt(puzzle, { guess: [1, 8] });
  assert.equal(result.solved, false);
  assert.match(result.feedback.text, /entre 1 e 4/);
});

test('Hack Social sequencial avança apenas com resposta correta e aceita variações', () => {
  const puzzle = makePuzzle({
    type: 'social', socialMode: 'sequential', requiredAnswers: '2',
    socialQuestions: 'Nome do cão? | Thor | Thorinho;Trovão\nCidade natal? | São Paulo | SP;Sao Paulo',
  });
  const first = evaluateAttempt(puzzle, { questionIndex: 0, answer: 'trovão' });
  assert.equal(first.correct, true);
  assert.equal(first.solved, false);
  assert.equal(first.progressUpdate.questionIndex, 1);
  puzzle.public.questionIndex = 1;
  const second = evaluateAttempt(puzzle, { questionIndex: 1, answer: 'SAO PAULO' });
  assert.equal(second.correct, true);
  assert.equal(second.solved, true);
});

test('Hack Social investigativo permite responder perguntas fora de ordem', () => {
  const puzzle = makePuzzle({
    type: 'social', socialMode: 'investigative', requiredAnswers: '2',
    socialQuestions: 'Nome da irmã? | Marina\nAnimal de estimação? | Thor\nCidade natal? | Santos',
  });
  const first = evaluateAttempt(puzzle, { questionIndex: 2, answer: 'Santos' });
  assert.equal(first.correct, true);
  assert.deepEqual(first.progressUpdate.solvedQuestionIds, ['social-q2']);
  puzzle.public.solvedQuestionIds = first.progressUpdate.solvedQuestionIds;
  const second = evaluateAttempt(puzzle, { questionIndex: 0, answer: 'Marina' });
  assert.equal(second.solved, true);
  assert.deepEqual(second.progressUpdate.solvedQuestionIds, ['social-q2', 'social-q0']);
});

test('Hack Social publica perguntas e progresso, mas nunca respostas aceitas', () => {
  const puzzle = makePuzzle({
    type: 'social', socialMode: 'investigative', requiredAnswers: '1',
    socialQuestions: 'Nome secreto? | Maria Clara | Mari;M. Clara',
  });
  const serialized = JSON.stringify(toPublicState([puzzle]));
  assert.match(serialized, /Nome secreto\?/);
  assert.doesNotMatch(serialized, /Maria Clara|M\. Clara|Mari/);
});

test('combinação do cadeado por dados nunca entra no estado público', () => {
  const puzzle = makePuzzle({
    type: 'lock', lockMode: 'deduction', diceCount: '3', diceSides: '10',
    diceAnswer: '9, 4, 7', feedbackMode: 'individual',
  });
  const serialized = JSON.stringify(toPublicState([puzzle]));
  assert.doesNotMatch(serialized, /9,4,7/);
  assert.equal('combination' in toPublicState([puzzle]).puzzles[0].config, false);
});

// TESTES DA SINTONIA DE FREQUÊNCIA

test('Sintonia de Frequência cria configurações públicas e resposta secreta separada', () => {
  const puzzle = makeFrequency();

  assert.equal(puzzle.type, 'frequency');
  assert.equal(puzzle.public.config.frequencyMin, 88);
  assert.equal(puzzle.public.config.frequencyMax, 108);
  assert.equal(puzzle.public.config.frequencyStep, 0.1);
  assert.equal(puzzle.public.config.channels.length, 3);
  assert.equal(puzzle.public.config.useAmplitude, false);

  assert.equal(puzzle.secret.targetFrequency, 101.7);
  assert.equal(puzzle.secret.frequencyTolerance, 0.5);
  assert.equal(puzzle.secret.targetChannelId, 'channel-1');
});

test('Sintonia de Frequência aceita a frequência secreta no canal correto', () => {
  const puzzle = makeFrequency();

  const result = evaluateAttempt(puzzle, {
    frequency: 101.7,
    channelId: 'channel-1',
  });

  assert.equal(result.correct, true);
  assert.equal(result.solved, true);
  assert.equal(result.feedback.signalLevel, 4);
  assert.match(result.feedback.text, /Sinal estabilizado/);
  assert.equal(validateAttempt(puzzle, {
    frequency: 101.7,
    channelId: 'channel-1',
  }), true);
});

test('Sintonia de Frequência aceita valores dentro da tolerância configurada', () => {
  const puzzle = makeFrequency({
    frequencyTarget: '100',
    frequencyTolerance: '0.5',
  });

  const result = evaluateAttempt(puzzle, {
    frequency: 99.5,
    channelId: 'channel-1',
  });

  assert.equal(result.solved, true);
});

test('Sintonia de Frequência rejeita valores fora da tolerância', () => {
  const puzzle = makeFrequency({
    frequencyTarget: '100',
    frequencyTolerance: '0.5',
  });

  const result = evaluateAttempt(puzzle, {
    frequency: 99.4,
    channelId: 'channel-1',
  });

  assert.equal(result.correct, false);
  assert.equal(result.solved, false);
});

test('Sintonia de Frequência rejeita o canal incorreto', () => {
  const puzzle = makeFrequency();

  const result = evaluateAttempt(puzzle, {
    frequency: 101.7,
    channelId: 'channel-0',
  });

  assert.equal(result.correct, false);
  assert.equal(result.solved, false);
  assert.equal(result.feedback.signalLevel, 0);
  assert.match(result.feedback.text, /canal selecionado/i);
});

test('Sintonia de Frequência rejeita valores fora da faixa do receptor', () => {
  const puzzle = makeFrequency();

  const result = evaluateAttempt(puzzle, {
    frequency: 120,
    channelId: 'channel-1',
  });

  assert.equal(result.solved, false);
  assert.match(result.feedback.text, /fora da faixa/i);
});

test('Sintonia de Frequência rejeita canais inexistentes', () => {
  const puzzle = makeFrequency();

  const result = evaluateAttempt(puzzle, {
    frequency: 101.7,
    channelId: 'channel-inexistente',
  });

  assert.equal(result.solved, false);
  assert.match(result.feedback.text, /canal disponível/i);
});

test('Sintonia de Frequência exige amplitude quando essa opção está habilitada', () => {
  const puzzle = makeFrequency({
    frequencyTarget: '100',
    frequencyTolerance: '0.5',
    frequencyUseAmplitude: 'yes',
    frequencyAmplitudeTarget: '65',
    frequencyAmplitudeTolerance: '5',
  });

  const result = evaluateAttempt(puzzle, {
    frequency: 100,
    channelId: 'channel-1',
  });

  assert.equal(result.solved, false);
  assert.match(result.feedback.text, /amplitude/i);
});

test('Sintonia de Frequência valida a amplitude dentro da tolerância', () => {
  const puzzle = makeFrequency({
    frequencyTarget: '100',
    frequencyTolerance: '0.5',
    frequencyUseAmplitude: 'yes',
    frequencyAmplitudeTarget: '65',
    frequencyAmplitudeTolerance: '5',
  });

  const result = evaluateAttempt(puzzle, {
    frequency: 100,
    channelId: 'channel-1',
    amplitude: 70,
  });

  assert.equal(result.solved, true);
});

test('Sintonia de Frequência rejeita amplitude fora da tolerância', () => {
  const puzzle = makeFrequency({
    frequencyTarget: '100',
    frequencyTolerance: '0.5',
    frequencyUseAmplitude: 'yes',
    frequencyAmplitudeTarget: '65',
    frequencyAmplitudeTolerance: '5',
  });

  const result = evaluateAttempt(puzzle, {
    frequency: 100,
    channelId: 'channel-1',
    amplitude: 71,
  });

  assert.equal(result.solved, false);
});

test('Sintonia de Frequência reduz a precisão do indicador com interferência', () => {
  const base = {
    frequencyTarget: '100',
    frequencyTolerance: '0',
  };

  const clean = makeFrequency({
    ...base,
    frequencyInterference: 'none',
  });

  const low = makeFrequency({
    ...base,
    frequencyInterference: 'low',
  });

  const high = makeFrequency({
    ...base,
    frequencyInterference: 'high',
  });

  const attempt = {
    frequency: 96.5,
    channelId: 'channel-1',
  };

  const cleanLevel = evaluateAttempt(clean, attempt).feedback.signalLevel;
  const lowLevel = evaluateAttempt(low, attempt).feedback.signalLevel;
  const highLevel = evaluateAttempt(high, attempt).feedback.signalLevel;

  assert.equal(cleanLevel, 2);
  assert.equal(lowLevel, 2);
  assert.equal(highLevel, 0);
});

test('Sintonia de Frequência não publica a solução secreta nem suas tolerâncias', () => {
  const puzzle = makeFrequency({
    frequencyTarget: '99.3',
    frequencyTolerance: '0.2',
    frequencyUseAmplitude: 'yes',
    frequencyAmplitudeTarget: '63.21',
    frequencyAmplitudeTolerance: '1.5',
  });

  const publicState = toPublicState([puzzle]);
  const publicPuzzle = publicState.puzzles[0];
  const serialized = JSON.stringify(publicState);

  assert.equal('secret' in publicPuzzle, false);
  assert.equal('targetFrequency' in publicPuzzle.config, false);
  assert.equal('frequencyTolerance' in publicPuzzle.config, false);
  assert.equal('targetChannelId' in publicPuzzle.config, false);
  assert.equal('targetAmplitude' in publicPuzzle.config, false);
  assert.equal('amplitudeTolerance' in publicPuzzle.config, false);

  assert.doesNotMatch(serialized, /99\.3|63\.21/);
});

test('Sintonia de Frequência produz um rótulo compreensível no histórico', () => {
  const puzzle = makeFrequency();

  const label = attemptLabel(puzzle, {
    frequency: 101.2,
    channelId: 'channel-1',
  });

  assert.match(label, /101\.2/);
  assert.match(label, /FM/);
});

function awaitAttemptLabel(puzzle, payload) {
  // Importação estática testada através da exportação do model.
  return attemptLabelForTest(puzzle, payload);
}

function attemptLabelForTest(puzzle, payload) {
  return puzzle.type === 'frequency'
    ? `Frequência: ${Number(payload.frequency)} MHz · Canal: ${puzzle.public.config.channels.find((channel) => channel.id === payload.channelId)?.label || '—'}`
    : '';
}

// TESTES EXISTENTES DE BIBLIOTECA E PROGRESSÃO

test('biblioteca possui um modelo demonstrativo para cada tipo de enigma e variações de cadeado', () => {
  const types = new Set(PUZZLE_TEMPLATES.map((template) => template.type));

  for (const type of ['lock', 'terminal', 'cipher', 'frequency', 'sequence', 'wires', 'document', 'switches', 'social']) {
    assert.equal(types.has(type), true, `faltou modelo para ${type}`);
  }

  assert.equal(PUZZLE_TEMPLATES.length, 11);

  const wheelTemplate = getPuzzleTemplate('lock-wheel');
  assert.equal(wheelTemplate.lockMode, 'wheel');
  assert.equal(wheelTemplate.answer, '5821');

  const diceTemplate = getPuzzleTemplate('lock-dice');
  assert.equal(diceTemplate.lockMode, 'deduction');
  assert.equal(diceTemplate.diceCount, 5);
  assert.equal(diceTemplate.diceSides, 8);

  const frequencyTemplate = getPuzzleTemplate('frequency');
  assert.equal(frequencyTemplate.type, 'frequency');
  assert.equal(frequencyTemplate.frequencyTarget, '101.7');
  assert.equal(frequencyTemplate.frequencyTargetChannel, 'FM');

  frequencyTemplate.title = 'Alteração local';
  assert.notEqual(getPuzzleTemplate('frequency').title, 'Alteração local');

  diceTemplate.title = 'Alteração local';
  assert.notEqual(getPuzzleTemplate('lock-dice').title, 'Alteração local');
});

test('conjunto de demonstração inclui um exemplo de Sintonia de Frequência', () => {
  const examples = createDemoPuzzles();

  assert.equal(examples.some((puzzle) => puzzle.type === 'frequency'), true);
});

test('dicas secretas só são publicadas depois que o mestre as libera', () => {
  const puzzle = makePuzzle({
    type: 'lock', answer: '1847', hints: 'Observe a data.\nConfira o diário.\nA senha é 1847.',
  });

  let publicData = JSON.stringify(toPublicState([puzzle]));

  assert.doesNotMatch(publicData, /Observe a data|Confira o diário|A senha é 1847/);
  assert.equal(toPublicState([puzzle]).puzzles[0].hintCount, 3);

  puzzle.public.revealedHints = [{ index: 1, text: puzzle.hints[0], at: 123 }];
  publicData = JSON.stringify(toPublicState([puzzle]));

  assert.match(publicData, /Observe a data/);
  assert.doesNotMatch(publicData, /Confira o diário|A senha é 1847/);
});

test('sequência de enigmas libera uma etapa somente quando a anterior é resolvida', () => {
  const first = makePuzzle({ type: 'lock', title: 'Etapa 1', answer: '1111', sequenceName: 'Laboratório', sequenceOrder: 1 });
  const second = makePuzzle({ type: 'lock', title: 'Etapa 2', answer: '2222', sequenceName: 'laboratorio', sequenceOrder: 2 });
  const third = makePuzzle({ type: 'lock', title: 'Etapa 3', answer: '3333', sequenceName: 'Laboratório', sequenceOrder: 3 });
  const group = [first, second, third];

  recalculateSequenceLocks(group);

  assert.equal(first.public.sequenceLocked, false);
  assert.equal(second.public.sequenceLocked, true);
  assert.equal(third.public.sequenceLocked, true);
  assert.equal(evaluateAttempt(second, { value: '2222' }).solved, false);

  first.public.solved = true;
  recalculateSequenceLocks(group);

  assert.equal(second.public.sequenceLocked, false);
  assert.equal(third.public.sequenceLocked, true);

  second.public.solved = true;
  recalculateSequenceLocks(group);

  assert.equal(third.public.sequenceLocked, false);
});

test('metadados públicos da sequência não contêm soluções privadas', () => {
  const first = makePuzzle({ type: 'lock', title: 'Etapa 1', answer: 'senha-secreta', sequenceName: 'Arquivo', sequenceOrder: 1, hints: 'Dica reservada.' });
  const second = makePuzzle({ type: 'social', title: 'Etapa 2', socialQuestions: 'Nome? | Helena | Lena', requiredAnswers: 1, sequenceName: 'Arquivo', sequenceOrder: 2 });

  recalculateSequenceLocks([first, second]);

  const publicData = JSON.stringify(toPublicState([first, second]));

  assert.doesNotMatch(publicData, /senha-secreta|Dica reservada|Helena|Lena/);
  assert.match(publicData, /Arquivo/);
  assert.equal(toPublicState([first, second]).puzzles[1].sequenceLocked, true);
});

test('uma sequência com lacuna ou sem etapa 1 permanece bloqueada', () => {
  const second = makePuzzle({ type: 'lock', title: 'Etapa 2', answer: '2222', sequenceName: 'Cofre', sequenceOrder: 2 });
  const fourth = makePuzzle({ type: 'lock', title: 'Etapa 4', answer: '4444', sequenceName: 'Cofre', sequenceOrder: 4 });

  recalculateSequenceLocks([second, fourth]);

  assert.equal(second.public.sequenceLocked, true);
  assert.equal(fourth.public.sequenceLocked, true);
});


test('modos de participação têm padrão compartilhado e permissões controladas', () => {
  assert.deepEqual(PARTICIPATION_MODES.map((mode) => mode.id), ['shared', 'individual', 'controlled']);
  assert.equal(normalizeParticipationMode('desconhecido'), 'shared');
  assert.equal(canPlayerInteract({ participationMode: 'shared' }, 'player-1'), true);
  assert.equal(canPlayerInteract({ participationMode: 'individual' }, 'player-1'), true);
  assert.equal(canPlayerInteract({ participationMode: 'controlled', allowedPlayerIds: ['player-1'] }, 'player-1'), true);
  assert.equal(canPlayerInteract({ participationMode: 'controlled', allowedPlayerIds: ['player-1'] }, 'player-2'), false);
  assert.equal(canPlayerInteract({ participationMode: 'controlled', allowedPlayerIds: [] }, 'player-2', 'GM'), true);
});

test('modo individual e lista de participantes são publicados sem revelar a solução', () => {
  const puzzle = makePuzzle({
    type: 'lock',
    title: 'Cofre individual',
    answer: 'senha-super-secreta',
    participationMode: 'individual',
    allowedPlayerIds: ['player-1'],
  });
  puzzle.public.playerProgress = {
    'player-1': { attemptsUsed: 2, solved: false },
  };
  const publicPuzzle = toPublicState([puzzle]).puzzles[0];
  const serialized = JSON.stringify(publicPuzzle);

  assert.equal(publicPuzzle.participationMode, 'individual');
  assert.deepEqual(publicPuzzle.playerProgress['player-1'], { attemptsUsed: 2, solved: false });
  assert.doesNotMatch(serialized, /senha-super-secreta/);
  assert.equal(puzzle.public.allowedPlayerIds.includes('player-1'), true);
});

test('trocar de modo não carrega o progresso individual para modo compartilhado', () => {
  const individual = makePuzzle({ type: 'lock', title: 'Teste', answer: '1234', participationMode: 'individual' });
  individual.public.playerProgress = { 'player-1': { attemptsUsed: 3 } };
  const shared = makePuzzle({ type: 'lock', title: 'Teste', answer: '1234', participationMode: 'shared' }, individual);
  assert.deepEqual(shared.public.playerProgress, {});
});
