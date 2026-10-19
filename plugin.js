export const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const BASE_URL = "https://pelisjuanita.com";

// --- AYUDANTE MAESTRO: Fetch + Fallback a WebView ---
async function getHtml(url, referer) {
  // 1. Intentamos con fetch (rápido, por si Cloudflare nos deja pasar)
  try {
    const res = await kino.fetch(url, { 
      headers: { "User-Agent": UA, "Referer": referer || `${BASE_URL}/movies/` } 
    });
    if (res.ok && res.status !== 403) return await res.text();
  } catch (e) {}

  // 2. Si fetch falla (403), abrimos el WebView real de Kino
  kino.log(`Fetch falló o dio 403. Usando WebView en: ${url}`);
  try {
    const page = await kino.browser.page(url, { timeoutMs: 15000 });
    if (page && page.html) return page.html;
  } catch (e) {
    kino.log(`Error en WebView: ${e.message}`);
  }
  return "";
}
// --- BROWSE (Paginación con WebView) ---
export async function browse(ref, cursor) {
  const page = cursor ? parseInt(cursor, 10) : 1;
  
  // Si no hay referencia, por defecto cargamos películas
  let url = ref || `${BASE_URL}/movies/peliculas`;

  // Agregamos la paginación a la URL (asumiendo que usan ?page=2 o &page=2)
  if (page > 1) {
    url += url.includes("?") ? `&page=${page}` : `?page=${page}`;
  }

  kino.log(`Paginando: ${url}`);
  const html = await getHtml(url);
  const items = extractItems(html);
  
  kino.log(`browse: ${html.length} bytes, ${items.length} items extraídos (Página ${page})`);

  return {
    items: items,
    // Si la extracción nos devolvió una cantidad considerable de tarjetas (ej. 20 o más),
    // asumimos que existe una página siguiente y le pedimos a Kino que cargue la próxima al hacer scroll.
    next: items.length >= 20 ? String(page + 1) : null
  };
}
// --- EXTRACTOR DE TARJETAS HTML ---
function extractItems(html) {
  const items = [];
  const vistos = new Set();
  
  const aRegex = /<a[^>]+href=["']([^"']+(?:\/pelicula\/|\/serie\/|\/anime\/)[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  
  while ((match = aRegex.exec(html)) !== null) {
    let link = match[1];
    let inner = match[2];

    if (vistos.has(link)) continue;
    
    let imgMatch = inner.match(/<img[^>]+(?:src|data-src|data-lazy)=["']([^"']+)["']/i);
    let titleMatch = inner.match(/<h[2-6][^>]*>([^<]+)<\/h[2-6]>/i) || inner.match(/alt=["']([^"']+)["']/i);
    
    if (imgMatch && titleMatch) {
      vistos.add(link);
      let img = imgMatch[1];
      if (!img.startsWith('http')) img = `https://image.tmdb.org/t/p/w500/${img.replace(/^\//, '')}`;

      const fullLink = link.startsWith("http") ? link : `${BASE_URL}${link}`;
      
      items.push({
        id: "pjcom-" + link.split('/').pop(),
        ref: fullLink,
        title: titleMatch[1].replace(/<[^>]+>/g, "").trim(),
        kind: fullLink.includes("/serie/") || fullLink.includes("/anime/") ? "series" : "movie",
        poster: img,
        backdrop: img.replace("/w500/", "/w780/") 
      });
    }
  }
  return items;
}

// --- HOME ---
export async function home() {
  kino.log(`Descargando Home...`);
  let html = await getHtml(`${BASE_URL}/movies/home.php`);
  
  if (!html || html.length < 500) {
    kino.log(`home.php falló, intentando /movies/`);
    html = await getHtml(`${BASE_URL}/movies/`);
  }

  const items = extractItems(html);
  kino.log(`home: ${html.length} bytes, ${items.length} items extraídos`);
  
  if (items.length === 0) return [];
  return [{ id: "h-recientes", title: "Catálogo PelisJuanita (.com)", ref: "inicio", items }];
}

// --- SEARCH ---
export async function search(query) {
  if (!query || !query.q) return [];
  const term = encodeURIComponent(query.q);
  
  kino.log(`Buscando: ${query.q}`);
  const html = await getHtml(`${BASE_URL}/movies/search?s=${term}`);
  
  const items = extractItems(html);
  kino.log(`search: ${html.length} bytes, ${items.length} items extraídos`);
  
  return items;
}

// --- EPISODES ---
export async function episodes(ref) {
  kino.log(`Cargando ficha: ${ref}`);
  const html = await getHtml(ref);
  if (!html) throw kino.error("not_found", "No se pudo cargar la página de la película.");

  const metadata = {};
  const descMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
  if (descMatch) metadata.overview = descMatch[1].trim();

  const imgMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (imgMatch) {
    metadata.poster = imgMatch[1];
    metadata.backdrop = imgMatch[1].replace("/w500/", "/w1280/");
  }

  return { 
    movie: metadata, 
    overview: metadata.overview || "", 
    episodes: [{ season: 1, number: 1, ref: ref, title: "Reproducir", overview: metadata.overview || "" }] 
  };
}

// --- RESOLVE ---
export async function resolve(ref) {
  kino.log(`Resolviendo video para: ${ref}`);
  const visited = new Set();
  const allStreams = [];

  // Función interna para escarbar iframes. Usa fetch porque los iframes externos 
  // (Voe, Streamwish, etc.) generalmente no tienen el Cloudflare de la página principal.
  async function extractVideo(url, referer, depth, customLabel) {
    if (depth > 3 || visited.has(url)) return; 
    visited.add(url);
    if (url.startsWith("//")) url = "https:" + url;

    const currentOrigin = url.match(/^(https?:\/\/[^\/]+)/i)?.[1] || url;
    const reqHeaders = { "User-Agent": UA, "Referer": referer };
    const hostName = customLabel || new URL(currentOrigin).hostname.replace('www.', '');

    try {
      const res = await kino.fetch(url, { headers: reqHeaders, timeoutMs: 10000 });
      if (!res.ok) return;
      const html = await res.text();

      let streamUrl = null;
      const m = html.match(/(?:file|src|url)["']?\s*:\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4|mpd)[^"']*)["']/i) || 
                html.match(/https?:\/\/[^\s"'\\<>]+?\.(?:m3u8|mp4|mpd)(?:\?[^\s"'\\<>]*)?/i);
      if (m) streamUrl = m[1] || m[0];

      if (!streamUrl) {
        const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
        if (scripts) {
          for (const s of scripts) {
            const packerMatch = s.match(/eval\((function\(p,a,c,k,e,d\)[\s\S]+)\)/);
            if (packerMatch) {
              try {
                const unpackedCode = new Function("return (" + packerMatch[1] + ");")();
                const um = unpackedCode.match(/https?:\/\/[^\s"'\\<>]+?\.(?:m3u8|mp4|mpd)/i);
                if (um) { streamUrl = um[0]; break; }
              } catch (err) {}
            }
          }
        }
      }

      if (streamUrl) {
        kino.log(`Video encontrado en: ${hostName}`);
        allStreams.push({ label: hostName, url: streamUrl, headers: { "User-Agent": UA, "Referer": currentOrigin + "/", "Origin": currentOrigin } });
        return; 
      }

      const iframeRegex = /<iframe[^>]+src=["'](http[^"']+)["']/gi;
      let im;
      while ((im = iframeRegex.exec(html)) !== null) {
        await extractVideo(im[1].replace(/&amp;/g, "&"), currentOrigin + "/", depth + 1, customLabel);
      }
    } catch (e) {}
  }

  // 1. Cargamos el HTML principal usando getHtml (que usa el WebView si hay Cloudflare)
  const mainHtml = await getHtml(ref);
  if (!mainHtml) throw kino.error("unavailable", "No se pudo cargar la página del reproductor.");

  // 2. Extraemos iframes de la página principal
  const iframeRegex = /<iframe[^>]+src=["'](http[^"']+)["']/gi;
  let match;
  while ((match = iframeRegex.exec(mainHtml)) !== null) {
    await extractVideo(match[1].replace(/&amp;/g, "&"), ref, 1, null);
  }

  // 3. Extraemos botones de servidores de la página principal
  const dataRegex = /data-(?:url|server|video|link)=["'](http[^"']+)["']/gi;
  while ((match = dataRegex.exec(mainHtml)) !== null) {
    await extractVideo(match[1].replace(/&amp;/g, "&"), ref, 1, null);
  }

  // 4. Si logramos extraer videos, construimos la respuesta con el menú HQ
  if (allStreams.length > 0) {
    const primary = allStreams[0];
    const finalResponse = { url: primary.url, headers: primary.headers };
    if (allStreams.length > 1) {
      finalResponse.alternatives = allStreams.slice(1).map(s => ({ label: s.label, url: s.url, headers: s.headers }));
    }
    return finalResponse;
  }

  throw kino.error("unavailable", "No se encontraron servidores reproducibles.");
}