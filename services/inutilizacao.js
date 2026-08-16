import { SignedXml } from "xml-crypto";

function somenteDigitosLocal(v = "") {
  return String(v || "").replace(/\D+/g, "");
}

function escXml(v = "") {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pad(v, n) {
  return String(v ?? "").padStart(n, "0");
}

function extrairFaixa(valor = "") {
  const texto = String(valor || "").trim();
  const m = texto.match(/^(\d{1,9})(?:\s*[-–—]\s*(\d{1,9}))?$/);

  if (!m) {
    throw new Error(
      'Informe um número (ex.: 199) ou uma faixa (ex.: 199-200).'
    );
  }

  const inicial = Number(m[1]);
  const final = Number(m[2] || m[1]);

  if (
    !Number.isInteger(inicial) ||
    !Number.isInteger(final) ||
    inicial < 1 ||
    final < inicial ||
    final > 999999999
  ) {
    throw new Error("Faixa de numeração NFC-e inválida.");
  }

  return { inicial, final };
}

function validarJustificativa(valor = "") {
  const texto = String(valor || "").replace(/\s+/g, " ").trim();

  if (texto.length < 15 || texto.length > 255) {
    throw new Error("A justificativa deve possuir entre 15 e 255 caracteres.");
  }

  return texto;
}

function criarIdInutilizacao({
  cUF,
  ano,
  cnpj,
  modelo,
  serie,
  numeroInicial,
  numeroFinal
}) {
  const ano2 = String(ano).slice(-2);

  return (
    "ID" +
    pad(cUF, 2) +
    pad(ano2, 2) +
    pad(cnpj, 14) +
    pad(modelo, 2) +
    pad(serie, 3) +
    pad(numeroInicial, 9) +
    pad(numeroFinal, 9)
  );
}

function gerarXmlInutilizacao({
  tpAmb,
  cUF,
  ano,
  cnpj,
  modelo,
  serie,
  numeroInicial,
  numeroFinal,
  justificativa
}) {
  const id = criarIdInutilizacao({
    cUF,
    ano,
    cnpj,
    modelo,
    serie,
    numeroInicial,
    numeroFinal
  });

  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<inutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
      `<infInut Id="${id}">` +
        `<tpAmb>${escXml(tpAmb)}</tpAmb>` +
        `<xServ>INUTILIZAR</xServ>` +
        `<cUF>${escXml(cUF)}</cUF>` +
        `<ano>${escXml(String(ano).slice(-2))}</ano>` +
        `<CNPJ>${escXml(cnpj)}</CNPJ>` +
        `<mod>${escXml(modelo)}</mod>` +
        `<serie>${escXml(serie)}</serie>` +
        `<nNFIni>${escXml(numeroInicial)}</nNFIni>` +
        `<nNFFin>${escXml(numeroFinal)}</nNFFin>` +
        `<xJust>${escXml(justificativa)}</xJust>` +
      `</infInut>` +
    `</inutNFe>`;
}

function assinarXmlInutilizacao(xml, carregarCertificadoFiscal) {
  const cert = carregarCertificadoFiscal();

  const sig = new SignedXml({
    privateKey: cert.privateKeyPem,
    publicCert: cert.certificatePem,
    canonicalizationAlgorithm:
      "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
    signatureAlgorithm:
      "http://www.w3.org/2000/09/xmldsig#rsa-sha1"
  });

  const idMatch = String(xml).match(/<infInut\b[^>]*\bId="([^"]+)"/i);
  if (!idMatch) {
    throw new Error("Id da inutilização não encontrado para assinatura.");
  }

  sig.addReference({
    xpath: "//*[local-name(.)='infInut']",
    uri: "#" + idMatch[1],
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
    ],
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1"
  });

  sig.keyInfoProvider = {
    getKeyInfo() {
      return (
        `<X509Data><X509Certificate>` +
        cert.certificateClean +
        `</X509Certificate></X509Data>`
      );
    }
  };

  sig.computeSignature(String(xml).replace(/>\s+</g, "><").trim(), {
    location: {
      reference: "//*[local-name(.)='inutNFe']",
      action: "append"
    }
  });

  return sig.getSignedXml();
}

