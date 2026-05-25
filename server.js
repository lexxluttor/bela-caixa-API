import express from "express";
import cors from "cors";
import zlib from "zlib";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { DOMParser } from "xmldom";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const BASE_URL = process.env.BASE_URL || "https://bela-caixa-api.onrender.com";
const LOGO_URL = process.env.LOGO_URL || "";
const API_BELA_SHEETS = process.env.API_BELA_SHEETS || "";

const DATA_DIR = path.resolve("./storage");
const NOTAS_DIR = path.join(DATA_DIR, "notas");

// ================= CERTIFICADO =================

const CERT_PATH = "/etc/secrets/certificado.pfx";
const CERT_PASSWORD = process.env.CERT_PASSWORD || process.env.CERTIFICADO_SENHA || "";
const CERTIFICADO_BASE64 = process.env.CERTIFICADO_BASE64 || "";

let certificado = null;
let certificadoFiscal = null;

function limparBase64Certificado(valor) {
  return String(valor || "")
    .replace(/-----BEGIN PKCS12-----/g, "")
    .replace(/-----END PKCS12-----/g, "")
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function pareceBase64Texto(buffer) {
  const texto = buffer.toString("utf8").trim();
  if (!texto) return false;
  if (texto.includes("-----BEGIN")) return true;
  return /^[A-Za-z0-9+/=\r\n\s]+$/.test(texto) && texto.length > 100;
}

function carregarBufferCertificado() {
  if (CERTIFICADO_BASE64) {
    const limpo = limparBase64Certificado(CERTIFICADO_BASE64);
    return Buffer.from(limpo, "base64");
  }

  const arquivo = fs.readFileSync(CERT_PATH);

  if (pareceBase64Texto(arquivo)) {
    const limpo = limparBase64Certificado(arquivo.toString("utf8"));
    return Buffer.from(limpo, "base64");
  }

  return arquivo;
}

try {
  certificado = carregarBufferCertificado();
  console.log("✔ certificado carregado");
} catch {
  console.log("⚠ certificado não encontrado");
}

function carregarCertificadoFiscal() {
  if (certificadoFiscal) return certificadoFiscal;

  if (!certificado) {
    throw new Error("Certificado A1 não encontrado. Configure /etc/secrets/certificado.pfx ou CERTIFICADO_BASE64.");
  }

  if (!CERT_PASSWORD) {
    throw new Error("Senha do certificado não configurada. Use CERT_PASSWORD ou CERTIFICADO_SENHA.");
  }

  try {
    const pfxBuffer = Buffer.from(certificado);
    const derBuffer = forge.util.createBuffer(pfxBuffer.toString("binary"));

    // strict=false evita o erro "Unparsed DER bytes remain after ASN.1 parsing"
    // em alguns PFX exportados no Windows/certificadoras brasileiras.
    const p12Asn1 = forge.asn1.fromDer(derBuffer, false);

    let p12;
    try {
      p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, CERT_PASSWORD);
    } catch {
      p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, CERT_PASSWORD);
    }

    let privateKey = null;
    let certificate = null;

    const shroudedKeyBags =
      p12.getBags({
        bagType: forge.pki.oids.pkcs8ShroudedKeyBag
      })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];

    if (shroudedKeyBags.length) {
      privateKey = shroudedKeyBags[0].key;
    }

    if (!privateKey) {
      const keyBags =
        p12.getBags({
          bagType: forge.pki.oids.keyBag
        })[forge.pki.oids.keyBag] || [];

      if (keyBags.length) {
        privateKey = keyBags[0].key;
      }
    }

    const certBags =
      p12.getBags({
        bagType: forge.pki.oids.certBag
      })[forge.pki.oids.certBag] || [];

    if (certBags.length) {
      certificate = certBags[0].cert;
    }

    if (!privateKey || !certificate) {
      throw new Error("Falha ao extrair chave privada/certificado do PFX. Verifique se o certificado é A1 e se a senha está correta.");
    }

    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
    const certificatePem = forge.pki.certificateToPem(certificate);

    const certificateClean = certificatePem
      .replace(/-----BEGIN CERTIFICATE-----/g, "")
      .replace(/-----END CERTIFICATE-----/g, "")
      .replace(/\r?\n|\r/g, "");

    certificadoFiscal = {
      privateKeyPem,
      certificatePem,
      certificateClean
    };

    console.log("✔ certificado fiscal preparado");
    return certificadoFiscal;

  } catch (err) {
    console.error("ERRO CERTIFICADO:", err);
    throw err;
  }
}

// ================= EMPRESA =================

const EMPRESA = {
  razao_social: "APARECIDA DE JESUS MIRANDA",
  nome_fantasia: "BELA MODAS",
  cnpj: "19225338000170",
  ie: "0022589640048",
  crt: "1",
  regime: "Simples Nacional",
  logradouro: "AVENIDA MEXICO",
  numero: "87",
  bairro: "PETROVALE",
  cidade: "BETIM",
  uf: "MG",
  cep: "32668052",
  fone: "31997337304",
  pais: "BRASIL"
};

const NFCE_CONFIG = {
  cUF: "31",
  cMunFG: "3106705",
  modelo: "65",
  seriePadrao: 1,
  tpAmb: "2", // 1=produção, 2=homologação
  tpEmis: "1", // 1=normal
  tpImp: "4", // DANFE NFC-e
  finNFe: "1",
  indFinal: "1",
  indPres: "1",
  procEmi: "0",
  verProc: "Bela Caixa 1.0",
  urlConsulta: "https://portalsped.fazenda.mg.gov.br/portalnfce"
};

// Para NFC-e real, informe no Render:
 // CSC_ID=000001
 // CSC_TOKEN=token_csc_fornecido_pela_sefaz_mg
 // Em homologação, sem CSC configurado, a API gera QR Code técnico de teste.
const CSC_CONFIG = {
  id: process.env.CSC_ID || "",
  token: process.env.CSC_TOKEN || ""
};

let sequencial = 1;

// ================= AUXILIARES =================

function somenteDigitos(v = "") {
  return String(v || "").replace(/\D+/g, "");
}

function dinheiro(v) {
  return Number(v || 0).toFixed(2);
}

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function dataMesRef(iso) {
  const d = new Date(iso || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function dataDiaRef(iso) {
  return String(iso || new Date().toISOString()).substring(0, 10);
}

function agoraBR() {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "America/Sao_Paulo"
  }).format(new Date());
}

function formatarCNPJ(cnpj) {
  const d = somenteDigitos(cnpj);
  if (d.length !== 14) return cnpj || "";
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function formatarCEP(cep) {
  const d = somenteDigitos(cep);
  if (d.length !== 8) return cep || "";
  return d.replace(/^(\d{5})(\d{3})$/, "$1-$2");
}

function formatarTelefone(fone) {
  const d = somenteDigitos(fone);
  if (d.length === 11) return d.replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3");
  if (d.length === 10) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, "($1) $2-$3");
  return fone || "";
}

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toNumber(v, padrao = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

function montarUrlAppsScript(action, params = {}) {
  if (!API_BELA_SHEETS) return "";
  const url = new URL(API_BELA_SHEETS);
  url.searchParams.set("action", action);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });
  return url.toString();
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, options);
  const text = await resp.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Resposta inválida do Apps Script");
  }

  if (!resp.ok || data.ok === false) {
    throw new Error(data.error || `Falha HTTP ${resp.status}`);
  }

  return data;
}

