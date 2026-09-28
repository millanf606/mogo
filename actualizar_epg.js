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
  const programasRaw = xmlResult.tv.programme.filter(p => p.$ && p.$.channel === tvgId);

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

  // 3. Buscar el programa actual y el siguiente (diferente)
  let actual = null;
  let siguiente = null;

  for (let i = 0; i < programas.length; i++) {
    const p = programas[i];
    if (ahora >= p.inicio && ahora < p.fin) {
      actual = p;
      
      // Buscar el siguiente programa que NO tenga la misma descripción (o título)
      for (let j = i + 1; j < programas.length; j++) {
        const cand = programas[j];
        // Compara tanto descripción como título para descartar duplicados de EPG
        if (cand.descripcion !== actual.descripcion || cand.titulo !== actual.titulo) {
          siguiente = cand;
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
