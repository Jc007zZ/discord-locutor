/**
 * Qual máquina atende cada call.
 *
 * O servidor guarda as salas em memória e o relay só alcança os sockets do
 * próprio processo. Duas máquinas atrás de um balanceador comum, que reveza
 * requisição a requisição, colocam o transmissor numa e o espectador na outra —
 * e o quadro não tem para onde ir. A saída não é balancear melhor: é dividir por
 * chave, de modo que a call inteira caia sempre no mesmo lugar.
 *
 * Este módulo é a única fonte dessa decisão, e é importado pelos dois lados de
 * propósito. Se cliente e servidor calculassem o nó com códigos diferentes, uma
 * divergência de arredondamento mandaria a pessoa para a máquina errada — e o
 * sintoma seria uma sala vazia, sem erro nenhum. Mesma função, mesmo resultado.
 *
 * Nada aqui usa API de navegador nem de Node: é aritmética e string, porque
 * precisa rodar nos dois.
 */

/** Chave de quem entra pelo site, fora do Discord: um lobby só. */
export const WEB_KEY = 'web';

/**
 * A chave de shard de uma sessão.
 *
 * O canal vem antes da instância porque o id da sala da call é derivado dele
 * (`call-<channelId>`) e não muda. A instância da Activity, sim: ela é nova a
 * cada relançamento no mesmo canal — o `ensureCallRoom` existe justamente para
 * lidar com isso. Fatiar pela instância migraria a call de máquina a cada
 * relaunch, e por alguns segundos haveria duas salas com o mesmo id em máquinas
 * diferentes, cada uma com metade das pessoas.
 */
export function shardKey({ channel = null, instance = null } = {}) {
  return String(channel || instance || WEB_KEY);
}

/**
 * FNV-1a de 32 bits, com mistura final.
 *
 * Escolhido por ser síncrono. O `crypto.subtle` do navegador só devolve promessa,
 * e a escolha do nó precisa acontecer em linha reta, antes do primeiro pedido —
 * transformá-la em `await` obrigaria a adiar a sessão inteira por causa de um
 * hash. `Math.imul` é o que mantém a multiplicação em 32 bits: com `*` comum o
 * número passa de 2^53 e o resultado deixa de bater entre plataformas.
 *
 * A mistura do fim não é enfeite. O FNV-1a sozinho espalha mal os bits altos, e
 * o rendezvous compara justamente o valor inteiro: com ids de canal parecidos
 * entre si — que é o caso, snowflakes do Discord são quase sequenciais — a
 * escolha saía torta e um crescimento de duas para três máquinas movia metade
 * das calls em vez de um terço. Estas cinco linhas resolveram as duas coisas.
 */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;

  return h >>> 0;
}

/**
 * O índice da máquina que atende esta chave, entre `nodes` máquinas.
 *
 * É *rendezvous hash*: pontua a chave contra cada máquina e fica com a maior.
 * O ganho sobre `hash % nodes` aparece no dia em que a quantidade de máquinas
 * muda — aqui só ~1/N das chaves troca de lugar, e as que ficam continuam
 * exatamente onde estavam. Com módulo, mudar N reembaralha quase tudo e derruba
 * todas as calls de uma vez.
 */
export function nodeFor(key, nodes) {
  const total = Math.trunc(Number(nodes)) || 1;
  if (total <= 1) return 0;

  let escolhido = 0;
  let maior = -1;

  for (let i = 0; i < total; i++) {
    const score = fnv1a(`${key}:${i}`);
    // Estritamente maior: no empate fica o menor índice. A regra em si não
    // importa, importa ser a mesma nos dois lados.
    if (score > maior) {
      maior = score;
      escolhido = i;
    }
  }

  return escolhido;
}

/** O prefixo de caminho de uma máquina: `/n0`, `/n1`, … */
export function basePathFor(index) {
  return `/n${index}`;
}

/**
 * Separa o prefixo de nó de um caminho.
 *
 * A fronteira é de caminho, não de texto: `/n1x` é outra rota, não a `/n1` com
 * sufixo. Sem o `(?=\/|$)` ela viraria `/x` em silêncio — o mesmo cuidado que o
 * corte do `/.proxy` já toma no servidor.
 */
export function stripNode(pathname) {
  const achado = /^\/n(\d+)(?=\/|$)/.exec(pathname);
  if (!achado) return { index: null, path: pathname };
  return { index: Number(achado[1]), path: pathname.slice(achado[0].length) || '/' };
}
