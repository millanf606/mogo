const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const zlib = require('zlib');

// Importamos la función desde convertidor.js
const { processSourceFiles } = require('./convertidor');

// Variable de control
const update = true;

// Ejecución condicional
if (update) {
  console.log("Iniciando actualización...");
  processSourceFiles();
} else {
  console.log("Actualización deshabilitada (update = false).");
}

// Clave API de TMDb y URL de imagen por defecto
const TMDB_API_KEY = "7a2b393f2c3bce74038c6ea37a9f3abd";
const FONDO_POR_DEFECTO = "https://raw.githubusercontent.com/millanf606/mogo/refs/heads/main/fondo/fondo-canales.png";

// Variable para el desfasaje UTC (se le restan 4 horas a la hora UTC de la EPG)
const UTC = 4;

// Rutas principales del proyecto
const RUTA_CATALOGO = './catalog/tv/mogo-canales.json';
const CARPETA_SUB_CATALOGO = './catalog/tv/mogo-canales';
const RUTA_ACTUALIZAR_JSON = path.join(CARPETA_SUB_CATALOGO, 'genre=Actualizar.json');
const RUTA_TODOS_JSON = path.join(CARPETA_SUB_CATALOGO, 'genre=Todos.json');
const CARPETA_META = './meta/tv';
const RUTA_MANIFEST = './manifest.json'; // Ruta al manifest del addon

// Cachés para optimizar rendimiento
const epgCache = {};
const tmdbCache = {};

// Función auxiliar para obtener la hora ajustada con la variable UTC en formato 24h (HH:mm)
function obtenerHoraHHMM(fecha) {
  if (!fecha || !(fecha instanceof Date) || isNaN(fecha)) return '';
  
  const fechaAjustada = new Date(fecha.getTime());
  fechaAjustada.setUTCHours(fechaAjustada.getUTCHours() - UTC);

  const horas = String(fechaAjustada.getUTCHours()).padStart(2, '0');
  const minutos = String(fechaAjustada.getUTCMinutes()).padStart(2, '0');
  return `${horas}:${minutos}`;
}

/**
 * Incrementa automáticamente la versión patch (x.y.Z -> x.y.Z+1) en manifest.json
 * para forzar a Stremio a refrescar la caché del catálogo en GitHub Pages.
 */
function incrementarVersionManifest() {
  try {
    if (!fs.existsSync(RUTA_MANIFEST)) {
      console.warn(`⚠️ No se encontró el archivo ${RUTA_MANIFEST}. Omitiendo incremento de versión.`);
      return;
    }

    const manifestData = JSON.parse(fs.readFileSync(RUTA_MANIFEST, 'utf8'));
    if (!manifestData.version) {
      manifestData.version = "1.0.0";
    }

    const partes = manifestData.version.split('.').map(n => parseInt(n, 10) || 0);
    while (partes.length < 3) partes.push(0);

    // Incrementa la versión patch
    partes[2] += 1;
    manifestData.version = partes.join('.');

    fs.writeFileSync(RUTA_MANIFEST, JSON.stringify(manifestData, null, 2), 'utf8');
    console.log(`📌 Versión del manifest actualizada automáticamente a: ${manifestData.version}`);
  } catch (error) {
    console.error('Error al actualizar la versión del manifest:', error.message);
  }
}

/**
 * Busca la imagen de fondo (backdrop) en TMDb según el título.
 * Si no encuentra resultado o no hay backdrop, retorna FONDO_POR_DEFECTO.
 */
async function obtenerFondoTMDB(titulo) {
  if (!titulo || titulo.trim() === "" || titulo === "Sin información de programa" || titulo === "Programa sin título") {
    return FONDO_POR_DEFECTO;
  }

  const tituloLimpio = titulo.trim();

  // Revisar en caché previa
  if (tmdbCache[tituloLimpio]) {
    return tmdbCache[tituloLimpio];
  }

  try {
    // Usamos 'multi' para buscar simultáneamente en películas y series (tv)
    const url = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(tituloLimpio)}&language=es-ES`;
    const response = await axios.get(url, { timeout: 10000 });
    const resultados = response.data?.results || [];

    // Filtrar el primer resultado que tenga 'backdrop_path'
    const coincide = resultados.find(item => item.backdrop_path && (item.media_type === 'movie' || item.media_type === 'tv'));

    if (coincide && coincide.backdrop_path) {
      const fondoUrl = `https://image.tmdb.org/t/p/w1280${coincide.backdrop_path}`;
      tmdbCache[tituloLimpio] = fondoUrl;
      return fondoUrl;
    }
  } catch (error) {
    console.error(`Error buscando fondo en TMDb para "${tituloLimpio}":`, error.message);
  }

  // Si no se encuentra o falla la API, guardamos y retornamos la imagen por defecto
  tmdbCache[tituloLimpio] = FONDO_POR_DEFECTO;
  return FONDO_POR_DEFECTO;
}

