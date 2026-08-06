import zlib from "zlib";

export function registrarXmlContabilidade({
  app,
  API_BELA_SHEETS,
  normalizarMes,
  somenteDigitos,
  extrairIdentificacaoXmlNfce,
  nomeArquivoXML,
  listarXmlMesRemoto,
  listarXmlPeriodoRemoto,
  listarNfceNotasRemotas,
  getNfceNotaRemota,
  extrairXmlPersistidoConferencia,
  listarNotasLocal,
  consultarSituacaoFiscalOficial
}) {
  function nomeArquivoXMLRegistro(r = {}) {
    const xml = String(r.xml || "");
    const identificacao = extrairIdentificacaoXmlNfce(xml);

    return nomeArquivoXML(
      {
        serie: identificacao.serie || r.serie,
        numero: identificacao.numero || r.numero,
        chave: identificacao.chave || r.chave
      },
      xml
    );
  }

  // ================= ZIP XML =================

  function crc32(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }

  const CRC_TABLE = (() => {
    let c;
    const table = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function dosDateTime(date) {
    const d = new Date(date);
    const year = Math.max(d.getFullYear(), 1980);
    const dosTime = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
    const dosDate = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
    return { dosTime, dosDate };
  }

  function makeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    files.forEach(file => {
      const nameBuf = Buffer.from(file.name, "utf8");
      const dataBuf = Buffer.from(file.data, "utf8");
      const compressed = zlib.deflateRawSync(dataBuf);
      const crc = crc32(dataBuf);
      const { dosTime, dosDate } = dosDateTime(file.date || new Date());

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 6);
      local.writeUInt16LE(8, 8);
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(dataBuf.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);

      locals.push(local, nameBuf, compressed);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0, 8);
      central.writeUInt16LE(8, 10);
      central.writeUInt16LE(dosTime, 12);
      central.writeUInt16LE(dosDate, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(compressed.length, 20);
      central.writeUInt32LE(dataBuf.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(offset, 42);

      centrals.push(central, nameBuf);
      offset += local.length + nameBuf.length + compressed.length;
    });

    const centralSize = centrals.reduce((s, b) => s + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, ...centrals, end]);
  }

  // ================= HELPERS DE EXPORTAÇÃO =================

  function extrairAmbienteXmlContabilidade(xml = "") {
    return String(
      String(xml || "").match(/<tpAmb>\s*([12])\s*<\/tpAmb>/i)?.[1] || ""
    );
  }

  function extrairProtocoloAutorizacaoXmlContabilidade(xml = "") {
    const texto = String(xml || "");
    const blocoProt = texto.match(/<protNFe\b[\s\S]*?<\/protNFe>/i)?.[0] || "";

    return {
      cStat: String(
        blocoProt.match(/<cStat>\s*(\d+)\s*<\/cStat>/i)?.[1] || ""
      ),
      nProt: String(
        blocoProt.match(/<nProt>\s*([^<]+)\s*<\/nProt>/i)?.[1] || ""
      ),
      tpAmb: String(
        blocoProt.match(/<tpAmb>\s*([12])\s*<\/tpAmb>/i)?.[1] || ""
      )
    };
  }

  async function confirmarAutorizacaoProducaoParaRelatorio(nota = {}, xml = "") {
    const chave = somenteDigitos(
      extrairIdentificacaoXmlNfce(xml).chave ||
      nota.chaveAcesso ||
      nota.chave ||
      ""
    );

    if (chave.length !== 44) {
      return {
        incluir: false,
        motivo: "chave_invalida",
        chave
      };
    }

    const ambienteXml = extrairAmbienteXmlContabilidade(xml);
    const protocoloXml = extrairProtocoloAutorizacaoXmlContabilidade(xml);

    // O XML comprova que a nota foi autorizada originalmente, mas não informa
    // necessariamente a situação fiscal atual. Uma nota pode ter cStat 100 no
    // protNFe e, depois, ser cancelada. Por isso a situação atual é sempre
    // confirmada diretamente na SEFAZ de produção.
    if (ambienteXml && ambienteXml !== "1") {
      return {
        incluir: false,
        motivo: "ambiente_homologacao",
        chave
      };
    }

    try {
      if (typeof consultarSituacaoFiscalOficial !== "function") {
        throw new Error(
          "Módulo de conferência fiscal não inicializado. " +
          "O XML foi excluído por segurança."
        );
      }

      const oficial = await consultarSituacaoFiscalOficial({
        chave,
        ambiente: "1"
      });

      const situacao = String(oficial.classificacao?.codigo || "");
      const cancelada =
        oficial.cancelada === true ||
        situacao === "cancelada" ||
        String(oficial.cStat || "") === "101";

      const autorizadaAtual =
        oficial.ambienteConsultado === "1" &&
        oficial.tpAmb === "1" &&
        situacao === "autorizada" &&
        String(oficial.autorizacao?.cStat || oficial.cStat || "") === "100" &&
        !!oficial.autorizacao?.nProt &&
        !cancelada;

      return {
        incluir: autorizadaAtual,
        origemConfirmacao: "sefaz_situacao_atual",
        chave,
        protocolo:
          oficial.autorizacao?.nProt ||
          protocoloXml.nProt ||
          "",
        cStat: oficial.cStat || "",
        xMotivo: oficial.xMotivo || "",
        cancelada,
        motivo: cancelada
          ? "cancelada_na_sefaz"
          : autorizadaAtual
            ? ""
            : "situacao_atual_nao_autorizada",
        oficial
      };
    } catch (e) {
      return {
        incluir: false,
        motivo: "falha_consulta_sefaz",
        chave,
        erro: e.message
      };
    }
  }

  async function filtrarArquivosContabilidade(candidatos = []) {
    const aprovados = [];
    const excluidos = [];

    for (const candidato of candidatos) {
      const confirmacao = await confirmarAutorizacaoProducaoParaRelatorio(
        candidato.nota || {},
        candidato.data || ""
      );

      if (confirmacao.incluir) {
        aprovados.push({
          name: candidato.name,
          data: candidato.data,
          date: candidato.date
        });
      } else {
        excluidos.push({
          name: candidato.name,
          chave: confirmacao.chave || "",
          motivo: confirmacao.motivo || confirmacao.xMotivo || "não autorizada em produção"
        });
      }
    }

    console.log(
      `[XML CONTABILIDADE] ${aprovados.length} atualmente autorizado(s) em produção | ` +
      `${excluidos.length} excluído(s).`
    );

    excluidos.forEach(item => {
      console.log(
        `[XML CONTABILIDADE] Excluído ${item.name} | ${item.chave} | ${item.motivo}`
      );
    });

    return aprovados;
  }

  async function obterArquivosXmlMes(mes) {
    const candidatos = [];
    const chavesExistentes = new Set();

    // 1) XML persistido no Apps Script.
    try {
      if (API_BELA_SHEETS) {
        const rows = await listarXmlMesRemoto(mes);

        for (const r of rows) {
          const xml = String(r.xml || "").trim();
          if (!xml) continue;

          const identificacao = extrairIdentificacaoXmlNfce(xml);
          const chave = somenteDigitos(identificacao.chave || r.chave || "");
          if (chave && chavesExistentes.has(chave)) continue;

          candidatos.push({
            name: nomeArquivoXMLRegistro(r),
            data: xml,
            date: r.dataEmissao || new Date().toISOString(),
            nota: {
              ...r,
              chave: chave || r.chave || ""
            }
          });

          if (chave) chavesExistentes.add(chave);
        }
      }
    } catch (e) {
      console.error("⚠ falha ao buscar XML do mês no Apps Script:", e.message);
    }

    // 2) Completa dados ausentes por nfce_notas, sem incluir rejeitadas por suposição.
    try {
      if (API_BELA_SHEETS) {
        const notas = await listarNfceNotasRemotas({ mes });

        for (const n of notas) {
          if (!n.id) continue;

          const notaCompleta = await getNfceNotaRemota(n.id);
          if (!notaCompleta) continue;

          const xmlPersistido =
            extrairXmlPersistidoConferencia(notaCompleta) ||
            notaCompleta.xml ||
            "";

          const xml = String(xmlPersistido || "").trim();
          if (!xml) continue;

          const identificacao = extrairIdentificacaoXmlNfce(xml);
          const chave = somenteDigitos(
            identificacao.chave ||
            notaCompleta.chaveAcesso ||
            notaCompleta.chave ||
            ""
          );

          if (chave && chavesExistentes.has(chave)) continue;

          candidatos.push({
            name: nomeArquivoXML(notaCompleta, xml),
            data: xml,
            date: notaCompleta.dataEmissaoIso || notaCompleta.data || new Date().toISOString(),
            nota: notaCompleta
          });

          if (chave) chavesExistentes.add(chave);
        }
      }
    } catch (e) {
      console.error("⚠ falha ao completar XML do mês via nfce_notas:", e.message);
    }

    // 3) Fallback local apenas quando não há registros remotos.
    if (!candidatos.length) {
      const lista = (await listarNotasLocal()).filter(n => n.mesRef === mes);

      for (const nota of lista) {
        const xml =
          extrairXmlPersistidoConferencia(nota) ||
          nota.xml ||
          "";

        if (!String(xml).trim()) continue;

        candidatos.push({
          name: nomeArquivoXML(nota, xml),
          data: String(xml),
          date: nota.dataEmissaoIso || nota.data || new Date().toISOString(),
          nota
        });
      }
    }

    return await filtrarArquivosContabilidade(candidatos);
  }

  async function obterArquivosXmlPeriodo(inicio, fim) {
    const candidatos = [];
    const chavesExistentes = new Set();
    const dIni = inicio ? new Date(inicio + "T00:00:00") : null;
    const dFim = fim ? new Date(fim + "T23:59:59") : null;

    try {
      if (API_BELA_SHEETS) {
        const rows = await listarXmlPeriodoRemoto(inicio, fim);

        for (const r of rows) {
          const xml = String(r.xml || "").trim();
          if (!xml) continue;

          const identificacao = extrairIdentificacaoXmlNfce(xml);
          const chave = somenteDigitos(identificacao.chave || r.chave || "");
          if (chave && chavesExistentes.has(chave)) continue;

          candidatos.push({
            name: nomeArquivoXMLRegistro(r),
            data: xml,
            date: r.dataEmissao || new Date().toISOString(),
            nota: {
              ...r,
              chave: chave || r.chave || ""
            }
          });

          if (chave) chavesExistentes.add(chave);
        }
      }
    } catch (e) {
      console.error("⚠ falha ao buscar XML do período no Apps Script:", e.message);
    }

    try {
      if (API_BELA_SHEETS) {
        const notas = await listarNfceNotasRemotas({});

        for (const n of notas) {
          const notaDate = new Date(n.data || "");
          if (dIni && notaDate < dIni) continue;
          if (dFim && notaDate > dFim) continue;
          if (!n.id) continue;

          const notaCompleta = await getNfceNotaRemota(n.id);
          if (!notaCompleta) continue;

          const xmlPersistido =
            extrairXmlPersistidoConferencia(notaCompleta) ||
            notaCompleta.xml ||
            "";

          const xml = String(xmlPersistido || "").trim();
          if (!xml) continue;

          const identificacao = extrairIdentificacaoXmlNfce(xml);
          const chave = somenteDigitos(
            identificacao.chave ||
            notaCompleta.chaveAcesso ||
            notaCompleta.chave ||
            ""
          );

          if (chave && chavesExistentes.has(chave)) continue;

          candidatos.push({
            name: nomeArquivoXML(notaCompleta, xml),
            data: xml,
            date: notaCompleta.dataEmissaoIso || notaCompleta.data || new Date().toISOString(),
            nota: notaCompleta
          });

          if (chave) chavesExistentes.add(chave);
        }
      }
    } catch (e) {
      console.error("⚠ falha ao completar XML do período via nfce_notas:", e.message);
    }

    if (!candidatos.length) {
      const lista = (await listarNotasLocal()).filter(n => {
        const d = new Date(n.dataEmissaoIso || n.data);
        if (dIni && d < dIni) return false;
        if (dFim && d > dFim) return false;
        return true;
      });

      for (const nota of lista) {
        const xml =
          extrairXmlPersistidoConferencia(nota) ||
          nota.xml ||
          "";

        if (!String(xml).trim()) continue;

        candidatos.push({
          name: nomeArquivoXML(nota, xml),
          data: String(xml),
          date: nota.dataEmissaoIso || nota.data || new Date().toISOString(),
          nota
        });
      }
    }

    return await filtrarArquivosContabilidade(candidatos);
  }

  async function responderZipMes(res, mes) {
    const files = await obterArquivosXmlMes(mes);

    if (!files.length) {
      return res.status(404).json({ ok: false, error: "Nenhum XML oficialmente autorizado em produção foi encontrado para este mês." });
    }

    const zipBuffer = makeZip(files);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="XML_CONTABILIDADE_AUTORIZADAS_PRODUCAO_${mes}.zip"`);
    return res.send(zipBuffer);
  }

  async function responderZipPeriodo(res, inicio, fim) {
    const files = await obterArquivosXmlPeriodo(inicio, fim);

    if (!files.length) {
      return res.status(404).json({ ok: false, error: "Nenhum XML oficialmente autorizado em produção foi encontrado no período." });
    }

    const zipBuffer = makeZip(files);
    const nome = `${inicio || "inicio"}_${fim || "fim"}`.replace(/\//g, "-");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="XML_CONTABILIDADE_AUTORIZADAS_PRODUCAO_${nome}.zip"`);
    return res.send(zipBuffer);
  }

  // Rotas antigas mantidas por compatibilidade.
  app.get("/nfce/xml/mes/:mes", async (req, res) => {
    const mes = String(req.params.mes || "");
    return responderZipMes(res, mes);
  });

  app.get("/nfce/xml/periodo", async (req, res) => {
    const inicio = String(req.query.inicio || "");
    const fim = String(req.query.fim || "");
    return responderZipPeriodo(res, inicio, fim);
  });

  // Rotas curtas usadas pelo aplicativo.
  app.get("/xml/mes", async (req, res) => {
    const ano = String(req.query.ano || "");
    const mes = String(req.query.mes || "");
    const mesRef = normalizarMes(ano, mes);

    if (!mesRef) {
      return res.status(400).json({
        ok: false,
        error: "Parâmetros ano/mes inválidos."
      });
    }

    return responderZipMes(res, mesRef);
  });

  app.get("/xml/periodo", async (req, res) => {
    const inicio = String(req.query.inicio || "");
    const fim = String(req.query.fim || "");

    if (!inicio || !fim) {
      return res.status(400).json({
        ok: false,
        error: "Informe inicio e fim."
      });
    }

    return responderZipPeriodo(res, inicio, fim);
  });

  return {
    responderZipMes,
    responderZipPeriodo
  };
}
