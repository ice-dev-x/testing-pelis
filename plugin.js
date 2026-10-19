export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_URL = "https://pelisjuanita.com";
let hasAccess = false;

// --- 1. BYPASS DE SEGURIDAD (Dependiendo del gestor nativo de Kino) ---
async function ensureAccess() {
  if (hasAccess) return;
  
  let apodoStr = "KinoUser";
  try { apodoStr = kino.config.get("apodo_usuario") || "KinoUser"; } catch(e) {}
  
  try {
    kino.log(`Autorizando apodo en el servidor: ${apodoStr}`);
    
    // Al usar Kino en Android, la app guardará la cookie de sesión automáticamente al hacer POST
    const res = await kino.fetch(`${BASE_URL}/inicio.php`, {
      method: "POST",
      headers: { 
        "User-Agent": UA, 
        "Content-Type": "application/x-www-form-urlencoded", 
        "Referer": `${BASE_URL}/inicio.php`,
        "Origin": BASE_URL
      },
      body: `apodo=${encodeURIComponent(apodoStr)}`
    });
    
    kino.log(`Status de Bypass: ${res.status}`);
    hasAccess = true;
  } catch (error) {
    kino.log(`Error en bypass: ${error.message}`);
  }
}

// --- GENERADOR DE CABECERAS ---
function getHeaders(isAjax = false) {
  const h = { 
    "User-Agent": UA, 
    "Referer": `${BASE_URL}/movies/` 
  };
  if (isAjax) h["X-Requested-With"] = "XMLHttpRequest";
  return h;
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

// --- 2. HOME ---
export async function home() {
  await ensureAccess();
  kino.log(`Descargando catálogo desde: ${BASE_URL}/movies/home.php`);
  
  let res = await kino.fetch(`${BASE_URL}/movies/home.php`, { headers: getHeaders(true) });
  
  if (!res.ok || res.status === 403) {
    kino.log(`Fallo AJAX, intentando Plan B: Cargar página principal /movies/...`);
    res = await kino.fetch(`${BASE_URL}/movies/`, { headers: getHeaders(false) });
  }
  
  if (!res.ok) return [];
  const html = await res.text();
  const items = extractItems(html);
  
  if (items.length === 0) return [];
  return [{ id: "h-recientes", title: "Catálogo PelisJuanita (.com)", ref: "inicio", items }];
}

// --- 3. SEARCH ---
export async function search(query) {
  await ensureAccess();
  if (!query || !query.q) return [];
  const term = encodeURIComponent(query.q);
  
  const res = await kino.fetch(`${BASE_URL}/movies/search?s=${term}`, { headers: getHeaders(false) });
  if (!res.ok) return [];
  
  return extractItems(await res.text());
}

// --- 4. EPISODES ---
export async function episodes(ref) {
  await ensureAccess();
  const res = await kino.fetch(ref, { headers: getHeaders(false) });
  if (!res.ok) throw kino.error("not_found", "No se pudo cargar la página");
  const html = await res.text();

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

// --- 5. RESOLVE ---
export async function resolve(ref) {
  await ensureAccess();
  const visited = new Set();
  const allStreams = [];

  async function extractVideo(url, referer, depth, customLabel) {
    if (depth > 3 || visited.has(url)) return; 
    visited.add(url);
    if (url.startsWith("//")) url = "https:" + url;

    const currentOrigin = url.match(/^(https?:\/\/[^\/]+)/i)?.[1] || url;
    const reqHeaders = getHeaders();
    reqHeaders["Referer"] = referer;
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

  const res = await kino.fetch(ref, { headers: getHeaders(false) });
  if (!res.ok) throw kino.error("unavailable", "No se pudo cargar la página del reproductor.");
  const mainHtml = await res.text();

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

  throw kino.error("unavailable", "No se pudo extraer el video.");
}