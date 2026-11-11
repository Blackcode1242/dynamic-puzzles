import test from 'node:test';
import assert from 'node:assert/strict';
import { makePuzzle, validateAttempt, toPublicState, normalize } from '../src/model.js';

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
