const fs = require('fs');
const path = require('path');

// Rutas de carpetas de entrada y salida
const SOURCE_DIR = path.join(__dirname, 'source');
const CATALOG_DIR = path.join(__dirname, 'catalog', 'tv');
const STREAMS_DIR = path.join(__dirname, 'stream', 'tv');

/**
 * Función para limpiar el nombre del canal eliminando puntos al final de las palabras/nombre.
 * Ejemplo: "HBO 2." -> "HBO 2", "Jr." -> "Jr"
 */
function cleanChannelName(name) {
  if (!name) return "";
  return name.trim().replace(/\.+$/, '');
}

/**
 * Normaliza el nombre del canal para generar un ID apto para URL/Slug:
 * - Convierte a minúsculas.
 * - Quita tildes/caracteres especiales.
 * - Reemplaza espacios y caracteres no alfanuméricos por guiones.
 */
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD') // Separa caracteres de sus tildes
    .replace(/[\u0300-\u036f]/g, '') // Elimina tildes
    .replace(/[^a-z0-9]+/g, '-') // Reemplaza espacios y símbolos por '-'
    .replace(/^-+|-+$/g, ''); // Elimina guiones al principio o al final
}

function parseM3U(m3uContent) {
  const lines = m3uContent.split(/\r?\n/);
  
  // Extraer epgUrl desde #EXTM3U url-tvg="..."
  let epgUrl = "";
  const headerMatch = m3uContent.match(/url-tvg="([^"]+)"/i);
  if (headerMatch) {
    epgUrl = headerMatch[1];
  }

  const metas = [];
  const streams = [];

  let currentExtInf = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF:')) {
      // Extraer parámetros con expresiones regulares
      const groupTitleMatch = line.match(/group-title="([^"]+)"/i);
      const tvgLogoMatch = line.match(/tvg-logo="([^"]+)"/i);
      const tvgIdMatch = line.match(/tvg-id="([^"]+)"/i);

      // El nombre del canal está después de la última coma en la línea #EXTINF
      const commaIndex = line.lastIndexOf(',');
      let rawChannelName = commaIndex !== -1 ? line.substring(commaIndex + 1) : "";
      
      // Aplicar regla: quitar puntos al final
      const channelName = cleanChannelName(rawChannelName);

      currentExtInf = {
        groupTitle: groupTitleMatch ? groupTitleMatch[1] : "",
        tvgLogo: tvgLogoMatch ? tvgLogoMatch[1] : "",
        tvgId: tvgIdMatch ? tvgIdMatch[1] : "",
        channelName: channelName
      };
    } else if (line.startsWith('http://') || line.startsWith('https://')) {
      if (currentExtInf) {
        const channelSlug = slugify(currentExtInf.channelName);
        const channelId = `mogo-canal-canal-${channelSlug}`;

        // Reemplazar '_stm' por '_m' en el logo para generar el poster
        let posterUrl = currentExtInf.tvgLogo;
        let logoUrl = currentExtInf.tvgLogo;

        if (logoUrl.includes('_stm')) {
          posterUrl = logoUrl.replace('_stm', '_m');
        }

        // Estructura 1: Catálogo de Metas
        const metaItem = {
          id: channelId,
          type: "tv",
          name: currentExtInf.channelName,
          poster: posterUrl,
          logo: logoUrl,
          background: "https://raw.githubusercontent.com/millanf606/mogo/refs/heads/main/fondo/fondo-canales.png",
          posterShape: "poster",
          genres: currentExtInf.groupTitle ? [currentExtInf.groupTitle] : [],
          description: "",
          epgUrl: epgUrl,
          tvgId: currentExtInf.tvgId,
          currentProgram: "",
          currentProgramDesc: "",
          descriptionBase: `Canal ${currentExtInf.channelName}`
        };

        // Estructura 2: Streams individual por canal
        const streamUrl = line.endsWith('?hls') ? line : `${line}?hls`;
        const streamData = {
          id: channelId,
          json: {
            streams: [
              {
                title: currentExtInf.channelName,
                url: streamUrl
              }
            ]
          }
        };

        metas.push(metaItem);
        streams.push(streamData);

        // Reiniciar temporal para el siguiente canal
        currentExtInf = null;
      }
    }
  }

  // Objeto Primer Código (Metas)
  const catalogJson = {
    metas: metas,
    cacheMaxAge: 0,
    staleRevalidate: 0,
    staleError: 0
  };

  return { catalogJson, streams };
}

function processSourceFiles() {
  // Verificar si la carpeta /source existe
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`Error: La carpeta '${SOURCE_DIR}' no existe. Por favor créala y coloca dentro tu archivo .m3u o .m3u8.`);
    return;
  }

  // Crear carpetas de salida si no existen
  if (!fs.existsSync(CATALOG_DIR)) {
    fs.mkdirSync(CATALOG_DIR, { recursive: true });
  }

  if (!fs.existsSync(STREAMS_DIR)) {
    fs.mkdirSync(STREAMS_DIR, { recursive: true });
  }

  // Buscar archivos .m3u o .m3u8 en la carpeta source
  const files = fs.readdirSync(SOURCE_DIR).filter(file => file.endsWith('.m3u') || file.endsWith('.m3u8'));

  if (files.length === 0) {
    console.warn(`No se encontraron archivos .m3u o .m3u8 en la carpeta '${SOURCE_DIR}'.`);
    return;
  }

  // Tomar el primer archivo M3U encontrado
  const sourceFilePath = path.join(SOURCE_DIR, files[0]);
  console.log(`Leyendo archivo: ${sourceFilePath}`);

  const m3uContent = fs.readFileSync(sourceFilePath, 'utf-8');

  // Procesar el contenido M3U
  const { catalogJson, streams } = parseM3U(m3uContent);

  // 1. Guardar el catálogo principal (mogo-canales.json)
  const catalogFilePath = path.join(CATALOG_DIR, 'mogo-canales.json');
  fs.writeFileSync(catalogFilePath, JSON.stringify(catalogJson, null, 2), 'utf-8');
  console.log(`- Catálogo generado/actualizado: ${catalogFilePath}`);

  // 2. Guardar un archivo .json de stream por cada canal (omitiendo si ya existe)
  let createdCount = 0;
  let skippedCount = 0;

  streams.forEach(streamItem => {
    const streamFilePath = path.join(STREAMS_DIR, `${streamItem.id}.json`);

    // Validación de existencia antes de guardar
    if (fs.existsSync(streamFilePath)) {
      console.log(`[Omitido] Ya existe: ${streamItem.id}.json`);
      skippedCount++;
    } else {
      fs.writeFileSync(streamFilePath, JSON.stringify(streamItem.json, null, 2), 'utf-8');
      createdCount++;
    }
  });

  console.log(`\nResumen de procesamiento:`);
  console.log(`- Archivos de stream creados: ${createdCount}`);
  console.log(`- Archivos de stream omitidos (ya existían): ${skippedCount}`);
  console.log("¡Proceso completado exitosamente!");
}

// Ejecutar proceso
processSourceFiles();