function montarEnvelopeSoapInutilizacao(xmlAssinado) {
  // O XML da inutilização fica EMBUTIDO dentro de <nfeDadosMsg>.
  // Portanto ele não pode carregar uma segunda declaração <?xml ...?>,
  // pois a única declaração XML válida é a do envelope SOAP.
  const xmlLimpo = String(xmlAssinado || "")
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[^>]*\?>/i, "")
    .trim();

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
      `<soap12:Body>` +
        `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4">` +
          xmlLimpo +
        `</nfeDadosMsg>` +
      `</soap12:Body>` +
    `</soap12:Envelope>`
  );
}

function statusConsomeNumero(nota = {}) {
  const status = String(
    nota.status || nota.status_nfce || ""
  ).trim().toLowerCase();

  const cStat = String(
    nota.cStat || nota.sefaz?.cStat || ""
  ).trim();

  const protocolo = String(
    nota.protocolo || nota.sefaz?.nProt || ""
  ).trim();

  const autorizada =
    nota.autorizado === true ||
    String(nota.autorizado || "") === "1" ||
    status.includes("autoriz");

  const cancelada =
    status.includes("cancelad") && !!protocolo;

  const denegada =
    status.includes("deneg") ||
    ["110", "301", "302"].includes(cStat);

  return autorizada || cancelada || denegada;
}

async function verificarConflitosLocais({
  numeroInicial,
  numeroFinal,
  listarNfceNotasRemotas
}) {
  if (typeof listarNfceNotasRemotas !== "function") return [];

  let notas = [];
  try {
    notas = await listarNfceNotasRemotas({});
  } catch {
    return [];
  }

  return notas
    .filter(n => {
      const numero = Number(n.numero || 0);
      return (
        numero >= numeroInicial &&
        numero <= numeroFinal &&
        statusConsomeNumero(n)
      );
    })
    .map(n => ({
      numero: Number(n.numero || 0),
      status: String(n.status || ""),
      chave: somenteDigitosLocal(n.chave || n.chaveAcesso || ""),
      protocolo: String(n.protocolo || n.sefaz?.nProt || "")
    }));
}

