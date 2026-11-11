import test from 'node:test';
import assert from 'node:assert/strict';
import { makePuzzle, validateAttempt, toPublicState, normalize, evaluateAttempt } from '../src/model.js';

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
