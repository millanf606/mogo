const fs = require('fs');
const path = require('path');

// Rutas de carpetas de entrada y salida
const SOURCE_DIR = path.join(__dirname, 'source');

/* Directorios 
const CATALOG_DIR = path.join(__dirname, 'catalog', 'tv');
const STREAMS_DIR = path.join(__dirname, 'stream', 'tv');
*/

/** Para pruebas */
const CATALOG_DIR = path.join(__dirname, 'test');
const STREAMS_DIR = path.join(__dirname, 'test');

/**
 * Limpia el nombre del canal eliminando puntos al final.
 */
function cleanChannelName(name) {
  if (!name) return "";
  return name.trim().replace(/\.+$/, '');
}

/**
 * Normaliza el nombre del canal para generar un ID apto para URL/Slug.
 */
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseM3U(m3uContent) {
  const lines = m3uContent.split(/\r?\n/);
  
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
      const groupTitleMatch = line.match(/group-title="([^"]+)"/i);
      const tvgLogoMatch = line.match(/tvg-logo="([^"]+)"/i);
      const tvgIdMatch = line.match(/tvg-id="([^"]+)"/i);

      const commaIndex = line.lastIndexOf(',');
      let rawChannelName = commaIndex !== -1 ? line.substring(commaIndex + 1) : "";
      
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

        let posterUrl = currentExtInf.tvgLogo;
        let logoUrl = currentExtInf.tvgLogo;

        if (logoUrl.includes('_logo')) {
          posterUrl = logoUrl.replace('_logo', '_poster');
        }

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

        currentExtInf = null;
      }
    }
  }

  return { metas, streams };
}

function processSourceFiles() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`Error: La carpeta '${SOURCE_DIR}' no existe.`);
    return;
  }

  if (!fs.existsSync(CATALOG_DIR)) {
    fs.mkdirSync(CATALOG_DIR, { recursive: true });
  }

  if (!fs.existsSync(STREAMS_DIR)) {
    fs.mkdirSync(STREAMS_DIR, { recursive: true });
  }

  const files = fs.readdirSync(SOURCE_DIR).filter(file => file.endsWith('.m3u') || file.endsWith('.m3u8'));

  if (files.length === 0) {
    console.warn(`No se encontraron archivos .m3u o .m3u8 en la carpeta '${SOURCE_DIR}'.`);
    return;
  }

  const sourceFilePath = path.join(SOURCE_DIR, files[0]);
  console.log(`Leyendo archivo M3U: ${sourceFilePath}`);

  const m3uContent = fs.readFileSync(sourceFilePath, 'utf-8');
  const { metas: parsedMetas, streams: parsedStreams } = parseM3U(m3uContent);

  const catalogFilePath = path.join(CATALOG_DIR, 'mogo-canales.json');
  let catalogData = {
    metas: [],
    cacheMaxAge: 0,
    staleRevalidate: 0,
    staleError: 0
  };

  if (fs.existsSync(catalogFilePath)) {
    try {
      const existingContent = fs.readFileSync(catalogFilePath, 'utf-8');
      catalogData = JSON.parse(existingContent);
      console.log(`- Archivo '${catalogFilePath}' encontrado. Se procesarán adiciones.`);
    } catch (err) {
      console.error(`Error al leer '${catalogFilePath}', se creará uno nuevo:`, err.message);
    }
  }

  const existingIds = new Set((catalogData.metas || []).map(item => item.id));
  let addedCatalogCount = 0;

  parsedMetas.forEach(metaItem => {
    if (!existingIds.has(metaItem.id)) {
      catalogData.metas.push(metaItem);
      existingIds.add(metaItem.id);
      addedCatalogCount++;
    }
  });

  fs.writeFileSync(catalogFilePath, JSON.stringify(catalogData, null, 2), 'utf-8');

  let createdStreamCount = 0;
  let skippedStreamCount = 0;

  parsedStreams.forEach(streamItem => {
    const streamFilePath = path.join(STREAMS_DIR, `${streamItem.id}.json`);

    if (fs.existsSync(streamFilePath)) {
      skippedStreamCount++;
    } else {
      fs.writeFileSync(streamFilePath, JSON.stringify(streamItem.json, null, 2), 'utf-8');
      createdStreamCount++;
    }
  });

  console.log(`\nResumen de ejecución:`);
  console.log(`- Canales nuevos añadidos al catálogo: ${addedCatalogCount}`);
  console.log(`- Total de canales en el catálogo: ${catalogData.metas.length}`);
  console.log(`- Nuevos archivos de stream creados: ${createdStreamCount}`);
  console.log(`- Archivos de stream omitidos (ya existían): ${skippedStreamCount}`);
  console.log("\n¡Proceso completado exitosamente!");
}

// Ejecutar proceso
/*processSourceFiles();*/

// Exportamos la función para poder usarla en otros archivos
module.exports = {
  processSourceFiles,
  parseM3U // OPCIONAL: Puedes exportar otras funciones si necesitas testearlas por separado
};
