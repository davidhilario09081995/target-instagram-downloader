// Extrai as mídias (imagem, vídeo, carrossel) de um post público do Instagram.
// O Instagram só entrega os dados do post sem login para crawlers de preview de link,
// por isso as requisições se identificam como Googlebot / facebookexternalhit.

const UA_CRAWLER = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const UA_EMBED = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

class InstagramError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function getShortcode(url) {
  const m = String(url || '').match(/instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/i);
  if (!m) throw new InstagramError('Link inválido. Use um link de post, reel ou carrossel do Instagram.');
  return m[1];
}

async function fetchText(url, userAgent) {
  const res = await fetch(url, {
    headers: { 'User-Agent': userAgent, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new InstagramError(`Instagram respondeu ${res.status}`, 502);
  return res.text();
}

// Procura recursivamente o objeto de mídia cujo "code" é o shortcode do post.
function findMedia(node, shortcode) {
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findMedia(v, shortcode);
      if (r) return r;
    }
  } else if (node && typeof node === 'object') {
    if (node.code === shortcode && (node.image_versions2 || node.carousel_media || node.video_versions)) return node;
    for (const v of Object.values(node)) {
      const r = findMedia(v, shortcode);
      if (r) return r;
    }
  }
  return null;
}

// Maior resolução disponível (usa largura quando existe, senão o primeiro da lista).
function best(list) {
  if (!list || !list.length) return null;
  const withWidth = list.filter((x) => x.width);
  if (withWidth.length) return withWidth.sort((a, b) => b.width - a.width)[0].url;
  return list[0].url;
}

function toItem(media) {
  const image = best(media.image_versions2 && media.image_versions2.candidates);
  const video = best(media.video_versions);
  return video ? { type: 'video', url: video, thumb: image } : { type: 'image', url: image, thumb: image };
}

// Método principal: JSON embutido na página do post (dados completos, resolução máxima).
async function fromPage(shortcode) {
  const html = await fetchText(`https://www.instagram.com/p/${shortcode}/`, UA_CRAWLER);
  const scripts = html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g);
  for (const [, raw] of scripts) {
    if (!raw.includes(shortcode) || !raw.includes('xig_polaris_media')) continue;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const media = findMedia(data, shortcode);
    if (!media) continue;
    const children = media.carousel_media && media.carousel_media.length ? media.carousel_media : [media];
    return {
      username: media.user && media.user.username,
      caption: media.caption && media.caption.text,
      items: children.map(toItem).filter((i) => i.url),
    };
  }
  return null;
}

function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Plano B: página de embed (formato GraphQL antigo).
async function fromEmbed(shortcode) {
  const html = await fetchText(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, UA_EMBED);
  const m = html.match(/"contextJSON":("(?:[^"\\]|\\.)*")/);
  let sm = null;
  if (m) {
    const ctx = JSON.parse(JSON.parse(m[1]));
    sm = ctx && ctx.gql_data && ctx.gql_data.shortcode_media;
  }
  if (!sm) {
    // Imagem única às vezes vem sem contextJSON: usa a maior imagem do srcset da tag <img>.
    const img = html.match(/<img class="EmbeddedMediaImage"[^>]*srcset="([^"]+)"/);
    if (!img) return null;
    const url = decodeHtml(img[1])
      .split(/,\s*/)
      .map((part) => {
        const [u, w] = part.trim().split(/\s+/);
        return { u, w: parseInt(w, 10) || 0 };
      })
      .sort((a, b) => b.w - a.w)[0].u;
    return { username: null, caption: null, items: [{ type: 'image', url, thumb: url }] };
  }
  const nodes = sm.edge_sidecar_to_children ? sm.edge_sidecar_to_children.edges.map((e) => e.node) : [sm];
  return {
    username: sm.owner && sm.owner.username,
    caption: null,
    items: nodes.map((n) =>
      n.is_video && n.video_url
        ? { type: 'video', url: n.video_url, thumb: n.display_url }
        : { type: 'image', url: n.display_url, thumb: n.display_url }
    ),
  };
}

function extensionOf(url, type) {
  const m = new URL(url).pathname.toLowerCase().match(/\.(jpg|jpeg|png|webp|heic|mp4)$/);
  if (m) return m[1];
  return type === 'video' ? 'mp4' : 'jpg';
}

async function getPost(link) {
  const shortcode = getShortcode(link);
  let post = null;
  try {
    post = await fromPage(shortcode);
  } catch (err) {
    console.warn(`[${shortcode}] página falhou: ${err.message}`);
  }
  if (!post || !post.items.length) post = await fromEmbed(shortcode);
  if (!post || !post.items.length) {
    throw new InstagramError('Não foi possível encontrar a mídia. O post pode ser privado, removido ou restrito.', 404);
  }

  const total = post.items.length;
  return {
    shortcode,
    username: post.username || null,
    caption: post.caption || null,
    items: post.items.map((item, i) => ({
      ...item,
      filename: `${shortcode}${total > 1 ? '_' + String(i + 1).padStart(2, '0') : ''}.${extensionOf(item.url, item.type)}`,
    })),
  };
}

module.exports = { getPost, InstagramError };
