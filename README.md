# Target · Instagram Downloader (web)

Site para baixar posts públicos do Instagram (imagem, vídeo/reel e carrossel completo) pelo link.

- **Backend:** Node.js 18+ sem dependências (`server.js` + `lib/instagram.js`)
- **Frontend:** `public/index.html` (página única)

## Rodar localmente

```bash
node server.js
# abre em http://localhost:3000
```

A porta pode ser trocada com a variável `PORT`.

## Endpoints

| Rota | Descrição |
|---|---|
| `GET /api/post?url=<link>` | Retorna usuário e lista de mídias do post (JSON) |
| `GET /api/media?url=<cdn>&dl=1&name=<arquivo>` | Repassa a mídia do CDN do Instagram (com `dl=1` força o download) |
| `GET /health` | Health check |
| `GET /?url=<link>` | Abre o site já buscando o post |

Proteções incluídas: `/api/media` só aceita URLs `https` dos CDNs do Instagram (`cdninstagram.com`, `fbcdn.net`), limite de 20 consultas por minuto por IP e cache de 10 minutos por post.

## Colocar em produção (Render, exemplo gratuito)

1. Suba a pasta `web/` para um repositório no GitHub.
2. Em <https://render.com>: **New → Web Service** → selecione o repositório.
3. Configure:
   - Runtime: **Node**
   - Build command: *(vazio)*
   - Start command: `node server.js`
   - Health check path: `/health`
4. Deploy. O Render gera um link `https://<nome>.onrender.com`, e dá para apontar um domínio próprio depois.

Funciona igual em Railway, Fly.io ou uma VPS (`node server.js` atrás de um Nginx/PM2).

## Observações importantes

- O Instagram costuma ser mais restritivo com IPs de datacenter do que com IPs residenciais. Se em produção as buscas começarem a retornar "Não foi possível encontrar a mídia", o servidor provavelmente está sendo bloqueado pelo Instagram. Nesse caso, a saída é usar um proxy residencial ou uma conta logada.
- A extração depende do formato atual das páginas do Instagram e pode precisar de ajustes se ele mudar.
- Use apenas com conteúdo que você tem direito de baixar.
