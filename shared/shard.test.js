/**
 * A escolha da máquina que atende cada call.
 *
 * Três propriedades sustentam o sharding, e nenhuma delas aparece ao rodar o
 * programa: a chave tem de ser estável (mesma call, mesma máquina, sempre), a
 * divisão tem de ser mais ou menos pareja (uma máquina com 90% das calls é o
 * mesmo problema de antes com passos a mais), e mudar a quantidade de máquinas
 * tem de mover o mínimo — sem embaralhar as calls que não precisavam sair.
 *
 * É por isso que a última delas é testada com afinco: ela é a diferença entre o
 * rendezvous hash e um `% N`, e é invisível até o dia em que se acrescenta uma
 * máquina e todas as calls caem juntas.
 */
import { describe, expect, it } from 'vitest';

import { WEB_KEY, basePathFor, nodeFor, shardKey, stripNode } from './shard.js';

/** Ids de canal plausíveis: 18 dígitos, como os do Discord. */
function canais(quantos) {
  const lista = [];
  for (let i = 0; i < quantos; i++) lista.push(String(100000000000000000n + BigInt(i) * 7919n));
  return lista;
}

describe('shardKey', () => {
  it('prefere o canal, que é estável entre relançamentos', () => {
    expect(shardKey({ channel: '123', instance: 'abc' })).toBe('123');
    // A mesma call, relançada: instância nova, chave igual.
    expect(shardKey({ channel: '123', instance: 'xyz' })).toBe('123');
  });

  it('cai na instância quando não há canal', () => {
    expect(shardKey({ instance: 'abc' })).toBe('abc');
  });

  it('cai no lobby do site quando não há nem canal nem instância', () => {
    expect(shardKey({})).toBe(WEB_KEY);
    expect(shardKey()).toBe(WEB_KEY);
    // String vazia é ausência, não uma chave chamada "".
    expect(shardKey({ channel: '', instance: '' })).toBe(WEB_KEY);
  });
});

describe('nodeFor', () => {
  it('devolve sempre o mesmo nó para a mesma chave', () => {
    for (const canal of canais(50)) {
      expect(nodeFor(canal, 4)).toBe(nodeFor(canal, 4));
    }
  });

  it('fica no índice 0 quando há uma máquina só', () => {
    for (const canal of canais(20)) expect(nodeFor(canal, 1)).toBe(0);
  });

  it('trata quantidade ausente ou inválida como máquina única', () => {
    // O padrão precisa ser "sharding desligado": é o que roda na casa de quem
    // não configurou nada.
    expect(nodeFor('123', 0)).toBe(0);
    expect(nodeFor('123', undefined)).toBe(0);
    expect(nodeFor('123', 'nada')).toBe(0);
  });

  it('devolve um índice dentro da faixa', () => {
    for (const canal of canais(200)) {
      const i = nodeFor(canal, 3);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(3);
    }
  });

  it('divide as chaves de forma pareja', () => {
    const total = 3;
    const contagem = new Array(total).fill(0);
    const chaves = canais(3000);
    for (const canal of chaves) contagem[nodeFor(canal, total)]++;

    // Longe da perfeição de propósito: o que se quer provar é que nenhuma
    // máquina fica ociosa nem leva o dobro da conta, não que o hash é uniforme
    // até a terceira casa.
    const ideal = chaves.length / total;
    for (const quantas of contagem) {
      expect(quantas).toBeGreaterThan(ideal * 0.7);
      expect(quantas).toBeLessThan(ideal * 1.3);
    }
  });

  it('ao crescer, move poucas chaves e não embaralha as que ficam', () => {
    const chaves = canais(3000);
    const antes = new Map(chaves.map((c) => [c, nodeFor(c, 2)]));

    let mudaram = 0;
    for (const canal of chaves) {
      const agora = nodeFor(canal, 3);
      if (agora === antes.get(canal)) continue;
      mudaram++;
      // A garantia que o `% N` não dá: quem sai, sai para a máquina nova. Uma
      // chave nunca pula da máquina 0 para a 1 só porque apareceu uma terceira.
      expect(agora).toBe(2);
    }

    // O esperado é ~1/3. A folga cobre a variação do hash sem deixar passar uma
    // regressão para módulo, que moveria a maioria.
    expect(mudaram / chaves.length).toBeGreaterThan(0.2);
    expect(mudaram / chaves.length).toBeLessThan(0.45);
  });

  it('ao encolher, só as chaves da máquina que sumiu mudam de lugar', () => {
    const chaves = canais(3000);
    for (const canal of chaves) {
      const antes = nodeFor(canal, 3);
      const depois = nodeFor(canal, 2);
      if (antes < 2) expect(depois).toBe(antes);
      else expect(depois).toBeLessThan(2);
    }
  });
});

describe('basePathFor', () => {
  it('monta o prefixo da máquina', () => {
    expect(basePathFor(0)).toBe('/n0');
    expect(basePathFor(12)).toBe('/n12');
  });
});

describe('stripNode', () => {
  it('separa índice e caminho', () => {
    expect(stripNode('/n1/api/rooms/join')).toEqual({ index: 1, path: '/api/rooms/join' });
    expect(stripNode('/n12/ws')).toEqual({ index: 12, path: '/ws' });
  });

  it('o prefixo sozinho vira a raiz', () => {
    expect(stripNode('/n0')).toEqual({ index: 0, path: '/' });
  });

  it('deixa passar o que não tem prefixo', () => {
    expect(stripNode('/api/config')).toEqual({ index: null, path: '/api/config' });
    expect(stripNode('/')).toEqual({ index: null, path: '/' });
  });

  it('respeita a fronteira de caminho', () => {
    // `/n1x` é outra rota, não a `/n1` com sufixo — o mesmo engano que o corte
    // do `/.proxy` já evita no servidor.
    expect(stripNode('/n1x/api')).toEqual({ index: null, path: '/n1x/api' });
    expect(stripNode('/nada')).toEqual({ index: null, path: '/nada' });
  });
});
