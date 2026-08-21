# Plano: a tela branca no Discord depois de cada deploy

Documento de trabalho. Registra o diagnóstico, o que já foi feito e o conserto
que ainda não foi aplicado no código. A explicação para quem só quer entender o
defeito está em
[como-funciona.md](como-funciona.md#a-tela-branca-depois-de-um-deploy); aqui
ficam as decisões e o que falta fazer.

## Contexto

O sintoma relatado: a cada reinício para deploy, a Activity do Discord fica um
retângulo branco por muito tempo, enquanto o site abre normalmente no
navegador. Nada no log — o servidor responde 200 a tudo.

O diagnóstico saiu da leitura do código. São três peças, e nenhuma delas
quebra sozinha:

1. **O nome do arquivo muda a cada build.** O Vite escreve
   `assets/index-<hash>.js` com hash de conteúdo, e `emptyOutDir: true` em
   [client/vite.config.js](../client/vite.config.js) apaga o `dist` antes de
   escrever o novo. Terminado o deploy, o bundle anterior não existe mais em
   lugar nenhum.
2. **O Discord entrega um `index.html` velho.** O servidor manda `no-store`, e
   no navegador isso basta. Entre o iframe e a hospedagem existem duas camadas
   que o navegador comum não tem: o proxy `<app-id>.discordsays.com` e o cache
   do Chromium dentro do cliente desktop, que sobrevive a fechar e reabrir a
   atividade. É a mesma observação que motivou o `checkVersion` em
   [client/src/main.js](../client/src/main.js). Esse HTML velho pede o hash
   velho.
3. **O catch-all devolve HTML no lugar do arquivo que sumiu.** O
   `express.static` dá 404 no hash velho, e o `app.get('*')` de
   [server/index.js](../server/index.js) atende qualquer caminho fora de `/api`
   com o `index.html` — 200, `Content-Type: text/html`, para um pedido de
   módulo JS. O Chromium recusa executar, o CSS leva o mesmo tratamento, e a
   página fica em branco. Do lado do servidor foi tudo 200; daí o log limpo.

O navegador escapa porque tem F5: o `no-store` do HTML é respeitado, vem HTML
novo com hashes novos, funciona na hora. Dentro da atividade não há recarga, e
o cache que serve aquele HTML não é nosso — só resta esperar expirar.

O `checkVersion` foi escrito para avisar exatamente disso, mas não alcança este
caso: ele vive dentro do bundle que não carregou.

## Feito

- **[como-funciona.md](como-funciona.md)** — seção
  `A tela branca depois de um deploy`, com o mecanismo das três peças, o
  conserto proposto e como confirmar pelo devtools da atividade.
- **[vps.md](vps.md)** — o bloco `Atualizar` passou a explicar a janela de 404
  que o `emptyOutDir` abre com o servidor no ar, e a receita de build atômico
  (montar em `dist.novo`, trocar com `mv`). No fim do arquivo, a subseção
  `Duas telas brancas diferentes` separa este caso do retângulo branco
  permanente causado por `X-Frame-Options` na borda da hospedagem — dois
  defeitos com o mesmo sintoma e causas sem relação nenhuma.

Duas correções nesses textos vieram da revisão e valem registro, porque a
versão errada é convincente:

- **`dist.velho` não é servido por ninguém.** O servidor monta um único caminho
  estático (`client/dist`). Guardar o build anterior num diretório irmão serve
  para rollback e mais nada — quem chegar pedindo um arquivo antigo toma 404
  igual. Para os assets antigos continuarem alcançáveis, precisam ser copiados
  para dentro do `dist` novo, e isso é paliativo que cresce a cada deploy.
- **`npm -w client run build -- --outDir dist.novo`**, e não `npx vite build`:
  respeita o workspace e o script que já existe em `client/package.json`.

## O conserto no código, aplicado

Feito no commit `ebc7580`, trazido para a `main` pelo merge `969ccdd`. O ponto
de ataque foi a peça 1, não a 2 — o cache do Discord não está sob nosso
controle, mas o nome do arquivo está. Com um nome que continua existindo, o HTML
velho carrega o JS novo e o problema desaparece na raiz.

**1. Nome fixo no arquivo de entrada** — `client/vite.config.js`:

```js
build: {
  outDir: 'dist',
  emptyOutDir: true,
  rollupOptions: {
    output: {
      entryFileNames: 'assets/app.js',
      assetFileNames: 'assets/[name][extname]',
    },
  },
}
```

**2. Política de cache oposta para esses dois** — em `server/index.js`, a regra
que hoje carimba `immutable` em tudo que está em `/assets` precisa carimbar
`no-store` neles. O que se perde é o cache eterno do bundle de entrada:
irrelevante num arquivo que muda a cada deploy e que o proxy do Discord ia
servir velho de qualquer jeito.

**3. 404 de verdade para caminho com extensão** — `if (path.extname(req.path))
return next()` no começo do catch-all. A rota existe para o roteamento da
aplicação, não para asset, e devolver HTML no lugar de um `.js` que faltou troca
um erro visível em três segundos por uma tela branca muda. Vale por si, mesmo
sem os dois itens acima.

O item 3 é isolado e barato; 1 e 2 andam juntos e mexem no formato do build.

Um teste de regressão acompanha o conserto (`server/index.test.js`, bloco
"site buildado"): asset inexistente responde 404 e corpo que não é a página.
Sem o fix ele falha com 200 — verificado desligando o `path.extname` de
propósito.

## Interação com o sharding

Vale saber, porque as duas coisas chegaram juntas: com `SHARD_NODES` acima de 1,
o `/api/config` é respondido por qualquer máquina, de propósito (ele não tem
estado). O carimbo do build vem justamente dali. Se as máquinas forem
atualizadas em momentos diferentes, uma pode relatar um carimbo que não é o da
máquina que serviu o HTML, e o aviso de versão velha aparece sem haver versão
velha. Não trava nada — no site o recarregamento é guardado por `sessionStorage`
e acontece uma vez só; no Discord é apenas um toast. Some quando o deploy
termina em todas as máquinas.

## Como confirmar o diagnóstico

Devtools da atividade no Discord desktop (Ctrl+Shift+I, com o modo
desenvolvedor ligado), logo depois de um deploy: o erro de MIME type no console
é a assinatura. Sem o Discord, do lado de fora:

```bash
curl -sI https://seu-dominio/assets/index-naoexiste.js | head -2
```

`200` com `content-type: text/html` é o catch-all respondendo — a peça 3.

## Verificação depois de aplicar o conserto

1. `npm run build` e conferir que o `client/dist/index.html` aponta para
   `assets/app.js`, sem hash.
2. `curl -sI .../assets/app.js` — precisa vir `no-store`.
3. `curl -sI .../assets/index-naoexiste.js` — precisa vir `404`, não `200` com
   `text/html`.
4. `npm test` e `npm run lint`.
5. Deploy e abrir a atividade no Discord desktop sem limpar cache nenhum: tem
   que abrir na versão nova de primeira.