function pad2(v) {
  return String(v).padStart(2, "0");
}


function padLeft(v, tamanho) {
  return String(v || "").padStart(tamanho, "0");
}

function somenteNumerosValor(v, tamanho) {
  return padLeft(somenteDigitos(v), tamanho).slice(-tamanho);
}

function calcularModulo11Chave(chave43) {
  const pesos = [2, 3, 4, 5, 6, 7, 8, 9];
  let soma = 0;
  let pesoIndex = 0;

  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += Number(chave43[i]) * pesos[pesoIndex];
    pesoIndex = (pesoIndex + 1) % pesos.length;
  }

  const resto = soma % 11;
  const dv = 11 - resto;

  return dv === 10 || dv === 11 ? 0 : dv;
}

function gerarCodigoNumerico(numero, vendaId) {
  const base = somenteDigitos(String(vendaId || "")) || String(numero || Date.now());
  const combinado = String(base + Date.now()).slice(-8);
  return padLeft(combinado, 8);
}

function gerarChaveAcesso({ dataEmissaoIso, numero, serie, cNF }) {
  const d = new Date(dataEmissaoIso || Date.now());
  const ano = String(d.getFullYear()).slice(-2);
  const mes = pad2(d.getMonth() + 1);

  const chave43 =
    NFCE_CONFIG.cUF +
    ano +
    mes +
    somenteNumerosValor(EMPRESA.cnpj, 14) +
    NFCE_CONFIG.modelo +
    padLeft(serie, 3) +
    padLeft(numero, 9) +
    NFCE_CONFIG.tpEmis +
    padLeft(cNF, 8);

  return chave43 + calcularModulo11Chave(chave43);
}

function formatarDhEmi(iso) {
  const d = new Date(iso || Date.now());

  const partes = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(d).replace(" ", "T");

  return partes + "-03:00";
}

function tagEAN(v) {
  const ean = somenteDigitos(v || "");
  return ean ? ean : "SEM GTIN";
}

function quantidadeFiscal(v) {
  return Number(v || 0).toFixed(4);
}

function valorUnitarioFiscal(v) {
  return Number(v || 0).toFixed(10);
}

function calcularTotaisFiscais(nota) {
  const itens = nota.itens || [];

  const vProd = itens.reduce((s, i) => s + Number(i.valorTotal || 0), 0);
  const vDesc = Number(nota.desconto || 0);
  const vPIS = itens.reduce((s, i) => s + Number(i.valorPIS || 0), 0);
  const vCOFINS = itens.reduce((s, i) => s + Number(i.valorCOFINS || 0), 0);
  const vTotTrib = itens.reduce((s, i) => s + Number(i.vTotTrib || 0), 0);

  return {
    vBC: 0,
    vICMS: 0,
    vICMSDeson: 0,
    vFCP: 0,
    vBCST: 0,
    vST: 0,
    vFCPST: 0,
    vFCPSTRet: 0,
    vProd,
    vFrete: 0,
    vSeg: 0,
    vDesc,
    vII: 0,
    vIPI: 0,
    vIPIDevol: 0,
    vPIS,
    vCOFINS,
    vOutro: 0,
    vNF: Number(nota.total || (vProd - vDesc)),
    vTotTrib
  };
}



function sha1Hex(valor) {
  return crypto.createHash("sha1").update(String(valor), "utf8").digest("hex");
}

function gerarUrlQRCodeNfce(nota) {
  const chave = nota.chaveAcesso || nota.chave || "";
  const versaoQrCode = "2";
  const tpAmb = (typeof NFCE_CONFIG !== "undefined" && NFCE_CONFIG.tpAmb) ? NFCE_CONFIG.tpAmb : "2";
  const urlConsulta = (typeof NFCE_CONFIG !== "undefined" && NFCE_CONFIG.urlConsulta)
    ? NFCE_CONFIG.urlConsulta
    : "https://portalsped.fazenda.mg.gov.br/portalnfce";

  const idCsc = CSC_CONFIG.id || "000000";
  const tokenCsc = CSC_CONFIG.token || "";

  const baseQr = `${chave}|${versaoQrCode}|${tpAmb}|${idCsc}`;
  const hash = tokenCsc ? sha1Hex(baseQr + tokenCsc) : "HOMOLOGACAO_SEM_CSC";

  return `${urlConsulta}/sistema/qrcode.xhtml?p=${baseQr}|${hash}`;
}

function gerarImagemQRCodeUrl(conteudo) {
  return "https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" + encodeURIComponent(conteudo || "");
}

function textoHomologacao() {
  return "EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";
}


function obterIdInfNFe(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const infNFe = doc.getElementsByTagName("infNFe")[0];

  if (!infNFe) {
    throw new Error("Tag infNFe não encontrada para assinatura");
  }

  const id = infNFe.getAttribute("Id");
  if (!id) {
    throw new Error("Atributo Id da infNFe não encontrado");
  }

  return id;
}

