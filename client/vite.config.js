import { defineConfig } from 'vite';

/**
 * Carimba o build no próprio HTML.
 *
 * O nome dos arquivos deixou de levar hash (ver `rollupOptions` abaixo), então
 * o nome não serve mais para dizer qual build está no ar. Quem precisa saber
 * disso é o `checkVersion` do cliente, e o que ele quer descobrir é se o HTML
 * que recebeu é velho — não o JS, que agora é sempre o atual.
 *
 * Só no build: em desenvolvimento o Vite serve o `index.html` da fonte, sem
 * carimbo, e a ausência da meta é o que faz o cliente não comparar nada.
 */
function carimbo() {
  const stamp = Date.now().toString(36);
  return {
    name: 'carimbo-de-build',
    apply: 'build',
    // A forma de descritor, e não um replace no texto: injetando à mão logo
    // depois de `<head>` a meta entrava na frente do `charset`, que precisa
    // ser a primeira coisa do cabeçalho.
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { name: 'build', content: stamp }, injectTo: 'head' },
    ],
  };
}

export default defineConfig({
  // O .env fica na raiz do projeto, não dentro de client/.
  envDir: '..',
  plugins: [carimbo()],
  server: {
    port: 5173,
    // Necessário quando o Vite é exposto por um túnel (cloudflared/ngrok).
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Nomes fixos, de propósito, contra o cache que não é nosso.
        //
        // O padrão do Vite é hash de conteúdo — nome novo a cada build. Isso
        // pressupõe que quem tem o HTML tem o HTML atual, e dentro do Discord
        // essa premissa é falsa: entre o iframe e a hospedagem estão o proxy
        // <app-id>.discordsays.com e o cache do Chromium do cliente desktop,
        // que servem um index.html anterior apesar do no-store. Esse HTML
        // pedia um hash que o build novo tinha acabado de apagar, o pedido
        // caía no catch-all do servidor, voltava HTML no lugar de JS, e o
        // navegador se recusava a executar por MIME. Resultado: Activity em
        // branco depois de todo deploy, com o log limpo.
        //
        // Com nome fixo o HTML velho pede um arquivo que continua existindo, e
        // carrega o build atual. Custa o cache eterno do bundle — que era
        // ilusório de qualquer jeito, já que o proxy do Discord o entregava
        // velho. Ver docs/como-funciona.md.
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
