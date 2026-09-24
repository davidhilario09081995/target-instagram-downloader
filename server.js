const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { getPost, InstagramError } = require('./lib/instagram');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT = { windowMs: 60 * 1000, max: 20 }; // consultas de post por IP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Só repassamos arquivos dos CDNs do Instagram (evita virar um proxy aberto).
const ALLOWED_MEDIA_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

const cache = new Map();
const hits = new Map();

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT.windowMs) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT.max;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_TTL_MS) cache.delete(k);
  for (const [k, v] of hits) if (now - v.start > RATE_LIMIT.windowMs) hits.delete(k);
}, 60 * 1000).unref();

async function handlePost(req, res, query) {
  if (rateLimited(clientIp(req))) {
    return sendJson(res, 429, { error: 'Muitas consultas seguidas. Aguarde um minuto e tente novamente.' });
  }
  const link = query.get('url');
  try {
    const key = (link || '').trim();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return sendJson(res, 200, cached.data);

    const data = await getPost(link);
    cache.set(key, { at: Date.now(), data });
    sendJson(res, 200, data);
  } catch (err) {
    if (err instanceof InstagramError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Erro ao consultar o Instagram. Tente novamente em instantes.' });
  }
}

// Repassa a mídia do CDN. Com dl=1 força o download com o nome de arquivo informado.
async function handleMedia(req, res, query) {
  let target;
  try {
    target = new URL(query.get('url'));
  } catch {
    return sendJson(res, 400, { error: 'URL inválida.' });
  }
  if (target.protocol !== 'https:' || !ALLOWED_MEDIA_HOST.test(target.hostname)) {
    return sendJson(res, 400, { error: 'URL não permitida.' });
  }

  try {
    const upstream = await fetch(target, { signal: AbortSignal.timeout(60000) });
    if (!upstream.ok || !upstream.body) return sendJson(res, 502, { error: 'Falha ao baixar a mídia.' });

    const headers = {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    };
    const length = upstream.headers.get('content-length');
    if (length) headers['Content-Length'] = length;
    if (query.get('dl') === '1') {
      const name = (query.get('name') || 'instagram').replace(/[^\w.-]/g, '_').slice(0, 100);
      headers['Content-Disposition'] = `attachment; filename="${name}"`;
    }
    res.writeHead(200, headers);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 502, { error: 'Falha ao baixar a mídia.' });
    else res.destroy();
  }
}

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Proibido.' });
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Página não encontrada');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Método não permitido.' });
  if (pathname === '/api/post') return handlePost(req, res, searchParams);
  if (pathname === '/api/media') return handleMedia(req, res, searchParams);
  if (pathname === '/health') return sendJson(res, 200, { ok: true });
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