function assinarXmlNFe(xml) {
  const cert = carregarCertificadoFiscal();
  const id = obterIdInfNFe(xml);

  const sig = new SignedXml({
    privateKey: cert.privateKeyPem,
    publicCert: cert.certificatePem,
    canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
    signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1"
  });

  sig.addReference({
    xpath: "//*[local-name(.)='infNFe']",
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

  sig.computeSignature(xml, {
    location: {
      reference: "//*[local-name(.)='infNFe']",
      action: "after"
    }
  });

  return sig.getSignedXml();
}

function tentarAssinarXmlNFe(xml) {
  try {
    return {
      xml: assinarXmlNFe(xml),
      assinado: true,
      erro: null
    };
  } catch (e) {
    console.error("⚠ falha ao assinar XML:", e.message);
    return {
      xml,
      assinado: false,
      erro: e.message
    };
  }
}


function normalizarMes(ano, mes) {
  const a = Number(ano);
  const m = Number(mes);
  if (!Number.isInteger(a) || !Number.isInteger(m) || m < 1 || m > 12) {
    return "";
  }
  return `${a}-${pad2(m)}`;
}


// ================= SANEAMENTO FISCAL AUTOMÁTICO =================
//
// Regra importante:
// - NCM válido vindo de XML de entrada ou cadastro manual é PRESERVADO.
// - Se não houver origem marcada, NCM válido também é preservado.
// - O sistema só preenche automaticamente se estiver vazio, inválido, 00000000,
//   ou se a origem fiscal estiver marcada como "automatico".

function ncmValidoFiscal(ncm) {
  const limpo = String(ncm || "").replace(/\D+/g, "");
  return limpo.length === 8 && limpo !== "00000000";
}

function normalizarTextoFiscal(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function obterTextoProdutoFiscal(item = {}) {
  return normalizarTextoFiscal([
    item.descricao,
    item.nome,
    item.desc,
    item.cat,
    item.categoria,
    item.grupo,
    item.subcat,
    item.subcategoria,
    item.tipo,
    item.departamento
  ].join(" "));
}

function ncmPorCategoriaOuDescricao(item = {}) {
  const texto = obterTextoProdutoFiscal(item);

  // Calçados
  if (texto.includes("sandalia infantil") || texto.includes("sandalia")) return "64022000";
  if (texto.includes("chinelo infantil") || texto.includes("chinelo")) return "64022000";
  if (texto.includes("tenis infantil") || texto.includes("tenis masculino") || texto.includes("tenis feminino") || texto.includes("tenis")) return "64041100";
  if (texto.includes("sapatilha")) return "64029990";
  if (texto.includes("sapato")) return "64039990";
  if (texto.includes("bota")) return "64039990";
  if (texto.includes("calcado") || texto.includes("calcados")) return "64029990";

  // Bolsas e acessórios
  if (texto.includes("mochila")) return "42029200";
  if (texto.includes("bolsa")) return "42029200";
  if (texto.includes("carteira")) return "42023200";
  if (texto.includes("cinto")) return "42033000";
  if (texto.includes("bone")) return "65050090";

  // Peças íntimas e meias
  if (texto.includes("cueca")) return "61071100";
  if (texto.includes("calcinha")) return "61082200";
  if (texto.includes("sutia") || texto.includes("top")) return "62121000";
  if (texto.includes("meia")) return "61159600";

  // Moletom
  if (texto.includes("conjunto") && texto.includes("moletom")) return "61102000";
  if (texto.includes("blusa") && texto.includes("moletom")) return "61102000";
  if ((texto.includes("calca") || texto.includes("calça")) && texto.includes("moletom")) return "61046200";
  if (texto.includes("moletom")) return "61102000";

  // Conjuntos
  if (texto.includes("conjunto") && texto.includes("masculino")) return "61032300";
  if (texto.includes("conjunto") && texto.includes("feminino")) return "61042300";
  if (texto.includes("conjunto") && texto.includes("infantil")) return "61042300";
  if (texto.includes("conjunto")) return "61042300";

  // Roupas principais
  if (texto.includes("vestido")) return "62044300";
  if (texto.includes("jaqueta")) return "62029300";
  if (texto.includes("camiseta") || texto.includes("camisa") || texto.includes("blusa") || texto.includes("regata")) return "61091000";
  if (texto.includes("jeans") && (texto.includes("masculino") || texto.includes("homem"))) return "62034200";
  if (texto.includes("jeans")) return "62046200";
  if (texto.includes("calca") || texto.includes("calça")) return "62046200";
  if (texto.includes("bermuda") || texto.includes("short")) return "62046200";
  if (texto.includes("saia")) return "62045300";
  if (texto.includes("pijama")) return "61083100";

  return "00000000";
}

function resolverNcmFiscal(item = {}) {
  const ncmAtual = String(item.ncm || item.NCM || "").replace(/\D+/g, "");
  const origemNcm = String(
    item.ncm_origem ||
    item.origem_ncm ||
    item.origemFiscal ||
    item.origem_fiscal ||
    ""
  ).trim().toLowerCase();

  const automatico = ncmPorCategoriaOuDescricao(item);
  const automaticoValido = ncmValidoFiscal(automatico);

  // Regra principal:
  // 1) Se veio de XML de entrada com NCM válido, PRESERVA sempre.
  // 2) Se foi marcado como manual com NCM válido, PRESERVA sempre.
  // 3) Se é automático, vazio, inválido ou produto antigo sem origem, pode corrigir.
  // Isso resolve produtos antigos com NCM errado, como "meias" com NCM de vestido.
  if (
    ncmValidoFiscal(ncmAtual) &&
    (origemNcm === "xml_entrada" || origemNcm === "xml")
  ) {
    return {
      ncm: ncmAtual,
      ncm_origem: "xml_entrada"
    };
  }

  if (
    ncmValidoFiscal(ncmAtual) &&
    origemNcm === "manual"
  ) {
    return {
      ncm: ncmAtual,
      ncm_origem: "manual"
    };
  }

  // Produto antigo sem origem marcada:
  // se a descrição/categoria indicar um NCM fiscal claro e diferente, atualiza.
  if (automaticoValido) {
    if (!ncmValidoFiscal(ncmAtual) || origemNcm === "automatico" || origemNcm === "" || origemNcm === "preservado") {
      return {
        ncm: automatico,
        ncm_origem: "automatico"
      };
    }
  }

  // Se não conseguiu resolver automaticamente, mantém o que existe se for válido.
  if (ncmValidoFiscal(ncmAtual)) {
    return {
      ncm: ncmAtual,
      ncm_origem: origemNcm || "preservado"
    };
  }

  return {
    ncm: "00000000",
    ncm_origem: "pendente"
  };
}

function resolverCampoFiscalPadrao(valor, padrao) {
  const s = String(valor ?? "").trim();
  return s || padrao;
}

function numeroFiscalPadrao(valor, padrao = 0) {
  const n = Number(String(valor ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : padrao;
}

function cstPisCofinsPadrao(valor) {
  const s = String(valor ?? "").replace(/\D+/g, "");
  return s || "49";
}

function csosnPadrao(valor) {
  const s = String(valor ?? "").replace(/\D+/g, "");
  return s || "102";
}

function cfopPadrao(valor) {
  const s = String(valor ?? "").replace(/\D+/g, "");
  return s || "5102";
}

function origemMercadoriaPadrao(valor) {
  const s = String(valor ?? "").replace(/\D+/g, "");
  return s !== "" ? s : "0";
}

function unidadeFiscalPadrao(valor) {
  const s = String(valor ?? "").trim().toUpperCase();
  return s || "UN";
}

function indTotPadrao(valor) {
  const s = String(valor ?? "").replace(/\D+/g, "");
  return s === "0" ? "0" : "1";
}

function resolverFiscalProdutoCompleto(item = {}) {
  const ncmResolvido = resolverNcmFiscal(item);

  const qtd = numeroFiscalPadrao(item.qtd ?? item.quantidade ?? item.qty, 1);
  const valorUnitario = numeroFiscalPadrao(item.valorUnitario ?? item.preco ?? item.valor, 0);
  const valorTotal = numeroFiscalPadrao(item.valorTotal, qtd * valorUnitario);

  const unidade = unidadeFiscalPadrao(item.unidade);
  const unidadeTrib = unidadeFiscalPadrao(item.unidadeTrib || item.unidade_trib || item.unidade);

  const ean = tagEAN(item.ean || item.codigo_barras || item.codBarras || item.codigoDeBarras || "");
  const eanTrib = tagEAN(item.eanTrib || item.ean_trib || item.ean || item.codigo_barras || item.codBarras || item.codigoDeBarras || "");

  return {
    codigo: String(item.cod || item.codigo || item.ref || item.id || "PRODUTO"),
    ean,
    eanTrib,
    descricao: String(item.descricao || item.nome || item.desc || "PRODUTO"),
    ncm: ncmResolvido.ncm,
    ncm_origem: ncmResolvido.ncm_origem,

    cfop: cfopPadrao(item.cfop),
    csosn: csosnPadrao(item.csosn),
    origem: origemMercadoriaPadrao(item.origem),

    cest: String(item.cest || ""),
    unidade,
    unidadeTrib,
    quantidade: qtd,
    quantidadeTrib: numeroFiscalPadrao(item.quantidadeTrib ?? item.quantidade_trib, qtd),
    valorUnitario,
    valorUnitarioTrib: numeroFiscalPadrao(item.valorUnitarioTrib ?? item.valor_unitario_trib, valorUnitario),
    valorTotal,
    indTot: indTotPadrao(item.indTot),

    cst_pis: cstPisCofinsPadrao(item.cst_pis || item.cstPis),
    aliq_pis: numeroFiscalPadrao(item.aliq_pis ?? item.aliqPis, 0),
    base_pis: numeroFiscalPadrao(item.base_pis ?? item.vBCPIS ?? item.vbc_pis, 0),
    valorPIS: numeroFiscalPadrao(item.valorPIS ?? item.vPIS, 0),

    cst_cofins: cstPisCofinsPadrao(item.cst_cofins || item.cstCofins),
    aliq_cofins: numeroFiscalPadrao(item.aliq_cofins ?? item.aliqCofins, 0),
    base_cofins: numeroFiscalPadrao(item.base_cofins ?? item.vBCCOFINS ?? item.vbc_cofins, 0),
    valorCOFINS: numeroFiscalPadrao(item.valorCOFINS ?? item.vCOFINS, 0),

    vTotTrib: numeroFiscalPadrao(item.vTotTrib ?? item.valorTributos, 0),
    saneamento_fiscal: true
  };
}


// ================= FORMA DE PAGAMENTO FISCAL =================

function mapearFormaPagamentoFiscal(tipo = "") {
  const t = String(tipo || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();

  if (!t) return "99";
  if (t.includes("PIX")) return "17";
  if (t.includes("DINHEIRO")) return "01";
  if (t.includes("DEBITO")) return "04";
  if (t.includes("CREDITO")) return "03";
  if (t.includes("CARTAO")) return "03";
  if (t.includes("BOLETO")) return "15";
  if (t.includes("CREDIARIO")) return "05";

  return "99";
}

// ================= APPS SCRIPT / XML / NOTAS =================

async function obterNumeroNfceRemoto() {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const url = montarUrlAppsScript("getProximoNumeroNfce");
  const data = await fetchJson(url);

  return {
    numero: toNumber(data.numero, 1),
    serie: toNumber(data.serie, 1)
  };
}

async function salvarXmlNfceRemoto(nota, xml) {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const payload = {
    action: "salvarNfceXml",
    id: nota.id,
    vendaId: nota.vendaId || nota.id,
    numero: nota.numero,
    serie: nota.serie,
    dataEmissao: nota.dataEmissaoIso,
    dataEmissaoBR: nota.dataEmissaoBR || "",
    cliente: nota.cliente?.nome || "",
    cpf: nota.cliente?.cpf || "",
    total: nota.total || 0,
    status: nota.status || "emitida_homologacao",
    chave: nota.chave || nota.id,
    pagamentoTipo: nota.pagamento?.tipo || "",
    pdfUrl: nota.pdf_url || "",
    xmlUrl: nota.xml_url || "",
    notaJson: JSON.stringify(nota),
    xml
  };

  return await fetchJson(API_BELA_SHEETS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function listarXmlMesRemoto(mes) {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const url = montarUrlAppsScript("listarNfceXmlMes", { mes });
  const data = await fetchJson(url);
  return Array.isArray(data.rows) ? data.rows : [];
}

async function listarXmlPeriodoRemoto(inicio, fim) {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const url = montarUrlAppsScript("listarNfceXmlPeriodo", { inicio, fim });
  const data = await fetchJson(url);
  return Array.isArray(data.rows) ? data.rows : [];
}

async function getNfceNotaRemota(id) {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const url = montarUrlAppsScript("getNfceNota", { id });
  const data = await fetchJson(url);
  return data.nota || null;
}

async function listarNfceNotasRemotas({ dia = "", mes = "" } = {}) {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const url = montarUrlAppsScript("listarNfceNotas", { dia, mes });
  const data = await fetchJson(url);
  return Array.isArray(data.rows) ? data.rows : [];
}

// ================= STORAGE LOCAL =================

async function ensureDirs() {
  await fsp.mkdir(NOTAS_DIR, { recursive: true });
}

function caminhoNota(id) {
  return path.join(NOTAS_DIR, `${id}.json`);
}

async function salvarNota(nota) {
  await ensureDirs();
  await fsp.writeFile(caminhoNota(nota.id), JSON.stringify(nota, null, 2), "utf-8");
}

async function lerNotaLocal(id) {
  try {
    const raw = await fsp.readFile(caminhoNota(id), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function listarNotasLocal() {
  await ensureDirs();

  const arquivos = await fsp.readdir(NOTAS_DIR);
  const lista = [];

  for (const arq of arquivos) {
    if (!arq.endsWith(".json")) continue;

    try {
      const raw = await fsp.readFile(path.join(NOTAS_DIR, arq), "utf-8");
      lista.push(JSON.parse(raw));
    } catch {}
  }

  lista.sort((a, b) => new Date(a.dataEmissaoIso || a.data || 0) - new Date(b.dataEmissaoIso || b.data || 0));
  return lista;
}

async function carregarSequencial() {
  const notas = await listarNotasLocal();
  const max = notas.reduce((m, n) => Math.max(m, Number(n.numero || 0)), 0);
  sequencial = max + 1;
}

// ================= NORMALIZAR VENDA =================

function obterProdutoFiscal(item = {}) {
  return resolverFiscalProdutoCompleto(item);
}

function normalizarPayload(body = {}) {
  const itens = (Array.isArray(body.itens) ? body.itens : []).map(obterProdutoFiscal);

  const subtotal = itens.reduce(
    (s, i) => s + Number(i.valorTotal || (i.quantidade * i.valorUnitario) || 0),
    0
  );

  const desconto = Number(body.desconto || 0);
  const totalCalculado = subtotal - desconto;

  const total = body.total != null ? Number(body.total) : totalCalculado;
  const pagamentoValor = body.pagamento?.valor != null ? Number(body.pagamento.valor) : total;

  return {
    vendaId: String(body.vendaId || body.id || `nfce-${Date.now()}`),
    dataVenda: body.dataVenda || new Date().toISOString(),
    cliente: {
      nome: String((body.cliente && body.cliente.nome) || body.cliente || "CONSUMIDOR NAO IDENTIFICADO"),
      cpf: somenteDigitos((body.cliente && body.cliente.cpf) || body.cpf || "")
    },
    itens,
    subtotal,
    desconto,
    total,
    pagamento: {
      tipo: String((body.pagamento && body.pagamento.tipo) || body.forma_pagamento || "DINHEIRO").toUpperCase(),
      valor: pagamentoValor
    }
  };
}

// ================= XML =================

function gerarXML(nota) {
  const chave = nota.chaveAcesso || nota.chave || "";
  const infNFeId = "NFe" + chave;
  const dhEmi = formatarDhEmi(nota.dataEmissaoIso);
  const totais = calcularTotaisFiscais(nota);
  const qrCodeUrl = nota.qrCodeUrl || gerarUrlQRCodeNfce(nota);

  const itensXml = (nota.itens || []).map((item, idx) => {
    const cestXml = item.cest ? `
        <CEST>${esc(item.cest)}</CEST>` : "";

    const cstPis = esc(item.cst_pis || "49");
    const aliqPis = dinheiro(item.aliq_pis || 0);
    const cstCofins = esc(item.cst_cofins || "49");
    const aliqCofins = dinheiro(item.aliq_cofins || 0);

    const vTotTribXml = Number(item.vTotTrib || 0) > 0
      ? `
        <vTotTrib>${dinheiro(item.vTotTrib)}</vTotTrib>`
      : "";

    return `
    <det nItem="${idx + 1}">
      <prod>
        <cProd>${esc(item.codigo || String(idx + 1))}</cProd>
        <cEAN>${esc(item.ean || "SEM GTIN")}</cEAN>
        <xProd>${esc(item.descricao)}</xProd>
        <NCM>${esc(item.ncm)}</NCM>${cestXml}
        <CFOP>${esc(item.cfop)}</CFOP>
        <uCom>${esc(item.unidade)}</uCom>
        <qCom>${quantidadeFiscal(item.quantidade)}</qCom>
        <vUnCom>${valorUnitarioFiscal(item.valorUnitario)}</vUnCom>
        <vProd>${dinheiro(item.valorTotal)}</vProd>
        <cEANTrib>${esc(item.eanTrib || item.ean || "SEM GTIN")}</cEANTrib>
        <uTrib>${esc(item.unidadeTrib || item.unidade)}</uTrib>
        <qTrib>${quantidadeFiscal(item.quantidadeTrib || item.quantidade)}</qTrib>
        <vUnTrib>${valorUnitarioFiscal(item.valorUnitarioTrib || item.valorUnitario)}</vUnTrib>
        <indTot>${esc(item.indTot || "1")}</indTot>
      </prod>
      <imposto>${vTotTribXml}
        <ICMS>
          <ICMSSN102>
            <orig>${esc(item.origem)}</orig>
            <CSOSN>${esc(item.csosn || "102")}</CSOSN>
          </ICMSSN102>
        </ICMS>
        <PIS>
          <PISOutr>
            <CST>${cstPis}</CST>
            <vBC>${dinheiro(item.base_pis || 0)}</vBC>
            <pPIS>${aliqPis}</pPIS>
            <vPIS>${dinheiro(item.valorPIS || 0)}</vPIS>
          </PISOutr>
        </PIS>
        <COFINS>
          <COFINSOutr>
            <CST>${cstCofins}</CST>
            <vBC>${dinheiro(item.base_cofins || 0)}</vBC>
            <pCOFINS>${aliqCofins}</pCOFINS>
            <vCOFINS>${dinheiro(item.valorCOFINS || 0)}</vCOFINS>
          </COFINSOutr>
        </COFINS>
      </imposto>
    </det>
  `;
  }).join("");

  const destCpf = somenteDigitos(nota.cliente?.cpf || "");

  const destXml = destCpf
    ? `
    <dest>
      <CPF>${esc(destCpf)}</CPF>
      <xNome>${esc(nota.cliente?.nome || "CONSUMIDOR")}</xNome>
      <indIEDest>9</indIEDest>
    </dest>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="${infNFeId}" versao="4.00">
    <ide>
      <cUF>${NFCE_CONFIG.cUF}</cUF>
      <cNF>${esc(nota.cNF)}</cNF>
      <natOp>VENDA DE MERCADORIA</natOp>
      <mod>${NFCE_CONFIG.modelo}</mod>
      <serie>${nota.serie}</serie>
      <nNF>${nota.numero}</nNF>
      <dhEmi>${dhEmi}</dhEmi>
      <tpNF>1</tpNF>
      <idDest>1</idDest>
      <cMunFG>${NFCE_CONFIG.cMunFG}</cMunFG>
      <tpImp>${NFCE_CONFIG.tpImp}</tpImp>
      <tpEmis>${NFCE_CONFIG.tpEmis}</tpEmis>
      <cDV>${esc(nota.cDV)}</cDV>
      <tpAmb>${NFCE_CONFIG.tpAmb}</tpAmb>
      <finNFe>${NFCE_CONFIG.finNFe}</finNFe>
      <indFinal>${NFCE_CONFIG.indFinal}</indFinal>
      <indPres>${NFCE_CONFIG.indPres}</indPres>
      <procEmi>${NFCE_CONFIG.procEmi}</procEmi>
      <verProc>${esc(NFCE_CONFIG.verProc)}</verProc>
    </ide>
    <emit>
      <CNPJ>${EMPRESA.cnpj}</CNPJ>
      <xNome>${esc(EMPRESA.razao_social)}</xNome>
      <xFant>${esc(EMPRESA.nome_fantasia)}</xFant>
      <enderEmit>
        <xLgr>${esc(EMPRESA.logradouro)}</xLgr>
        <nro>${esc(EMPRESA.numero)}</nro>
        <xBairro>${esc(EMPRESA.bairro)}</xBairro>
        <cMun>${NFCE_CONFIG.cMunFG}</cMun>
        <xMun>${esc(EMPRESA.cidade)}</xMun>
        <UF>${esc(EMPRESA.uf)}</UF>
        <CEP>${esc(EMPRESA.cep)}</CEP>
        <cPais>1058</cPais>
        <xPais>${esc(EMPRESA.pais)}</xPais>
        <fone>${esc(EMPRESA.fone)}</fone>
      </enderEmit>
      <IE>${esc(EMPRESA.ie)}</IE>
      <CRT>${esc(EMPRESA.crt)}</CRT>
    </emit>${destXml}
${itensXml}
    <total>
      <ICMSTot>
        <vBC>${dinheiro(totais.vBC)}</vBC>
        <vICMS>${dinheiro(totais.vICMS)}</vICMS>
        <vICMSDeson>${dinheiro(totais.vICMSDeson)}</vICMSDeson>
        <vFCP>${dinheiro(totais.vFCP)}</vFCP>
        <vBCST>${dinheiro(totais.vBCST)}</vBCST>
        <vST>${dinheiro(totais.vST)}</vST>
        <vFCPST>${dinheiro(totais.vFCPST)}</vFCPST>
        <vFCPSTRet>${dinheiro(totais.vFCPSTRet)}</vFCPSTRet>
        <vProd>${dinheiro(totais.vProd)}</vProd>
        <vFrete>${dinheiro(totais.vFrete)}</vFrete>
        <vSeg>${dinheiro(totais.vSeg)}</vSeg>
        <vDesc>${dinheiro(totais.vDesc)}</vDesc>
        <vII>${dinheiro(totais.vII)}</vII>
        <vIPI>${dinheiro(totais.vIPI)}</vIPI>
        <vIPIDevol>${dinheiro(totais.vIPIDevol)}</vIPIDevol>
        <vPIS>${dinheiro(totais.vPIS)}</vPIS>
        <vCOFINS>${dinheiro(totais.vCOFINS)}</vCOFINS>
        <vOutro>${dinheiro(totais.vOutro)}</vOutro>
        <vNF>${dinheiro(totais.vNF)}</vNF>
        <vTotTrib>${dinheiro(totais.vTotTrib)}</vTotTrib>
      </ICMSTot>
    </total>
    <transp>
      <modFrete>9</modFrete>
    </transp>
    <pag>
      <detPag>
        <indPag>0</indPag>
        <tPag>${mapearFormaPagamentoFiscal(nota.pagamento?.tipo)}</tPag>
        <vPag>${dinheiro(nota.pagamento?.valor || nota.total)}</vPag>
      </detPag>
    </pag>
    <infAdic>
      <infCpl>DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. ${textoHomologacao()}.</infCpl>
    </infAdic>
  </infNFe>
  <infNFeSupl>
    <qrCode><![CDATA[${qrCodeUrl}]]></qrCode>
    <urlChave>${NFCE_CONFIG.urlConsulta}</urlChave>
  </infNFeSupl>
</NFe>`;
}

function nomeArquivoXML(nota) {
  const serie = String(nota.serie || 1).padStart(3, "0");
  const numero = String(nota.numero || 0).padStart(9, "0");
  return `${EMPRESA.cnpj}65${serie}${numero}.xml`;
}

function nomeArquivoXMLRegistro(r = {}) {
  const serie = String(r.serie || 1).padStart(3, "0");
  const numero = String(r.numero || 0).padStart(9, "0");
  return `${EMPRESA.cnpj}65${serie}${numero}.xml`;
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

// ================= HTML CUPOM =================

function gerarHTML(nota) {
  const itens = (nota.itens || []).map((item) => {
    const codigoExibido = item.ean || item.codigo || "-";

    return `
<tr>
  <td>${esc(item.descricao)}</td>
  <td>${item.quantidade}</td>
  <td>R$ ${moeda(item.valorTotal)}</td>
</tr>
<tr class="linha-codigo">
  <td colspan="3">${esc(codigoExibido)}</td>
</tr>
`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>NFC-e ${nota.numero}</title>
<style>
body{
  margin:0;
  padding:0;
  background:#f5f5f5;
  font-family:Arial, Helvetica, sans-serif;
}
.cupom{
  width:80mm;
  max-width:80mm;
  margin:10px auto;
  background:#fff;
  color:#000;
  padding:8px;
  box-sizing:border-box;
  font-size:12px;
}
.center{text-align:center;}
.logo{
  width:70px;
  max-height:70px;
  object-fit:contain;
  margin-bottom:6px;
}
.nome-loja{
  font-size:22px;
  font-weight:bold;
  margin-bottom:4px;
}
.info-empresa{
  line-height:1.4;
  font-size:11px;
}
.sep{
  border-top:1px dashed #000;
  margin:10px 0;
}
.titulo{
  text-align:center;
  font-weight:bold;
  font-size:14px;
  margin:8px 0;
}
.info{
  line-height:1.6;
  font-size:12px;
}
table{
  width:100%;
  border-collapse:collapse;
  margin-top:5px;
}
th{
  border-bottom:1px solid #000;
  padding-bottom:4px;
  font-size:11px;
  text-align:left;
}
th:last-child, td:last-child{text-align:right;}
th:nth-child(2), td:nth-child(2){
  text-align:center;
  width:40px;
}
td{
  vertical-align:top;
  padding:3px 0;
  font-size:11px;
}
.linha-codigo td{
  font-size:10px;
  color:#555;
  padding-bottom:6px;
  text-align:left;
}
.resumo{margin-top:10px;}
.resumo-linha{
  display:flex;
  justify-content:space-between;
  margin-bottom:4px;
}
.total{
  font-size:20px;
  font-weight:bold;
  border-top:1px dashed #000;
  border-bottom:1px dashed #000;
  padding:8px 0;
  margin-top:8px;
}
.pagamento{
  margin-top:10px;
  text-align:center;
  border:1px dashed #000;
  padding:8px;
}
.pagamento strong{font-size:14px;}
.qrcode{
  margin-top:12px;
  text-align:center;
}
.qrcode-box{
  width:120px;
  height:120px;
  border:1px solid #ccc;
  margin:0 auto 8px;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:11px;
}
.chave{
  font-size:10px;
  word-break:break-all;
  line-height:1.4;
}
.msg{
  margin-top:12px;
  text-align:center;
  font-size:12px;
  line-height:1.6;
}
.rodape{
  margin-top:12px;
  font-size:10px;
  text-align:center;
  color:#444;
}
.btns{
  margin-top:15px;
  display:flex;
  justify-content:center;
  gap:8px;
}
button{
  border:none;
  background:#000;
  color:#fff;
  padding:8px 12px;
  border-radius:6px;
  cursor:pointer;
  font-size:12px;
}
@page{
  size:80mm auto;
  margin:2mm;
}
@media print{
  body{background:#fff;}
  .cupom{
    margin:0 auto;
    width:80mm;
    max-width:80mm;
  }
  .btns{display:none;}
}
</style>
</head>
<body>

<div class="cupom">

  <div class="center">
    ${LOGO_URL ? `<img src="${LOGO_URL}" class="logo" alt="Logo Bela Modas">` : ""}

    <div class="nome-loja">
      ${esc(EMPRESA.nome_fantasia)}
    </div>

    <div class="info-empresa">
      ${esc(EMPRESA.razao_social)}<br>
      CNPJ ${formatarCNPJ(EMPRESA.cnpj)}<br>
      IE ${esc(EMPRESA.ie)}<br>
      ${esc(EMPRESA.logradouro)}, ${esc(EMPRESA.numero)}<br>
      ${esc(EMPRESA.bairro)} - ${esc(EMPRESA.cidade)}/${esc(EMPRESA.uf)}<br>
      CEP ${formatarCEP(EMPRESA.cep)}<br>
      Tel ${formatarTelefone(EMPRESA.fone)}
    </div>
  </div>

  <div class="sep"></div>

  <div class="titulo">DANFE NFC-e</div>

  <div class="info">
    <strong>Número:</strong> ${nota.numero}<br>
    <strong>Série:</strong> ${nota.serie}<br>
    <strong>Data:</strong> ${esc(nota.dataEmissaoBR)}<br>
    <strong>Cliente:</strong> ${esc(nota.cliente?.nome || "Consumidor")}
  </div>

  <div class="sep"></div>

  <table>
    <thead>
      <tr>
        <th>Descrição</th>
        <th>Qtd</th>
        <th>Total</th>
      </tr>
    </thead>
    <tbody>
      ${itens}
    </tbody>
  </table>

  <div class="sep"></div>

  <div class="resumo">
    <div class="resumo-linha">
      <span>Qtd itens</span>
      <span>${(nota.itens || []).reduce((s, item) => s + Number(item.quantidade || 0), 0)}</span>
    </div>
    <div class="resumo-linha">
      <span>Subtotal</span>
      <span>R$ ${moeda(nota.subtotal || 0)}</span>
    </div>
    <div class="resumo-linha">
      <span>Desconto</span>
      <span>R$ ${moeda(nota.desconto || 0)}</span>
    </div>
    <div class="resumo-linha total">
      <span>TOTAL</span>
      <span>R$ ${moeda(nota.total || 0)}</span>
    </div>
  </div>

  <div class="pagamento">
    <div>Forma pagamento</div>
    <strong>${esc(nota.pagamento?.tipo || "DINHEIRO")}</strong>
    <div style="margin-top:5px;">
      Valor pago: R$ ${moeda(nota.pagamento?.valor || nota.total || 0)}
    </div>
  </div>

  <div class="qrcode">
    <div class="qrcode-box">
      ${nota.qrCodeUrl ? `<img src="${gerarImagemQRCodeUrl(nota.qrCodeUrl)}" alt="QR Code NFC-e" style="width:118px;height:118px;">` : "QR CODE NFC-e"}
    </div>

    <div style="font-size:11px;line-height:1.5;">
      Consulte pela chave de acesso em:<br>
      <strong>${esc(NFCE_CONFIG.urlConsulta)}</strong>
    </div>

    <div class="chave">
      ${esc(nota.chaveAcesso || nota.chave || nota.id)}
    </div>
  </div>

  <div class="msg">
    Obrigado pela preferência!<br>
    Volte sempre.
  </div>

  <div class="sep"></div>

  <div class="rodape">
    Documento emitido por ME/EPP optante pelo Simples Nacional.<br>
    ${esc(textoHomologacao())}.<br><br>
    Impresso em ${esc(nota.dataEmissaoBR)}
  </div>

</div>

<div class="btns">
  <button onclick="window.print()">Imprimir</button>
  <button onclick="window.close()">Fechar</button>
</div>

</body>
</html>`;
}

// ================= HELPERS DE EXPORTAÇÃO =================

async function obterArquivosXmlMes(mes) {
  let arquivos = [];

  // 1) tenta XML completo salvo
  try {
    if (API_BELA_SHEETS) {
      const rows = await listarXmlMesRemoto(mes);
      arquivos = rows
        .filter(r => String(r.xml || "").trim() !== "")
        .map(r => ({
          name: nomeArquivoXMLRegistro(r),
          data: String(r.xml),
          date: r.dataEmissao || new Date().toISOString()
        }));
    }
  } catch (e) {
    console.error("⚠ falha ao buscar XML do mês no Apps Script:", e.message);
  }

  // 2) fallback remoto: recria XML a partir de nfce_notas
  try {
    if (API_BELA_SHEETS) {
      const notas = await listarNfceNotasRemotas({ mes });
      const existentes = new Set(arquivos.map(a => a.name));

      for (const n of notas) {
        const id = n.id;
        if (!id) continue;

        const notaCompleta = await getNfceNotaRemota(id);
        if (!notaCompleta) continue;

        const nome = nomeArquivoXML(notaCompleta);
        if (existentes.has(nome)) continue;

        arquivos.push({
          name: nome,
          data: gerarXML(notaCompleta),
          date: notaCompleta.dataEmissaoIso || notaCompleta.data || new Date().toISOString()
        });
        existentes.add(nome);
      }
    }
  } catch (e) {
    console.error("⚠ falha ao recriar XML do mês via nfce_notas:", e.message);
  }

  // 3) último fallback local
  if (!arquivos.length) {
    const lista = (await listarNotasLocal()).filter(n => n.mesRef === mes);

    arquivos = lista.map(n => ({
      name: nomeArquivoXML(n),
      data: gerarXML(n),
      date: n.dataEmissaoIso || n.data || new Date().toISOString()
    }));
  }

  return arquivos;
}

async function obterArquivosXmlPeriodo(inicio, fim) {
  let arquivos = [];

  // 1) tenta XML completo salvo
  try {
    if (API_BELA_SHEETS) {
      const rows = await listarXmlPeriodoRemoto(inicio, fim);
      arquivos = rows
        .filter(r => String(r.xml || "").trim() !== "")
        .map(r => ({
          name: nomeArquivoXMLRegistro(r),
          data: String(r.xml),
          date: r.dataEmissao || new Date().toISOString()
        }));
    }
  } catch (e) {
    console.error("⚠ falha ao buscar XML do período no Apps Script:", e.message);
  }

  // 2) fallback remoto: recria XML a partir de nfce_notas
  try {
    if (API_BELA_SHEETS) {
      const notas = await listarNfceNotasRemotas({});
      const existentes = new Set(arquivos.map(a => a.name));
      const dIni = inicio ? new Date(inicio + "T00:00:00") : null;
      const dFim = fim ? new Date(fim + "T23:59:59") : null;

      for (const n of notas) {
        const notaDate = new Date(n.data || "");
        if (dIni && notaDate < dIni) continue;
        if (dFim && notaDate > dFim) continue;

        const notaCompleta = await getNfceNotaRemota(n.id);
        if (!notaCompleta) continue;

        const nome = nomeArquivoXML(notaCompleta);
        if (existentes.has(nome)) continue;

        arquivos.push({
          name: nome,
          data: gerarXML(notaCompleta),
          date: notaCompleta.dataEmissaoIso || notaCompleta.data || new Date().toISOString()
        });
        existentes.add(nome);
      }
    }
  } catch (e) {
    console.error("⚠ falha ao recriar XML do período via nfce_notas:", e.message);
  }

  // 3) último fallback local
  if (!arquivos.length) {
    const dIni = inicio ? new Date(inicio + "T00:00:00") : null;
    const dFim = fim ? new Date(fim + "T23:59:59") : null;

    const lista = (await listarNotasLocal()).filter(n => {
      const d = new Date(n.dataEmissaoIso || n.data);
      if (dIni && d < dIni) return false;
      if (dFim && d > dFim) return false;
      return true;
    });

    arquivos = lista.map(n => ({
      name: nomeArquivoXML(n),
      data: gerarXML(n),
      date: n.dataEmissaoIso || n.data || new Date().toISOString()
    }));
  }

  return arquivos;
}

async function responderZipMes(res, mes) {
  const files = await obterArquivosXmlMes(mes);

  if (!files.length) {
    return res.status(404).json({ ok: false, error: "Nenhum XML encontrado para este mês." });
  }

  const zipBuffer = makeZip(files);

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="xml_nfce_${mes}.zip"`);
  return res.send(zipBuffer);
}

async function responderZipPeriodo(res, inicio, fim) {
  const files = await obterArquivosXmlPeriodo(inicio, fim);

  if (!files.length) {
    return res.status(404).json({ ok: false, error: "Nenhum XML encontrado no período." });
  }

  const zipBuffer = makeZip(files);
  const nome = `${inicio || "inicio"}_${fim || "fim"}`.replace(/\//g, "-");

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="xml_nfce_${nome}.zip"`);
  return res.send(zipBuffer);
}

// ================= ROTAS =================

app.get("/", (req, res) => {
  res.send("API Bela Modas online");
});

app.get("/health", async (req, res) => {
  let remoto = null;
  if (API_BELA_SHEETS) {
    try {
      remoto = await obterNumeroNfceRemoto();
    } catch (e) {
      remoto = { erro: e.message };
    }
  }

  let totalRemoto = null;
  try {
    const notasRemotas = API_BELA_SHEETS ? await listarNfceNotasRemotas({}) : [];
    totalRemoto = notasRemotas.length;
  } catch {
    totalRemoto = null;
  }

  const notasLocal = await listarNotasLocal();

  res.json({
    status: "ok",
    empresa: EMPRESA.nome_fantasia,
    total_notas_local: notasLocal.length,
    total_notas_remoto: totalRemoto,
    proximo_numero_local: sequencial,
    proximo_numero_remoto: remoto?.numero ?? null,
    serie_remota: remoto?.serie ?? null,
    apps_script_configurado: !!API_BELA_SHEETS,
    certificado: certificado ? true : false,
    cert_password_configurada: !!CERT_PASSWORD,
    assinatura_xml_disponivel: certificado && CERT_PASSWORD ? true : false
  });
});

app.get("/certificado/status", (req, res) => {
  res.json({
    ok: certificado ? true : false,
    mensagem: certificado ? "certificado carregado" : "certificado nao encontrado"
  });
});

app.get("/assinatura/status", (req, res) => {
  try {
    carregarCertificadoFiscal();
    res.json({
      ok: true,
      certificado: true,
      senha_configurada: !!CERT_PASSWORD,
      assinatura_disponivel: true
    });
  } catch (e) {
    res.status(400).json({
      ok: false,
      certificado: !!certificado,
      senha_configurada: !!CERT_PASSWORD,
      assinatura_disponivel: false,
      error: e.message
    });
  }
});

app.get("/assinatura/debug", (req, res) => {
  res.json({
    ok: true,
    certificado_carregado: !!certificado,
    tamanho_certificado_bytes: certificado ? certificado.length : 0,
    senha_configurada: !!CERT_PASSWORD,
    usando_certificado_base64_env: !!CERTIFICADO_BASE64,
    tem_arquivo_certificado: fs.existsSync(CERT_PATH)
  });
});

app.get("/empresa", (req, res) => {
  res.json(EMPRESA);
});

app.post("/nfce/emitir", async (req, res) => {
  try {
    const venda = normalizarPayload(req.body);
    const id = String(req.body.vendaId || req.body.id || venda.vendaId || `nfce-${Date.now()}`);

    let numero;
    let serie;
    let numeracaoOrigem = "local";

    try {
      if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");
      const remoto = await obterNumeroNfceRemoto();
      numero = remoto.numero;
      serie = remoto.serie;
      numeracaoOrigem = "apps_script";
    } catch (e) {
      numero = sequencial++;
      serie = 1;
      console.warn("⚠ usando numeração local:", e.message);
    }

    const dataEmissaoIso = new Date().toISOString();
    const cNF = gerarCodigoNumerico(numero, id);
    const chaveAcesso = gerarChaveAcesso({
      dataEmissaoIso,
      numero,
      serie,
      cNF
    });

    const nota = {
      ...venda,
      id,
      numero,
      serie,
      cNF,
      cDV: chaveAcesso.slice(-1),
      chaveAcesso,
      qrCodeUrl: gerarUrlQRCodeNfce({ chaveAcesso }),
      dataEmissaoIso,
      dataEmissaoBR: agoraBR(),
      mesRef: dataMesRef(dataEmissaoIso),
      diaRef: dataDiaRef(dataEmissaoIso),
      status: "emitida_homologacao",
      chave: chaveAcesso
    };

    nota.pdf_url = `${BASE_URL}/nfce/${encodeURIComponent(id)}/pdf`;
    nota.xml_url = `${BASE_URL}/nfce/${encodeURIComponent(id)}/xml`;

    const xmlOriginal = gerarXML(nota);
    const assinatura = tentarAssinarXmlNFe(xmlOriginal);
    const xml = assinatura.xml;

    nota.xml_assinado = assinatura.assinado;
    nota.erro_assinatura = assinatura.erro;

    await salvarNota(nota);

    let xmlSalvoNoAppsScript = false;
    let erroAppsScript = null;

    try {
      if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");
      await salvarXmlNfceRemoto(nota, xml);
      xmlSalvoNoAppsScript = true;
    } catch (e) {
      erroAppsScript = e.message;
      console.error("⚠ falha ao salvar XML/nota no Apps Script:", e.message);
    }

    res.json({
      ok: true,
      mensagem: "NFC-e estruturada com sucesso.",
      nfce: {
        id: nota.id,
        numero: nota.numero,
        serie: nota.serie,
        chave: nota.chave,
        status: nota.status,
        pdf_url: nota.pdf_url,
        xml_url: nota.xml_url,
        numeracao_origem: numeracaoOrigem,
        xml_salvo_apps_script: xmlSalvoNoAppsScript,
        xml_assinado: assinatura.assinado,
        erro_assinatura: assinatura.erro,
        erro_apps_script: erroAppsScript
      }
    });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e.message || "Erro ao estruturar NFC-e."
    });
  }
});

app.get("/nfce/lista", async (req, res) => {
  const dia = String(req.query.dia || "");
  const mes = String(req.query.mes || "");

  try {
    if (API_BELA_SHEETS) {
      const notas = await listarNfceNotasRemotas({ dia, mes });
      return res.json({ ok: true, total: notas.length, notas });
    }
  } catch (e) {
    console.error("⚠ falha ao listar notas remotas:", e.message);
  }

  const notasLocal = await listarNotasLocal();
  const notasResumo = notasLocal.map(n => ({
    id: n.id,
    numero: n.numero,
    serie: n.serie,
    data: n.dataEmissaoIso || n.data,
    total: n.total,
    cliente: n.cliente?.nome || "",
    status: n.status,
    xml_url: n.xml_url,
    pdf_url: n.pdf_url,
    mesRef: n.mesRef,
    diaRef: n.diaRef || dataDiaRef(n.dataEmissaoIso || n.data || "")
  }));

  return res.json({ ok: true, total: notasResumo.length, notas: notasResumo });
});

async function lerNotaCompleta(id) {
  try {
    if (API_BELA_SHEETS) {
      const notaRemota = await getNfceNotaRemota(id);
      if (notaRemota) return notaRemota;
    }
  } catch (e) {
    console.error("⚠ falha ao ler nota remota:", e.message);
  }

  return await lerNotaLocal(id);
}

app.get("/nfce/:id", async (req, res) => {
  const nota = await lerNotaCompleta(req.params.id);
  if (!nota) return res.status(404).json({ ok: false, error: "Nota não encontrada." });
  res.json({ ok: true, nfce: nota });
});

app.get("/nfce/:id/xml", async (req, res) => {
  const nota = await lerNotaCompleta(req.params.id);
  if (!nota) return res.status(404).type("text/xml").send("<erro>Nota não encontrada</erro>");
  const xmlOriginal = gerarXML(nota);
  const assinatura = tentarAssinarXmlNFe(xmlOriginal);
  res.type("text/xml").send(assinatura.xml);
});

app.get("/nfce/:id/pdf", async (req, res) => {
  const nota = await lerNotaCompleta(req.params.id);
  if (!nota) return res.status(404).send("nota nao encontrada");
  if (!nota.qrCodeUrl && (nota.chaveAcesso || nota.chave)) {
    nota.qrCodeUrl = gerarUrlQRCodeNfce(nota);
  }
  res.type("html").send(gerarHTML(nota));
});

// ====== ROTAS ANTIGAS ======

app.get("/nfce/xml/mes/:mes", async (req, res) => {
  const mes = String(req.params.mes || "");
  return responderZipMes(res, mes);
});

app.get("/nfce/xml/periodo", async (req, res) => {
  const inicio = String(req.query.inicio || "");
  const fim = String(req.query.fim || "");
  return responderZipPeriodo(res, inicio, fim);
});

// ====== ROTAS CURTAS PARA O INDEX ======

app.get("/xml/mes", async (req, res) => {
  const ano = String(req.query.ano || "");
  const mes = String(req.query.mes || "");
  const mesRef = normalizarMes(ano, mes);

  if (!mesRef) {
    return res.status(400).json({ ok: false, error: "Parâmetros ano/mes inválidos." });
  }

  return responderZipMes(res, mesRef);
});

app.get("/xml/periodo", async (req, res) => {
  const inicio = String(req.query.inicio || "");
  const fim = String(req.query.fim || "");

  if (!inicio || !fim) {
    return res.status(400).json({ ok: false, error: "Informe inicio e fim." });
  }

  return responderZipPeriodo(res, inicio, fim);
});

// ================= START =================

ensureDirs()
  .then(carregarSequencial)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bela Caixa API rodando na porta ${PORT}`);
      console.log(`Apps Script configurado: ${API_BELA_SHEETS ? "sim" : "não"}`);
    });
  })
  .catch(err => {
    console.error("Falha ao iniciar API:", err);
    process.exit(1);
  });
