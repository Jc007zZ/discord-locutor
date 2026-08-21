/**
 * O mesmo servidor, agora como uma máquina de duas.
 *
 * Arquivo separado do `index.test.js` pelo mesmo motivo do `index-admin`: a
 * decisão é tomada no corpo do módulo, uma vez. Com sharding ligado é outro
 * servidor — um que recusa o que não é dele.
 *
 * O que se prova aqui é a rede de proteção, não o caminho feliz. Na vida real o
 * cliente calcula a mesma máquina sozinho e bate no lugar certo; estas rotas só
 * disparam quando alguém chega errado — bundle velho, link antigo, borda mal
 * configurada. E é justamente aí que o sintoma sem elas seria o pior possível:
 * uma sala vazia, com o servidor de pé e o log limpo.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { nodeFor, shardKey } from '../shared/shard.js';

const AQUI = 'https://n0.exemplo.test';
const LA = 'https://n1.exemplo.test';

process.env.SHARD_NODES = '2';
process.env.SHARD_INDEX = '0';
process.env.NODE_ORIGINS = `${AQUI},${LA}`;
process.env.PUBLIC_ORIGIN = AQUI;

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const { server, wss } = await import('./index.js');
const { signToken } = await import('./tokens.js');
if (!server.listening) await new Promise((pronto) => server.once('listening', pronto));
const porta = server.address().port;
const base = `http://127.0.0.1:${porta}`;

/**
 * Um id de canal que caia na máquina pedida.
 *
 * Procurado em vez de escrito à mão de propósito: um id fixo no teste vira
 * mentira silenciosa no dia em que a função de hash mudar, e o teste passaria
 * a provar o contrário do que diz.
 */
function canalDe(no) {
  for (let i = 0; i < 10000; i++) {
    const id = String(100000000000000000n + BigInt(i));
    if (nodeFor(shardKey({ channel: id }), 2) === no) return id;
  }
  throw new Error(`nenhum canal caiu na maquina ${no}`);
}

const CANAL_DAQUI = canalDe(0);
const CANAL_DE_LA = canalDe(1);

const post = (caminho, corpo) =>
  fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo ?? {}),
  });

const get = (caminho) => fetch(`${base}${caminho}`, { redirect: 'manual' });

/** Identidade assinada pelo próprio servidor, com o canal escolhido. */
async function identidade(canal) {
  const r = await post('/api/session-dev', { instance_id: `i-${canal}`, call: canal });
  return (await r.json()).identity;
}

afterAll(async () => {
  wss.close();
  await new Promise((pronto) => server.close(pronto));
});

describe('prefixo da máquina', () => {
  it('atende no próprio prefixo', async () => {
    const r = await get('/n0/api/health');

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('atende no prefixo por baixo do proxy do Discord', async () => {
    const r = await get('/.proxy/n0/api/health');

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('recusa o prefixo de outra máquina com 421', async () => {
    const r = await get('/n1/api/health');

    // 421 e não 404: a diferença entre "a borda te trouxe ao lugar errado" e "a
    // rota não existe" é o que separa olhar o mapeamento de caçar um bug que
    // não existe no código.
    expect(r.status).toBe(421);
    expect(await r.json()).toMatchObject({ error: 'misdirected', node: 0, base: '/n0' });
  });

  it('respeita a fronteira de caminho', async () => {
    // `/n1x` não é a `/n1` com sufixo: não pode virar 421 nem ser cortada.
    const r = await get('/n1x/api/health');

    expect(r.status).not.toBe(421);
  });

  it('preserva a query ao cortar o prefixo', async () => {
    const r = await get('/n0/api/health?x=1');

    expect(r.status).toBe(200);
  });
});

describe('chave de outra máquina', () => {
  it('recusa a sala da call e diz para onde ir', async () => {
    const r = await post('/api/rooms/call', { identity: await identidade(CANAL_DE_LA) });

    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({
      error: 'wrong_node',
      node: 1,
      base: '/n1',
      origin: LA,
    });
  });

  it('atende a sala da call que é dela', async () => {
    const r = await post('/api/rooms/call', { identity: await identidade(CANAL_DAQUI) });

    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ roomId: `call-${CANAL_DAQUI}` });
  });

  it('recusa a lista, em vez de devolver uma lista vazia', async () => {
    // O modo de falhar que importa: sem a checagem isto responderia 200 com
    // zero salas, e não há nada mais difícil de depurar do que um lobby vazio
    // que devia estar cheio.
    const r = await post('/api/rooms/list', { identity: await identidade(CANAL_DE_LA) });

    expect(r.status).toBe(409);
  });

  it('recusa criar, entrar e trocar senha', async () => {
    const identity = await identidade(CANAL_DE_LA);

    for (const rota of ['/api/rooms/create', '/api/rooms/join', '/api/rooms/password']) {
      const r = await post(rota, { identity, name: 'Sala', roomId: 'x' });
      expect(r.status, rota).toBe(409);
    }
  });

  it('recusa abrir um ingresso de sala de outra máquina', async () => {
    const ingresso = signToken({
      room: `call-${CANAL_DE_LA}`,
      uid: 'u',
      name: 'Pessoa',
      av: null,
      channel: CANAL_DE_LA,
      role: 'viewer',
    });

    const r = await post('/api/rooms/open', { token: ingresso });

    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ origin: LA });
  });
});

describe('shareUrl', () => {
  it('aponta para a origem da máquina dona da sala', async () => {
    const r = await post('/api/rooms/call', { identity: await identidade(CANAL_DAQUI) });
    const { shareUrl } = await r.json();

    expect(shareUrl.startsWith(`${AQUI}/share.html`)).toBe(true);
  });
});

describe('/api/config', () => {
  it('conta quantas máquinas existem e onde ficam', async () => {
    const r = await get('/api/config');

    // O cliente fora do Discord depende disto: lá não há proxy nem mapeamento
    // de caminho, só a origem absoluta.
    expect(await r.json()).toMatchObject({ shards: 2, nodes: [AQUI, LA] });
  });
});

describe('upgrade do WebSocket', () => {
  const conectar = (caminho, token) =>
    new Promise((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${porta}${caminho}?t=${encodeURIComponent(token ?? '')}`,
      );
      ws.once('open', () => {
        ws.close();
        resolve({ aberto: true, status: null });
      });
      ws.once('unexpected-response', (_req, res) =>
        resolve({ aberto: false, status: res.statusCode }),
      );
      ws.once('error', () => resolve({ aberto: false, status: null }));
    });

  const tokenDe = (canal) =>
    signToken({
      room: `call-${canal}`,
      uid: 'u',
      name: 'Pessoa',
      av: null,
      channel: canal,
      role: 'viewer',
    });

  it('recusa o token de uma sala de outra máquina', async () => {
    // O token é válido e a sala existe — do outro lado. Aceitar aqui daria um
    // socket de pé mostrando tela preta, com o relay funcionando longe dali.
    const r = await conectar('/ws', tokenDe(CANAL_DE_LA));

    expect(r.aberto).toBe(false);
    expect(r.status).toBe(409);
  });

  it('recusa o prefixo de outra máquina', async () => {
    const r = await conectar('/n1/ws', tokenDe(CANAL_DAQUI));

    expect(r.aberto).toBe(false);
    expect(r.status).toBe(421);
  });

  it('aceita no próprio prefixo o token de uma sala sua', async () => {
    await post('/api/rooms/call', { identity: await identidade(CANAL_DAQUI) });

    const r = await conectar('/n0/ws', tokenDe(CANAL_DAQUI));

    expect(r.aberto).toBe(true);
  });
});
