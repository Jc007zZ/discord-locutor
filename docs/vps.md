# Hospedar num VPS

Este é o caminho recomendado para deixar a Sala de Tela no ar sem depender do
computador de ninguém. O programa é um relay de vídeo: a saída é
`bitrate × espectadores`, e isso não cabe bem em hospedagem compartilhada. Um
VPS pequeno — 1 vCPU, 2 GB, tráfego generoso — resolve por poucos euros ao mês.

O que **não** funciona bem, e por que este documento existe: PaaS com borda
própria (Square Cloud, e provavelmente outros) carimba
`X-Frame-Options: SAMEORIGIN` em toda resposta. O Discord embute a Activity num
iframe, o navegador obedece ao header, e o resultado é um retângulo branco sem
erro nenhum no log. Não há conserto pelo código: o proxy do Discord repassa
aquele header e substitui o nosso CSP pelo dele. Num VPS o problema não existe,
porque a borda é sua.

Assume Ubuntu 24.04. Em Debian é igual; em outras distribuições muda só o
gerenciador de pacotes.

## 1. Domínio

Um registro **A** apontando para o IP do VPS.

Se o domínio estiver na Cloudflare, deixe em **DNS only** (nuvem cinza). Não é
capricho: o proxy da Cloudflare no plano gratuito não é para tráfego de vídeo
(seção 2.8 dos termos deles), e ele acrescenta uma borda que você não controla
entre o Discord e o seu servidor — foi exatamente esse tipo de borda que
custou um dia de depuração.

## 2. Node

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node -v   # precisa ser 22 ou mais novo
```

Versão 22 ou superior porque o servidor usa `fetch` nativo e `--watch`.

## 3. Usuário e código

Um usuário de sistema sem shell e sem senha: se um dia alguém escapar do
processo, escapa para um usuário que não pode fazer nada.

```bash
sudo adduser --system --group --home /opt/sala-de-tela sala

sudo -u sala git clone https://github.com/Jc007zZ/discord-screen.git /opt/sala-de-tela
cd /opt/sala-de-tela
sudo -u sala npm ci
sudo -u sala npm run build
```

O home do usuário é a própria pasta do projeto de propósito: sem home, o npm
não tem onde escrever o cache e o `npm ci` falha com um erro sobre
`/nonexistent` que não diz nada a ninguém.

O `npm ci` respeita o `package-lock.json` — em servidor isso importa, porque
`npm install` pode subir uma versão menor sem ninguém pedir.

## 4. Configuração

```bash
sudo -u sala npm run configurar
```

O assistente pergunta o essencial e escreve o `.env`. Confira ao final que
ficou assim:

```
PORT=3001
PUBLIC_ORIGIN=https://seu-dominio
NODE_ENV=production
SESSION_SECRET=<hex de 64 caracteres, gerado pelo assistente>
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
```

`PORT=3001` e não 80: quem atende na 80 e na 443 é o Caddy, no passo 6. E o
`SESSION_SECRET` não é opcional aqui — com `NODE_ENV=production` o servidor
recusa subir sem ele, porque sem segredo os crachás de sala seriam forjáveis.

```bash
sudo chmod 600 /opt/sala-de-tela/.env
```

## 5. Serviço

```bash
sudo cp infra/sala-de-tela.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sala-de-tela
systemctl status sala-de-tela
```

Se o `ExecStart` reclamar, confira o caminho do node com `which node` — o
systemd não tem PATH de shell e precisa do caminho absoluto.

## 6. Caddy

```bash
sudo apt install -y caddy
sudo cp infra/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile      # troque o domínio
sudo systemctl reload caddy
```

O certificado do Let's Encrypt é pedido e renovado sozinho. Para isso as portas
80 e 443 precisam estar abertas e o DNS já apontando — se o certificado falhar,
quase sempre é uma dessas duas coisas.

## 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

A 3001 fica fechada de propósito: só o Caddy fala com ela, pelo localhost.

## 8. Discord

No portal, em https://discord.com/developers/applications:

- **Activities → URL Mappings**: prefixo `/`, target `seu-dominio` (sem o `https://`)
- **OAuth2 → Redirects**: `https://seu-dominio/auth/callback`

Feche e reabra a Activity depois de salvar — o cliente do Discord guarda o
iframe e o mapeamento em cache.

## Atualizar

```bash
cd /opt/sala-de-tela
sudo -u sala git pull
sudo -u sala npm ci
sudo -u sala npm run build
sudo systemctl restart sala-de-tela
```

Esse `npm run build` roda com o servidor antigo ainda no ar, e o Vite apaga o
`client/dist` antes de escrever o novo: durante esses segundos o site inteiro
responde 404, inclusive o `/`. No navegador ninguém nota — recarrega e pronto.
O proxy do Discord pode guardar a resposta de erro e esticar o estrago muito
além do deploy. Para fechar a janela, monte fora e troque de uma vez:

```bash
sudo -u sala npm -w client run build -- --outDir dist.novo
sudo -u sala rm -rf client/dist.velho
sudo -u sala mv client/dist client/dist.velho
sudo -u sala mv client/dist.novo client/dist
sudo systemctl restart sala-de-tela
```

O `dist.velho` que sobra serve para voltar atrás — `mv` de novo, na ordem
inversa, e o site anterior está no ar. Só isso: um diretório irmão **não** é
servido por ninguém. O servidor monta um único caminho estático
(`client/dist`), então quem chegar pedindo um arquivo do build anterior toma
404 do mesmo jeito.

Se quiser que os arquivos antigos continuem alcançáveis, eles precisam entrar
no `dist` novo, antes da troca:

```bash
sudo -u sala cp -rn client/dist/assets/. client/dist.novo/assets/
```

É paliativo, e cresce: cada deploy soma um par JS+CSS que nunca sai, porque a
união seguinte carrega a anterior junto. O conserto de verdade é o nome fixo no
arquivo de entrada, descrito em
[A tela branca depois de um deploy](como-funciona.md#a-tela-branca-depois-de-um-deploy).

## Quando algo der errado

```bash
journalctl -u sala-de-tela -f      # o servidor
journalctl -u caddy -f             # certificado e proxy
curl -sI https://seu-dominio | grep -i x-frame   # não deve devolver nada
```

Aquele `curl` é o teste que faltou fazer cedo demais neste projeto: se aparecer
um `x-frame-options`, a Activity vai abrir branca, e o problema está em quem
está na frente do servidor — não no código.

### Duas telas brancas diferentes

A do `x-frame-options` é permanente: a Activity nunca abre, em máquina nenhuma,
e o mesmo endereço funciona quando aberto direto no navegador.

A outra aparece **só depois de um deploy**, dura um tempo e passa sozinha,
enquanto o site vai bem o tempo todo. Essa não está na borda — é o cliente do
Discord servindo um `index.html` velho, que pede arquivos que o build novo
apagou. O diagnóstico e o conserto estão em
[A tela branca depois de um deploy](como-funciona.md#a-tela-branca-depois-de-um-deploy).

```bash
# 200 com content-type text/html aqui confirma o caso
curl -sI https://seu-dominio/assets/index-naoexiste.js | head -2
```
