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
function extractItems(html) {
  const items = [];
  const vistos = new Set();
  
  // Busca cualquier enlace a pelicula, serie o anime de forma flexible
  const aRegex = /<a[^>]+href=["']([^"']+(?:\/pelicula\/|\/serie\/|\/anime\/)[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  
  while ((match = aRegex.exec(html)) !== null) {
    let link = match[1];
    let inner = match[2];

    if (vistos.has(link)) continue;
    
    let imgMatch = inner.match(/<img[^>]+(?:src|data-src|data-lazy)=["']([^"']+)["']/i);
    // Busca el título en h2, h3, alt o title
    let titleMatch = inner.match(/<h[2-6][^>]*>([^<]+)<\/h[2-6]>/i) || 
                     inner.match(/alt=["']([^"']+)["']/i) || 
                     inner.match(/title=["']([^"']+)["']/i);
    
    if (imgMatch && titleMatch) {
      vistos.add(link);
      let img = imgMatch[1];
      if (!img.startsWith('http')) img = `https://image.tmdb.org/t/p/w500/${img.replace(/^\//, '')}`;

      const fullLink = link.startsWith("http") ? link : `${BASE_URL}${link}`;
      
      let cleanTitle = titleMatch[1].replace(/<[^>]+>/g, "").trim();
      cleanTitle = cleanTitle.replace(/^Ver (Película|Serie) /i, "").trim();

      items.push({
        id: "pjcom-" + link.split('/').pop(),
        ref: fullLink,
        title: cleanTitle,
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
  kino.log(`Descargando catálogo desde home.php...`);
  
  // Usamos getHtml apuntando directamente al archivo que no pide apodo
  const html = await getHtml(`${BASE_URL}/movies/home.php`);
  
  if (!html || html.length < 50000) {
    kino.log(`El HTML es muy corto o falló (${html ? html.length : 0} bytes).`);
    return [];
  }

  const categories = [];

  // 1. Extraer "Películas Estrenos"
  const bloqueEstrenos = html.split(/Pel[ií]culas Estrenos/i)[1]?.split(/Top Series/i)[0] || "";
  const itemsEstrenos = extractItems(bloqueEstrenos);
  
  if (itemsEstrenos.length > 0) {
    categories.push({ 
      id: "h-estrenos", 
      title: "Películas Estrenos", 
      ref: "peliculas", 
      items: itemsEstrenos 
    });
  }

  // 2. Extraer "Top Series"
  const bloqueTopSeries = html.split(/Top Series/i)[1]?.split(/Pel[ií]culas m[aá]s vistas/i)[0] || "";
  const itemsTopSeries = extractItems(bloqueTopSeries);
  
  if (itemsTopSeries.length > 0) {
    categories.push({ 
      id: "h-topseries", 
      title: "Top Series", 
      ref: "series", 
      items: itemsTopSeries 
    });
  }

  // PLAN B: Si los recortes fallan porque la página cambió una letra, mostramos todo
  if (categories.length === 0) {
    kino.log("No se encontraron las secciones exactas. Mostrando catálogo completo...");
    const todosLosItems = extractItems(html);
    if (todosLosItems.length > 0) {
      categories.push({ id: "h-todo", title: "Catálogo", ref: "peliculas", items: todosLosItems });
    }
  }

  kino.log(`Home cargado: ${itemsEstrenos.length} estrenos, ${itemsTopSeries.length} top series.`);
  return categories;
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

export async function resolve(ref) {
  kino.log(`Resolviendo video para: ${ref}`);
  const visited = new Set();
  const allStreams = [];

  async function extractVideo(url, referer, depth, customLabel) {
    if (depth > 3 || visited.has(url)) return; 
    visited.add(url);
    if (url.startsWith("//")) url = "https:" + url;

    const currentOrigin = url.match(/^(https?:\/\/[^\/]+)/i)?.[1] || url;
    const reqHeaders = { "User-Agent": UA, "Referer": referer };
    const hostName = customLabel || new URL(currentOrigin).hostname.replace('www.', '');

    try {
      let html = "";
      // Si el iframe es del mismo pelisjuanita, usamos getHtml para evadir Cloudflare
      if (url.includes("pelisjuanita.com")) {
        html = await getHtml(url, referer);
      } else {
        const res = await kino.fetch(url, { headers: reqHeaders, timeoutMs: 10000 });
        if (res.ok) html = await res.text();
      }

      if (!html) return;

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

  //const mainHtml = await getHtml(ref);
  //if (!mainHtml) throw kino.error("unavailable", "No se pudo cargar la página del reproductor.");
// Dentro de tu función resolve...
  const mainHtml = await getHtml(ref);
  if (!mainHtml) throw kino.error("unavailable", "No se pudo cargar la página del reproductor.");
  const iframeRegex = /<iframe[^>]+src=["'](http[^"']+)["']/gi;
  let match;
  while ((match = iframeRegex.exec(mainHtml)) !== null) {
    await extractVideo(match[1].replace(/&amp;/g, "&"), ref, 1, null);
  }

  const dataRegex = /data-(?:url|server|video|link)=["'](http[^"']+)["']/gi;
  while ((match = dataRegex.exec(mainHtml)) !== null) {
    await extractVideo(match[1].replace(/&amp;/g, "&"), ref, 1, null);
  }

  if (allStreams.length > 0) {
    const primary = allStreams[0];
    const finalResponse = { url: primary.url, headers: primary.headers };
    if (allStreams.length > 1) {
      finalResponse.alternatives = allStreams.slice(1).map(s => ({ label: s.label, url: s.url, headers: s.headers }));
    }
    return finalResponse;
  }

  // PLAN B: Interceptar red si el video carga por JavaScript dinámico
  kino.log("Extracción estática falló. Intentando kino.browser.capture...");
  try {
    const page = await kino.browser.capture(ref, { timeoutMs: 25000 });
    if (page && page.media && page.media.length > 0) {
      const validMedia = page.media.find(m => m.url.includes('.m3u8') || m.url.includes('.mp4')) || page.media[0];
      kino.log(`Video interceptado con capture.`);
      return { url: validMedia.url, headers: validMedia.headers || { "User-Agent": UA, "Referer": ref } };
    }
  } catch (err) {
    kino.log(`Fallo en capture: ${err.message}`);
  }

  throw kino.error("unavailable", "No se encontraron servidores reproducibles.");
}