function montarPagina({ ambienteNome, serie, anoAtual }) {
  const justificativaPadrao =
    "Numeração não utilizada devido a falha técnica na geração/validação da NFC-e.";

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inutilização Fiscal • Bela Caixa</title>
<style>
  :root{font-family:Inter,Arial,sans-serif;color:#17202a;background:#f5f6f8}
  *{box-sizing:border-box}
  body{margin:0;padding:28px}
  .wrap{max-width:880px;margin:auto}
  .card{background:#fff;border:1px solid #dfe3e8;border-radius:18px;padding:24px;box-shadow:0 8px 30px rgba(20,30,45,.06)}
  h1{margin:0 0 6px;font-size:26px}
  .sub{color:#667085;margin-bottom:24px}
  .badge{display:inline-block;padding:6px 10px;border-radius:999px;background:#eef2f6;font-weight:700;font-size:12px}
  label{display:block;font-weight:700;margin:18px 0 7px}
  input,textarea{width:100%;padding:12px 13px;border:1px solid #cfd6df;border-radius:10px;font:inherit}
  textarea{min-height:92px;resize:vertical}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .help{font-size:13px;color:#667085;margin-top:6px}
  button{margin-top:20px;border:0;border-radius:11px;padding:13px 18px;font-weight:800;cursor:pointer;background:#17202a;color:#fff}
  button:disabled{opacity:.55;cursor:wait}
  .warn{margin-top:18px;padding:13px 14px;border-radius:11px;background:#fff7e8;border:1px solid #f3d28e;font-size:14px}
  #resultado{margin-top:22px;display:none;padding:16px;border-radius:12px;background:#f7f8fa;white-space:pre-wrap;word-break:break-word}
  .ok{border-left:5px solid #24945f}.erro{border-left:5px solid #c0392b}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>Inutilização Fiscal</h1>
    <div class="sub">Transmissão direta do pedido de inutilização para a SEFAZ/MG.</div>
    <span class="badge">${ambienteNome}</span>

    <label for="numero">Número ou faixa</label>
    <input id="numero" placeholder="Ex.: 199 ou 199-200" inputmode="numeric">
    <div class="help">Para um único número, digite apenas ele. Para uma faixa contínua, use hífen.</div>

    <div class="grid">
      <div>
        <label for="ano">Ano</label>
        <input id="ano" value="${anoAtual}" inputmode="numeric">
      </div>
      <div>
        <label>Série</label>
        <input value="${serie}" disabled>
      </div>
    </div>

    <label for="justificativa">Justificativa</label>
    <textarea id="justificativa">${justificativaPadrao}</textarea>

    <div class="warn">
      A inutilização só deve ser feita para numeração que não tenha sido utilizada
      em NFC-e autorizada, cancelada ou denegada. O sistema faz uma conferência
      preventiva nos registros locais antes da transmissão, e a decisão final é da SEFAZ.
    </div>

    <button id="btn" onclick="transmitir()">Transmitir inutilização à SEFAZ</button>
    <div id="resultado"></div>
  </div>
</div>

<script>
async function transmitir(){
  const numero = document.getElementById('numero').value.trim();
  const ano = Number(document.getElementById('ano').value);
  const justificativa = document.getElementById('justificativa').value.trim();
  const btn = document.getElementById('btn');
  const out = document.getElementById('resultado');

  if(!numero){
    alert('Informe o número ou a faixa.');
    return;
  }

  if(!confirm(
    'Confirma a transmissão do pedido de inutilização "' + numero +
    '" para a SEFAZ?\\n\\nConfira a numeração antes de continuar.'
  )) return;

  btn.disabled = true;
  out.style.display = 'block';
  out.className = '';
  out.textContent = 'Transmitindo para a SEFAZ...';

  try{
    const r = await fetch('/inutilizacao-fiscal/transmitir',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({numero,ano,justificativa})
    });
    const data = await r.json();

    out.className = data.inutilizada ? 'ok' : 'erro';
    out.textContent =
      (data.inutilizada ? 'INUTILIZAÇÃO HOMOLOGADA\\n\\n' : 'PEDIDO NÃO HOMOLOGADO\\n\\n') +
      'Faixa: ' + (data.numeroInicial || '') + (data.numeroFinal && data.numeroFinal !== data.numeroInicial ? ' a ' + data.numeroFinal : '') + '\\n' +
      'Ambiente: ' + (data.ambienteNome || '') + '\\n' +
      'cStat: ' + (data.cStat || '') + '\\n' +
      'Motivo: ' + (data.xMotivo || '') + '\\n' +
      'Protocolo: ' + (data.nProt || '') + '\\n' +
      'Recebimento: ' + (data.dhRecbto || '') +
      (data.sincronizacaoContador === false ? '\\n\\nATENÇÃO: SEFAZ homologou, mas houve falha ao sincronizar o contador no Apps Script.' : '');
  }catch(e){
    out.className='erro';
    out.textContent='Falha: ' + e.message;
  }finally{
    btn.disabled=false;
  }
}
</script>
</body>
</html>`;
}

export function registrarInutilizacaoFiscal({
  app,
  protegerModuloConferencia,
  NFCE_CONFIG,
  EMPRESA,
  SEFAZ_CONFIG,
  carregarCertificadoFiscal,
  httpsPostComCertificado,
  extrairTagXml,
  listarNfceNotasRemotas,
  registrarInutilizacaoNfceRemoto
}) {
  if (!app) throw new Error("Inutilização Fiscal: app não informado.");

  const proteger =
    typeof protegerModuloConferencia === "function"
      ? protegerModuloConferencia
      : ((req, res, next) => next());

  const seriePadrao = Number(NFCE_CONFIG?.seriePadrao || 1);
  const ambiente = String(NFCE_CONFIG?.tpAmb || SEFAZ_CONFIG?.ambiente || "2");
  const ambienteNome = ambiente === "1" ? "PRODUÇÃO" : "HOMOLOGAÇÃO";
  const anoAtual = Number(
    new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      timeZone: "America/Sao_Paulo"
    }).format(new Date())
  );

  app.get("/inutilizacao-fiscal", proteger, (req, res) => {
    res.type("html").send(
      montarPagina({
        ambienteNome,
        serie: seriePadrao,
        anoAtual
      })
    );
  });

  app.get("/inutilizacao", proteger, (req, res) => {
    res.redirect("/inutilizacao-fiscal");
  });

  app.post("/inutilizacao-fiscal/transmitir", proteger, async (req, res) => {
    let numeroInicial = 0;
    let numeroFinal = 0;

    try {
      const faixa = extrairFaixa(req.body?.numero);
      numeroInicial = faixa.inicial;
      numeroFinal = faixa.final;

      const ano = Number(req.body?.ano || anoAtual);
      if (!Number.isInteger(ano) || ano < 2000 || ano > 2099) {
        throw new Error("Ano da inutilização inválido.");
      }

      const justificativa = validarJustificativa(req.body?.justificativa);
      const cnpj = somenteDigitosLocal(EMPRESA?.cnpj || "");
      const cUF = String(NFCE_CONFIG?.cUF || "31");
      const modelo = String(NFCE_CONFIG?.modelo || "65");
      const serie = seriePadrao;

      if (cnpj.length !== 14) {
        throw new Error("CNPJ do emitente inválido para inutilização.");
      }

      if (!SEFAZ_CONFIG?.habilitada) {
        throw new Error("Transmissão SEFAZ está desabilitada no servidor.");
      }

      const url = String(SEFAZ_CONFIG?.inutilizacaoUrl || "").trim();
      if (!url) {
        throw new Error("Endpoint de inutilização da SEFAZ não configurado.");
      }

      const conflitos = await verificarConflitosLocais({
        numeroInicial,
        numeroFinal,
        listarNfceNotasRemotas
      });

      if (conflitos.length) {
        return res.status(409).json({
          ok: false,
          inutilizada: false,
          error:
            "A faixa contém número(s) que aparecem como fiscalmente utilizados no sistema.",
          conflitos
        });
      }

      const xml = gerarXmlInutilizacao({
        tpAmb: ambiente,
        cUF,
        ano,
        cnpj,
        modelo,
        serie,
        numeroInicial,
        numeroFinal,
        justificativa
      });

      const xmlAssinado = assinarXmlInutilizacao(
        xml,
        carregarCertificadoFiscal
      );

      const envelope = montarEnvelopeSoapInutilizacao(xmlAssinado);

      console.log(
        `[INUTILIZAÇÃO] Transmitindo NFC-e ${numeroInicial}` +
        `${numeroFinal !== numeroInicial ? `-${numeroFinal}` : ""} ` +
        `série ${serie} | ${ambienteNome}.`
      );

      const resposta = await httpsPostComCertificado(url, envelope, {
        SOAPAction: ""
      });

      const body = String(resposta.body || "");
      const cStat = extrairTagXml(body, "cStat");
      const xMotivo = extrairTagXml(body, "xMotivo");
      const nProt = extrairTagXml(body, "nProt");
      const dhRecbto = extrairTagXml(body, "dhRecbto");
      const tpAmb = extrairTagXml(body, "tpAmb") || ambiente;

      const inutilizada = cStat === "102" && !!nProt;

      let sincronizacaoContador = null;
      let erroSincronizacao = "";

      if (inutilizada && typeof registrarInutilizacaoNfceRemoto === "function") {
        try {
          await registrarInutilizacaoNfceRemoto({
            numeroInicial,
            numeroFinal,
            serie,
            ano,
            protocolo: nProt,
            dhRecbto,
            cStat,
            xMotivo
          });
          sincronizacaoContador = true;
        } catch (e) {
          sincronizacaoContador = false;
          erroSincronizacao = e.message || "Falha ao sincronizar contador.";
          console.error(
            "[INUTILIZAÇÃO] Homologada pela SEFAZ, mas falhou sincronização do contador:",
            erroSincronizacao
          );
        }
      }

      console.log(
        `[INUTILIZAÇÃO] SEFAZ: cStat ${cStat || "?"} | ` +
        `${xMotivo || "sem motivo"} | protocolo ${nProt || "sem protocolo"}.`
      );

      return res.status(inutilizada ? 200 : 422).json({
        ok: inutilizada,
        inutilizada,
        numeroInicial,
        numeroFinal,
        serie,
        ano,
        ambiente: tpAmb,
        ambienteNome: tpAmb === "1" ? "PRODUÇÃO" : "HOMOLOGAÇÃO",
        cStat,
        xMotivo,
        nProt,
        dhRecbto,
        httpStatus: resposta.statusCode || null,
        consultaUrl:
          "https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/consultainutilizacao.xhtml",
        sincronizacaoContador,
        erroSincronizacao
      });
    } catch (e) {
      console.error("[INUTILIZAÇÃO] Falha:", e.message);

      return res.status(400).json({
        ok: false,
        inutilizada: false,
        numeroInicial,
        numeroFinal,
        error: e.message || "Falha ao transmitir inutilização."
      });
    }
  });

  return {
    gerarXmlInutilizacao,
    assinarXmlInutilizacao,
    extrairFaixa
  };
}