async function descargarYParsearEPG(epgUrl) {
  if (epgCache[epgUrl]) {
    return epgCache[epgUrl];
  }

  try {
    console.log(`Descargando EPG desde: ${epgUrl}`);

    const response = await axios.get(epgUrl, {
      responseType: 'arraybuffer',
      headers: {
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 25000
    });

    let buffer = response.data;
    if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
      buffer = zlib.gunzipSync(buffer);
    } else {
      try {
        buffer = zlib.inflateSync(buffer);
      } catch (e) {}
    }

    const xmlText = buffer.toString('utf8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlText);
    
    epgCache[epgUrl] = result;
    return result;
  } catch (error) {
    console.error(`Error al descargar EPG (${epgUrl}):`, error.message);
    return null;
  }
}

function parsearFechaXMLTV(str) {
  if (!str || str.length < 12) return null;
  const y = parseInt(str.substring(0, 4), 10);
  const m = parseInt(str.substring(4, 6), 10) - 1;
  const d = parseInt(str.substring(6, 8), 10);
  const h = parseInt(str.substring(8, 10), 10);
  const min = parseInt(str.substring(10, 12), 10);
  return new Date(Date.UTC(y, m, d, h, min));
}

function buscarProgramas(xmlResult, tvgId) {
  const vacio = { 
    actual: { titulo: "Sin información de programa", descripcion: "", inicio: null }, 
    siguiente: null 
  };

  if (!xmlResult || !xmlResult.tv || !xmlResult.tv.programme) {
    return vacio;
  }

  const ahora = new Date();

  // 1. Filtrar programas de este canal
  const programasRaw = xmlResult.tv.programme.filter(p => p.$&& p.$.channel === tvgId);

  // 2. Mapear y ordenar cronológicamente
  const programas = programasRaw.map(prog => {
    let titulo = prog.title ? prog.title[0] : "Programa sin título";
    if (typeof titulo === 'object') titulo = titulo._ || titulo;

    let descripcion = "";
    if (prog.desc && prog.desc[0]) {
      descripcion = typeof prog.desc[0] === 'object' ? (prog.desc[0]._ || '') : prog.desc[0];
    }

    return {
      titulo,
      descripcion,
      inicio: parsearFechaXMLTV(prog.$.start),
      fin: parsearFechaXMLTV(prog.$.stop)
    };
  })
  .filter(p => p.inicio && p.fin)
  .sort((a, b) => a.inicio - b.inicio);

  // 3. Buscar el programa actual y el siguiente
  let actual = null;
  let siguiente = null;

  for (let i = 0; i < programas.length; i++) {
    const p = programas[i];
    if (ahora >= p.inicio && ahora < p.fin) {
      actual = p;

      for (let j = i + 1; j < programas.length; j++) {
        const candidato = programas[j];
        if (candidato.descripcion !== actual.descripcion || candidato.titulo !== actual.titulo) {
          siguiente = candidato;
          break;
        }
      }
      break;
    }
  }

  return {
    actual: actual || { titulo: "Sin información de programa", descripcion: "", inicio: null },
    siguiente
  };
}

async function procesarTodo() {
  try {
    // 1. Asegurar que existan las carpetas necesarias
    if (!fs.existsSync(CARPETA_META)) {
      fs.mkdirSync(CARPETA_META, { recursive: true });
    }
    if (!fs.existsSync(CARPETA_SUB_CATALOGO)) {
      fs.mkdirSync(CARPETA_SUB_CATALOGO, { recursive: true });
    }

    // 2. Leer el catálogo único principal
    const dataRaw = fs.readFileSync(RUTA_CATALOGO, 'utf8');
    const json = JSON.parse(dataRaw);
    const listaCanales = Array.isArray(json) ? json : (json.metas || json.channels || []);

    if (listaCanales.length === 0) {
      console.log("No se encontraron canales en el catálogo.");
      return;
    }

    console.log(`Procesando ${listaCanales.length} canales...`);

    for (const meta of listaCanales) {
      if (!meta.epgUrl || !meta.tvgId) {
        console.log(`Canal "${meta.name || meta.id}" omitido (falta epgUrl o tvgId).`);
        continue;
      }

      // Descargar EPG y obtener datos del programa actual y siguiente
      const xmlData = await descargarYParsearEPG(meta.epgUrl);
      const { actual, siguiente } = buscarProgramas(xmlData, meta.tvgId);

      console.log(`[${meta.name}] -> Actual: ${actual.titulo} | Siguiente: ${siguiente ? siguiente.titulo : 'N/A'}`);

      // Actualizar campos de programa actual
      meta.currentProgram = actual.titulo;
      meta.currentProgramDesc = actual.descripcion;

      // --- BÚSQUEDA Y ASIGNACIÓN DEL FONDO (BACKGROUND) ---
      meta.background = await obtenerFondoTMDB(actual.titulo);

      // Obtener horas formateadas restándole la variable UTC
      const horaActual = obtenerHoraHHMM(actual.inicio);
      const prefixActual = horaActual ? `${horaActual} │ ` : '';

      // Construir la sección de "EN VIVO AHORA"
      let infoPrograma = actual.descripcion 
        ? `${prefixActual}EN VIVO AHORA: ${actual.titulo}\n${actual.descripcion}`
        : `${prefixActual}EN VIVO AHORA: ${actual.titulo}`;

      // Agregar la línea de "A CONTINUACIÓN" si existe un programa siguiente
      if (siguiente) {
        const horaSiguiente = obtenerHoraHHMM(siguiente.inicio);
        const prefixSiguiente = horaSiguiente ? `${horaSiguiente} │ ` : '';

        infoPrograma += `\n\n${prefixSiguiente}A CONTINUACIÓN: ${siguiente.titulo}`;
        if (siguiente.descripcion) {
          infoPrograma += `\n${siguiente.descripcion}`;
        }
      }

      // Limpieza de descripciones previas para evitar acumulación
      if (!meta.descriptionBase) {
        meta.descriptionBase = meta.description 
          ? meta.description
              .replace(/^(?:\d{2}:\d{2}\s*-\s*)?EN VIVO AHORA:[\s\S]*?(?=\n\n[^\n]|\n\n$)/, '')
              .replace(/^(?:\d{2}:\d{2}\s*-\s*)?A CONTINUACIÓN:[\s\S]*?(?=\n\n[^\n]|\n\n$)/, '')
              .trim()
          : `Canal ${meta.name}`;
      }

      meta.description = `${infoPrograma}\n\n${meta.descriptionBase}`;

      // 3. Generar dinámicamente el archivo individual dentro de meta/tv/{id}.json
      const rutaMetaIndividual = path.join(CARPETA_META, `${meta.id}.json`);
      const contenidoMetaIndividual = {
        meta: {
          id: meta.id,
          type: meta.type || "tv",
          name: meta.name,
          poster: meta.poster,
          logo: meta.logo,
          background: meta.background,
          posterShape: meta.posterShape || "poster",
          genres: meta.genres || [],
          description: meta.description
        }
      };

      fs.writeFileSync(rutaMetaIndividual, JSON.stringify(contenidoMetaIndividual, null, 2), 'utf8');
      console.log(`    └─ Archivo generado: ${rutaMetaIndividual} (Fondo: ${meta.background})`);
    }

    // 4. Formatear la estructura final con directivas estrictas anti-caché para Stremio
    const catalogoFinal = {
      metas: listaCanales,
      cacheMaxAge: 0,
      staleRevalidate: 0,
      staleError: 0
    };

    // Guardar catálogo principal
    fs.writeFileSync(RUTA_CATALOGO, JSON.stringify(catalogoFinal, null, 2), 'utf8');
    
    // 5. Generar copias exactas en la subcarpeta requeridas por la opción "extra"
    fs.writeFileSync(RUTA_ACTUALIZAR_JSON, JSON.stringify(catalogoFinal, null, 2), 'utf8');
    fs.writeFileSync(RUTA_TODOS_JSON, JSON.stringify(catalogoFinal, null, 2), 'utf8');
    console.log(`📁 Archivos del catálogo creados con éxito:
      - ${RUTA_CATALOGO}
      - ${RUTA_ACTUALIZAR_JSON}
      - ${RUTA_TODOS_JSON}`);

    // 6. Incrementar la versión del manifest para forzar refresco en Stremio
    incrementarVersionManifest();

    console.log('✅ Catálogo, metas, subcarpetas extra e incremento de versión completados con éxito.');

  } catch (error) {
    console.error('Error procesando el flujo:', error.message);
    process.exit(1);
  }
}

procesarTodo();
