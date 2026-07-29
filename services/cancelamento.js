import fs from "fs";
import path from "path";
import { SignedXml } from "xml-crypto";
import { DOMParser } from "xmldom";
import libxmljs from "libxmljs2";

/**
 * Serviço isolado de cancelamento da NFC-e.
 *
 * A lógica foi movida sem mudança de regra fiscal. As dependências compartilhadas
 * continuam sendo fornecidas pelo server.js para reduzir o risco de afetar a emissão.
 */
export function criarServicoCancelamento(deps) {
  const {
    NFCE_CONFIG,
    EMPRESA,
    SEFAZ_CONFIG,
    esc,
    formatarDhEmi,
    compactarXmlAntesDaAssinatura,
    carregarCertificadoFiscal,
    extrairTagXml,
    httpsPostComCertificado,
    lerNotaLocal,
    salvarNota,
    notaJaCancelada
  } = deps;

  const SCHEMAS_EVENTO_CANCELAMENTO_DIR = path.resolve("./schemas/evento-cancelamento");

  // TESTE TEMPORÁRIO EM HOMOLOGAÇÃO: habilite no Render com SEFAZ_TESTE_NSEQ_ZERO=true.
  // Nunca habilitar em produção.
  const TESTE_NSEQ_ZERO =
    String(process.env.SEFAZ_TESTE_NSEQ_ZERO || "false").toLowerCase() === "true" &&
    String(NFCE_CONFIG.tpAmb || "") === "2";

  let schemasEventoCache = null;

  function localizarSchemasEventoCancelamento() {
    if (schemasEventoCache) return schemasEventoCache;

    if (!fs.existsSync(SCHEMAS_EVENTO_CANCELAMENTO_DIR)) {
      throw new Error(`Pasta de schemas do cancelamento não encontrada: ${SCHEMAS_EVENTO_CANCELAMENTO_DIR}`);
    }

    const encontrados = [];
    const percorrer = (dir) => {
      for (const nome of fs.readdirSync(dir)) {
        const caminho = path.join(dir, nome);
        const stat = fs.statSync(caminho);
        if (stat.isDirectory()) percorrer(caminho);
        else if (nome.toLowerCase().endsWith(".xsd")) encontrados.push(caminho);
      }
    };
    percorrer(SCHEMAS_EVENTO_CANCELAMENTO_DIR);

    const achar = (nomes, contem = []) => {
      for (const nome of nomes) {
        const exato = encontrados.find(p =>
          path.basename(p).toLowerCase() === nome.toLowerCase()
        );
        if (exato) return exato;
      }

      return encontrados.find(p => {
        const nome = path.basename(p).toLowerCase();
        return contem.every(parte => nome.includes(parte.toLowerCase()));
      }) || "";
    };

    const evento = achar(
      [
        "eventoCancNFe_v1.00.xsd",
        "eventoCancNFe_v1.0.xsd",
        "eventoCancNFe.xsd"
      ],
      ["evento", "canc", "nfe"]
    );

    const envelope = achar(
      [
        "envEventoCancNFe_v1.00.xsd",
        "envEventoCancNFe_v1.0.xsd",
        "envEventoCancNFe.xsd",
        "envEvento_v1.00.xsd"
      ],
      ["env", "evento"]
    );

    schemasEventoCache = { evento, envelope };
    return schemasEventoCache;
  }

  function validarDocumentoContraSchema(xml, schemaPath, rotulo) {
    if (!schemaPath) {
      return {
        valido: null,
        ignorado: true,
        schema: "",
        erros: [`Schema ${rotulo} não encontrado em ${SCHEMAS_EVENTO_CANCELAMENTO_DIR}.`]
      };
    }

    try {
      const schemaXml = fs.readFileSync(schemaPath, "utf8");
      const schema = libxmljs.parseXml(schemaXml, {
        baseUrl: schemaPath,
        noblanks: true,
        nonet: true
      });

      const documento = libxmljs.parseXml(String(xml || ""), {
        noblanks: true,
        nonet: true
      });

      const valido = documento.validate(schema);
      const erros = valido
        ? []
        : formatarErrosXsd(documento.validationErrors || []);

      console.log(
        `${valido ? "✔" : "❌"} XSD ${rotulo}: ${path.relative(process.cwd(), schemaPath)}`
      );

      if (!valido) {
        erros.forEach(erro => console.error(`   ${erro}`));
      }

      return { valido, ignorado: false, schema: schemaPath, erros };
    } catch (e) {
      const mensagem = `Falha na validação XSD ${rotulo}: ${e.message}`;
      console.error(`❌ ${mensagem}`);
      return {
        valido: false,
        ignorado: false,
        schema: schemaPath,
        erros: [mensagem]
      };
    }
  }

  function validarCoerenciaEventoCancelamento(xmlEventoAssinado) {
    const doc = new DOMParser().parseFromString(
      String(xmlEventoAssinado || ""),
      "text/xml"
    );

    const infEvento = doc.getElementsByTagName("infEvento")[0];
    if (!infEvento) {
      return { valido: false, erros: ["Tag infEvento não encontrada."] };
    }

    const texto = nome => {
      const no = infEvento.getElementsByTagName(nome)[0];
      return no ? String(no.textContent || "").trim() : "";
    };

    const id = String(infEvento.getAttribute("Id") || "");
    const tpEvento = texto("tpEvento");
    const chave = texto("chNFe");
    const nSeqEvento = texto("nSeqEvento");
    const sequenciaId = String(nSeqEvento || "").padStart(2, "0");
    const idEsperado = `ID${tpEvento}${chave}${sequenciaId}`;
    const erros = [];

    if (tpEvento !== "110111") erros.push(`tpEvento inesperado: ${tpEvento}`);
    if (chave.length !== 44) erros.push(`chNFe deve ter 44 dígitos: ${chave.length}`);
    const sequenciaEsperada = TESTE_NSEQ_ZERO ? "0" : "1";
    if (nSeqEvento !== sequenciaEsperada) erros.push(`nSeqEvento esperado ${sequenciaEsperada}, recebido ${nSeqEvento}`);
    if (id !== idEsperado) {
      erros.push(`Id divergente. Esperado ${idEsperado}, recebido ${id}`);
    }

    console.log("========== DIAGNÓSTICO EVENTO CANCELAMENTO ==========");
    console.log({
      id,
      idEsperado,
      tpEvento,
      chave,
      nSeqEvento,
      protocolo: texto("nProt"),
      ambiente: texto("tpAmb"),
      coerente: erros.length === 0
    });
    if (erros.length) erros.forEach(e => console.error(`❌ ${e}`));
    console.log("=====================================================");

    return { valido: erros.length === 0, erros };
  }

  function montarEnvEventoPuro(xmlEventoAssinado, idLote) {
    const xmlLimpo = String(xmlEventoAssinado || "")
      .replace(/<\?xml[^>]*\?>/i, "")
      .trim();

    return `<?xml version="1.0" encoding="UTF-8"?>
  <envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
    <idLote>${esc(idLote)}</idLote>
    ${xmlLimpo}
  </envEvento>`;
  }

  function validarCancelamentoAntesEnvio(xmlEventoAssinado, idLote) {
    const coerencia = validarCoerenciaEventoCancelamento(xmlEventoAssinado);
    const schemas = localizarSchemasEventoCancelamento();
    console.log("========== XSD EVENTO DE CANCELAMENTO ================");
    console.log(`XSD EVENTO: ${schemas.evento ? "ENCONTRADO" : "NÃO ENCONTRADO"}${schemas.evento ? ` | ${path.relative(process.cwd(), schemas.evento)}` : ""}`);
    console.log(`XSD ENVELOPE: ${schemas.envelope ? "ENCONTRADO" : "NÃO ENCONTRADO"}${schemas.envelope ? ` | ${path.relative(process.cwd(), schemas.envelope)}` : ""}`);
    console.log("======================================================");
    const envEvento = montarEnvEventoPuro(xmlEventoAssinado, idLote);

    const xsdEvento = validarDocumentoContraSchema(
      xmlEventoAssinado,
      schemas.evento,
      "evento de cancelamento"
    );

    const xsdEnvelope = validarDocumentoContraSchema(
      envEvento,
      schemas.envelope,
      "envEvento"
    );

    console.log("================ ENV EVENTO COMPLETO =================");
    console.log(envEvento);
    console.log("======================================================");

    const falhasObrigatorias = [
      coerencia.valido === false,
      !TESTE_NSEQ_ZERO && xsdEvento.ignorado === false && xsdEvento.valido === false,
      !TESTE_NSEQ_ZERO && xsdEnvelope.ignorado === false && xsdEnvelope.valido === false
    ];

    if (TESTE_NSEQ_ZERO) {
      console.warn("⚠ TESTE HOMOLOGAÇÃO ATIVO: nSeqEvento=0 e falhas XSD não bloquearão o envio.");
    }

    const valido = !falhasObrigatorias.some(Boolean);
    console.log(`VALIDAÇÃO CANCELAMENTO: ${valido ? "APROVADO" : "REPROVADO"}`);

    return {
      valido,
      coerencia,
      xsdEvento,
      xsdEnvelope,
      envEvento
    };
  }

  // ================= CONSULTA SITUAÇÃO / EVENTOS NA SEFAZ =================

  function motivoCancelamentoValido(motivo = "") {
    const txt = String(motivo || "").trim();
    return txt.length >= 15 && txt.length <= 255;
  }

  function obterProtocoloAutorizacao(nota = {}) {
    return String(
      nota.protocolo ||
      nota.nProt ||
      nota.sefaz?.nProt ||
      nota.autorizacao?.nProt ||
      ""
    ).trim();
  }

  function notaEstaAutorizadaParaCancelar(nota = {}) {

    if (notaJaCancelada(nota)) {
      return {
        ok: false,
        error: "NFC-e já cancelada."
      };
    }
    const status = String(nota.status || "").toLowerCase();
    const cStat = String(nota.sefaz?.cStat || "");
    const protocolo = obterProtocoloAutorizacao(nota);

    return !!protocolo && (
      status === "autorizada" ||
      status === "autorizado" ||
      cStat === "100"
    );
  }

  function gerarIdLoteEventoNfce(nota = {}) {
    const numero = String(nota.numero || Date.now()).replace(/\D+/g, "");
    const base = "9" + numero + Date.now();
    return base.slice(-15).padStart(15, "0");
  }

  function gerarXmlEventoCancelamento(nota = {}, motivo = "") {
    const chave = String(nota.chaveAcesso || nota.chave || "");
    const protocolo = obterProtocoloAutorizacao(nota);
    const nSeqEvento = TESTE_NSEQ_ZERO ? "0" : "1";
    const tpEvento = "110111";
    const idEvento = "ID" + tpEvento + chave + nSeqEvento.padStart(2, "0");
    const dhEvento = formatarDhEmi(new Date().toISOString());

    if (!chave || chave.length !== 44) {
      throw new Error("Chave de acesso inválida para cancelamento.");
    }

    if (!protocolo) {
      throw new Error("Protocolo de autorização não encontrado. Só é possível cancelar NFC-e autorizada.");
    }

    if (!motivoCancelamentoValido(motivo)) {
      throw new Error("Motivo do cancelamento deve ter entre 15 e 255 caracteres.");
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
  <evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
    <infEvento Id="${esc(idEvento)}">
      <cOrgao>${NFCE_CONFIG.cUF}</cOrgao>
      <tpAmb>${NFCE_CONFIG.tpAmb}</tpAmb>
      <CNPJ>${EMPRESA.cnpj}</CNPJ>
      <chNFe>${esc(chave)}</chNFe>
      <dhEvento>${dhEvento}</dhEvento>
      <tpEvento>${tpEvento}</tpEvento>
      <nSeqEvento>${nSeqEvento}</nSeqEvento>
      <verEvento>1.00</verEvento>
      <detEvento versao="1.00">
        <descEvento>Cancelamento</descEvento>
        <nProt>${esc(protocolo)}</nProt>
        <xJust>${esc(motivo)}</xJust>
      </detEvento>
    </infEvento>
  </evento>`;
  }

  function obterIdInfEvento(xml) {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const infEvento = doc.getElementsByTagName("infEvento")[0];

    if (!infEvento) {
      throw new Error("Tag infEvento não encontrada para assinatura do cancelamento.");
    }

    const id = infEvento.getAttribute("Id");
    if (!id) {
      throw new Error("Atributo Id da infEvento não encontrado.");
    }

    return id;
  }

  function assinarXmlEvento(xmlEvento) {
    const cert = carregarCertificadoFiscal();

    // Usa no cancelamento o mesmo preparo já validado na emissão da NFC-e.
    // O ID e a assinatura são calculados sobre exatamente o mesmo XML compacto.
    const xmlCompacto = compactarXmlAntesDaAssinatura(xmlEvento);
    const id = obterIdInfEvento(xmlCompacto);

    const sig = new SignedXml({
      privateKey: cert.privateKeyPem,
      publicCert: cert.certificatePem,
      canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
      signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1"
    });

    sig.addReference({
      xpath: "//*[local-name(.)='infEvento']",
      uri: "#" + id,
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
      ],
      digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1"
    });

    sig.keyInfoProvider = {
      getKeyInfo() {
        return `<X509Data><X509Certificate>${cert.certificateClean}</X509Certificate></X509Data>`;
      }
    };

    sig.computeSignature(xmlCompacto, {
      location: {
        reference: "//*[local-name(.)='infEvento']",
        action: "after"
      }
    });

    return sig.getSignedXml();
  }

  function tentarAssinarXmlEvento(xmlEvento) {
    try {
      return {
        xml: assinarXmlEvento(xmlEvento),
        assinado: true,
        erro: null
      };
    } catch (e) {
      console.error("⚠ falha ao assinar evento:", e.message);
      return {
        xml: xmlEvento,
        assinado: false,
        erro: e.message
      };
    }
  }

  function montarEnvelopeSoapRecepcaoEvento(xmlEventoAssinado, idLote) {
    const xmlLimpo = String(xmlEventoAssinado || "")
      .replace(/<\?xml[^>]*\?>/i, "")
      .trim();

    return `<?xml version="1.0" encoding="utf-8"?>
  <soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
    <soap12:Body>
      <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">
        <envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
          <idLote>${esc(idLote)}</idLote>
          ${xmlLimpo}
        </envEvento>
      </nfeDadosMsg>
    </soap12:Body>
  </soap12:Envelope>`;
  }

  function extrairRetornoEventoSefaz(xmlRetorno) {
    const xml = String(xmlRetorno || "");

    function textoPrimeiraTagNoElemento(elemento, nomeTag) {
      if (!elemento) return "";

      const todos = elemento.getElementsByTagName("*");
      for (let i = 0; i < todos.length; i++) {
        const no = todos[i];
        const nome = no.localName || String(no.nodeName || "").split(":").pop();
        if (nome === nomeTag) {
          return String(no.textContent || "").trim();
        }
      }

      return "";
    }

    try {
      const doc = new DOMParser().parseFromString(xml, "text/xml");
      const todos = doc.getElementsByTagName("*");
      let infEventoRetorno = null;
      let retEnvEvento = null;

      for (let i = 0; i < todos.length; i++) {
        const no = todos[i];
        const nome = no.localName || String(no.nodeName || "").split(":").pop();
        if (nome === "retEnvEvento") {
          retEnvEvento = no;
          break;
        }
      }

      function textoFilhoDireto(elemento, nomeTag) {
        if (!elemento) return "";
        for (let i = 0; i < elemento.childNodes.length; i++) {
          const no = elemento.childNodes[i];
          if (no.nodeType !== 1) continue;
          const nome = no.localName || String(no.nodeName || "").split(":").pop();
          if (nome === nomeTag) return String(no.textContent || "").trim();
        }
        return "";
      }

      const cStatLote = textoFilhoDireto(retEnvEvento, "cStat");
      const xMotivoLote = textoFilhoDireto(retEnvEvento, "xMotivo");

      // O XML possui um cStat externo do lote (normalmente 128)
      // e outro dentro de retEvento/infEvento, que é o resultado real.
      for (let i = 0; i < todos.length; i++) {
        const no = todos[i];
        const nome = no.localName || String(no.nodeName || "").split(":").pop();

        if (nome !== "retEvento") continue;

        const descendentes = no.getElementsByTagName("*");
        for (let j = 0; j < descendentes.length; j++) {
          const filho = descendentes[j];
          const nomeFilho =
            filho.localName || String(filho.nodeName || "").split(":").pop();

          if (nomeFilho === "infEvento") {
            infEventoRetorno = filho;
            break;
          }
        }

        if (infEventoRetorno) break;
      }

      if (infEventoRetorno) {
        const cStat = textoPrimeiraTagNoElemento(infEventoRetorno, "cStat");
        const xMotivo = textoPrimeiraTagNoElemento(infEventoRetorno, "xMotivo");
        const chNFe = textoPrimeiraTagNoElemento(infEventoRetorno, "chNFe");
        const tpEvento = textoPrimeiraTagNoElemento(infEventoRetorno, "tpEvento");
        const nSeqEvento = textoPrimeiraTagNoElemento(infEventoRetorno, "nSeqEvento");
        const nProt = textoPrimeiraTagNoElemento(infEventoRetorno, "nProt");
        const dhRegEvento = textoPrimeiraTagNoElemento(infEventoRetorno, "dhRegEvento");

        return {
          cStat,
          xMotivo,
          cStatLote,
          xMotivoLote,
          chNFe,
          tpEvento,
          nSeqEvento,
          nProt,
          dhRegEvento,
          cancelado: cStat === "135" || cStat === "155"
        };
      }
    } catch (e) {
      console.error("⚠ falha ao interpretar retorno do evento:", e.message);
    }

    // Fallback para respostas fora do formato esperado.
    const cStat = extrairTagXml(xml, "cStat");
    const xMotivo = extrairTagXml(xml, "xMotivo");

    return {
      cStat,
      xMotivo,
      cStatLote: "",
      xMotivoLote: "",
      chNFe: extrairTagXml(xml, "chNFe"),
      tpEvento: extrairTagXml(xml, "tpEvento"),
      nSeqEvento: extrairTagXml(xml, "nSeqEvento"),
      nProt: extrairTagXml(xml, "nProt"),
      dhRegEvento: extrairTagXml(xml, "dhRegEvento"),
      cancelado: cStat === "135" || cStat === "155"
    };
  }

  async function transmitirCancelamentoSefaz(nota, xmlEventoAssinado) {
    if (!SEFAZ_CONFIG.habilitada) {
      return {
        ok: false,
        transmitido: false,
        pendente_habilitacao: true,
        cStat: "",
        xMotivo: "SEFAZ ainda não habilitada no sistema. Cancelamento não transmitido.",
        xmlRetorno: ""
      };
    }

    if (!SEFAZ_CONFIG.eventoUrl) {
      return {
        ok: false,
        transmitido: false,
        pendente_configuracao: true,
        cStat: "",
        xMotivo: "SEFAZ_NFCE_EVENTO_URL não configurada no Render.",
        xmlRetorno: ""
      };
    }

    carregarCertificadoFiscal();

    const idLote = gerarIdLoteEventoNfce(nota);
    const diagnosticoXml = validarCancelamentoAntesEnvio(xmlEventoAssinado, idLote);

    if (!diagnosticoXml.valido) {
      return {
        ok: false,
        transmitido: false,
        bloqueado_validacao: true,
        cStat: "",
        xMotivo: "Evento de cancelamento bloqueado por falha de validação local.",
        diagnosticoXml,
        xmlRetorno: ""
      };
    }

    const envelope = montarEnvelopeSoapRecepcaoEvento(xmlEventoAssinado, idLote);

    console.log("================ ENVELOPE SOAP ENVIADO ===============");
    console.log(envelope);
    console.log("======================================================");

    console.log(
      `→ Cancelamento NFC-e ${nota.numero} série ${nota.serie} | lote ${idLote} | enviando à SEFAZ...`
    );

    // SOAP 1.2 informa a operação pelo Content-Type e pelo namespace do corpo.
    // Não enviamos SOAPAction vazio no cancelamento, para evitar interpretação
    // diferente por proxies ou pelo webservice.
    const resposta = await httpsPostComCertificado(
      SEFAZ_CONFIG.eventoUrl,
      envelope
    );

    const retorno = extrairRetornoEventoSefaz(resposta.body);
    const httpOk = resposta.statusCode >= 200 && resposta.statusCode < 300;
    const cancelado = httpOk && !!retorno.cancelado;

    console.log("========== RESULTADO EVENTO CANCELAMENTO =============");
    console.log({
      httpStatus: resposta.statusCode,
      cStatLote: retorno.cStatLote || "",
      xMotivoLote: retorno.xMotivoLote || "",
      cStatEvento: retorno.cStat || "",
      xMotivoEvento: retorno.xMotivo || "",
      tpEvento: retorno.tpEvento || "",
      nSeqEvento: retorno.nSeqEvento || "",
      chNFe: retorno.chNFe || "",
      nProt: retorno.nProt || "",
      dhRegEvento: retorno.dhRegEvento || "",
      cancelado
    });
    console.log("======================================================");

    console.log(
      `← Cancelamento NFC-e ${nota.numero}: HTTP ${resposta.statusCode} | ` +
      `lote ${retorno.cStatLote || "sem cStat"} | ` +
      `evento ${retorno.cStat || "sem cStat"} | ` +
      `${retorno.xMotivo || retorno.xMotivoLote || "sem motivo"} | ` +
      `cancelado ${cancelado ? "SIM" : "NÃO"}`
    );

    return {
      // HTTP 200 significa apenas que o webservice respondeu.
      // O cancelamento só é considerado bem-sucedido com cStat 135 ou 155.
      ok: cancelado,
      transmitido: true,
      idLote,
      httpStatus: resposta.statusCode,
      ...retorno,
      cancelado,
      xmlRetorno: resposta.body
    };
  }

  async function salvarCancelamentoLocal(nota, dadosCancelamento) {
    const atual = await lerNotaLocal(nota.id) || nota;

    atual.cancelamento = {
      solicitado: true,
      transmitido: !!dadosCancelamento.transmitido,
      cancelado: !!dadosCancelamento.cancelado,
      motivo: dadosCancelamento.motivo || "",
      cStat: dadosCancelamento.cStat || "",
      xMotivo: dadosCancelamento.xMotivo || "",
      nProt: dadosCancelamento.nProt || "",
      dhRegEvento: dadosCancelamento.dhRegEvento || "",
      httpStatus: dadosCancelamento.httpStatus || "",
      xml_evento: dadosCancelamento.xmlEvento || "",
      xml_retorno: dadosCancelamento.xmlRetorno || "",
      atualizadoEm: new Date().toISOString()
    };

    if (dadosCancelamento.cancelado) {
      atual.status = "cancelada";
    } else if (dadosCancelamento.transmitido) {
      atual.status = "cancelamento_rejeitado_ou_pendente";
    } else if (dadosCancelamento.pendente_habilitacao || dadosCancelamento.pendente_configuracao) {
      atual.status = atual.status || "autorizada";
    }

    await salvarNota(atual);
    return atual;
  }

  return {
    motivoCancelamentoValido,
    obterProtocoloAutorizacao,
    notaEstaAutorizadaParaCancelar,
    gerarXmlEventoCancelamento,
    tentarAssinarXmlEvento,
    transmitirCancelamentoSefaz,
    salvarCancelamentoLocal
  };
}
