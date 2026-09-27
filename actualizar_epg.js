const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const zlib = require('zlib');

// Rutas principales del proyecto
const RUTA_CATALOGO = './catalog/tv/mogo-canales.json';
const CARPETA_META = './meta/tv';

// Caché para no repetir descargas de la misma EPG
const epgCache = {};

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
    actual: { titulo: "Sin información de programa", descripcion: "" }, 
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
      if (i + 1 < programas.length) {
        siguiente = programas[i + 1];
      }
      break;
    }
  }

  return {
    actual: actual || { titulo: "Sin información de programa", descripcion: "" },
    siguiente
  };
}

async function procesarTodo() {
  try {
    // 1. Asegurar que exista la carpeta meta/tv/
    if (!fs.existsSync(CARPETA_META)) {
      fs.mkdirSync(CARPETA_META, { recursive: true });
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

      // Construir la sección de "EN VIVO AHORA"
      let infoPrograma = actual.descripcion 
        ? `EN VIVO AHORA: ${actual.titulo}\n${actual.descripcion}`
        : `EN VIVO AHORA: ${actual.titulo}`;

      // Agregar la línea de "A CONTINUACIÓN" si existe un programa siguiente
      if (siguiente) {
        infoPrograma += `\n\nA CONTINUACIÓN: ${siguiente.titulo}`;
        if (siguiente.descripcion) {
          infoPrograma += `\n${siguiente.descripcion}`;
        }
      }

      // Limpieza de descripciones previas para evitar acumulación
      if (!meta.descriptionBase) {
        meta.descriptionBase = meta.description 
          ? meta.description
              .replace(/^EN VIVO AHORA:[\s\S]*?(?=\n\n[^\n]|\n\n$\vert{}$)/, '')
              .replace(/^A CONTINUACIÓN:[\s\S]*?(?=\n\n[^\n]|\n\n$\vert{}$)/, '')
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
      console.log(`   └─ Archivo generado: ${rutaMetaIndividual}`);
    }

    // 4. Guardar el catálogo principal actualizado
    fs.writeFileSync(RUTA_CATALOGO, JSON.stringify(json, null, 2), 'utf8');
    console.log('✅ Catálogo y archivos meta individuales actualizados con éxito.');

  } catch (error) {
    console.error('Error procesando el flujo:', error.message);
    process.exit(1);
  }
}

procesarTodo();
