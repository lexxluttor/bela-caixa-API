import express from "express";
import cors from "cors";
import zlib from "zlib";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import https from "https";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { DOMParser } from "xmldom";
import libxmljs from "libxmljs2";
import { criarServicoCancelamento } from "./services/cancelamento.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const BASE_URL = process.env.BASE_URL || "https://bela-caixa-api.onrender.com";
const LOGO_URL = process.env.LOGO_URL || "";
const API_BELA_SHEETS = process.env.API_BELA_SHEETS || "";

const DATA_DIR = path.resolve("./storage");
const NOTAS_DIR = path.join(DATA_DIR, "notas");

// ================= VALIDAÇÃO XSD NFC-e =================
const SCHEMAS_NFE_DIR = path.resolve("./schemas/nfe");
let schemaNfeCache = null;
let schemaNfePathCache = "";

function localizarSchemaNfePrincipal() {
  if (!fs.existsSync(SCHEMAS_NFE_DIR)) {
    throw new Error(`Pasta de schemas não encontrada: ${SCHEMAS_NFE_DIR}`);
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
  percorrer(SCHEMAS_NFE_DIR);

  const preferidos = [
    "nfe_v4.00.xsd",
    "nfe_v4.0.xsd",
    "nfe.xsd"
  ];

  for (const preferido of preferidos) {
    const achado = encontrados.find(p => path.basename(p).toLowerCase() === preferido.toLowerCase());
    if (achado) return achado;
  }

  const candidato = encontrados.find(p => {
    const n = path.basename(p).toLowerCase();
    return n.startsWith("nfe_") && n.includes("4.00") && !n.includes("proc");
  });

  if (candidato) return candidato;
  throw new Error(`Schema principal da NFe 4.00 não encontrado em ${SCHEMAS_NFE_DIR}`);
}

function carregarSchemaNfe() {
  if (schemaNfeCache) return schemaNfeCache;

  const schemaPath = localizarSchemaNfePrincipal();
  const schemaXml = fs.readFileSync(schemaPath, "utf8");
  schemaNfeCache = libxmljs.parseXml(schemaXml, {
    baseUrl: schemaPath,
    noblanks: true,
    nonet: true
  });
  schemaNfePathCache = schemaPath;
  console.log(`✔ schema XSD carregado: ${path.relative(process.cwd(), schemaPath)}`);
  return schemaNfeCache;
}

function formatarErrosXsd(erros = []) {
  return erros.slice(0, 12).map((erro, indice) => {
    const linha = erro.line || erro.lineNumber || "?";
    const coluna = erro.column || erro.columnNumber || "?";
    const mensagem = String(erro.message || erro).replace(/\s+/g, " ").trim();
    return `${indice + 1}. linha ${linha}, coluna ${coluna}: ${mensagem}`;
  });
}

function validarXmlNfeContraXsd(xml) {
  try {
    const schema = carregarSchemaNfe();
    const documento = libxmljs.parseXml(String(xml || ""), { noblanks: true, nonet: true });
    const valido = documento.validate(schema);
    const erros = valido ? [] : formatarErrosXsd(documento.validationErrors || []);

    if (valido) {
      console.log(`✔ XML válido no XSD: ${path.basename(schemaNfePathCache)}`);
    } else {
      console.error("❌ XML inválido no XSD:");
      erros.forEach(e => console.error(`   ${e}`));
    }

    return { valido, erros, schema: schemaNfePathCache };
  } catch (erro) {
    const mensagem = `Falha ao executar validação XSD: ${erro.message}`;
    console.error(`❌ ${mensagem}`);
    return { valido: false, erros: [mensagem], schema: schemaNfePathCache };
  }
}

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
const SEFAZ_CONFIG = {
  habilitada: String(process.env.SEFAZ_HABILITADA || "false").toLowerCase() === "true",
  uf: process.env.SEFAZ_UF || "MG",
  ambiente: process.env.SEFAZ_AMBIENTE || NFCE_CONFIG.tpAmb || "2",
  versao: "4.00",
  idLotePrefixo: process.env.SEFAZ_ID_LOTE_PREFIXO || "1",
  autorizacaoUrl: process.env.SEFAZ_NFCE_AUTORIZACAO_URL || "",
  eventoUrl: process.env.SEFAZ_NFCE_EVENTO_URL || "",
  consultaUrl: process.env.SEFAZ_NFCE_CONSULTA_URL || "",
  timeoutMs: Number(process.env.SEFAZ_TIMEOUT_MS || 30000)
};

// Enquanto SEFAZ_HABILITADA=false, o servidor NÃO transmite nota.
// Quando você liberar NFC-e na SEFAZ/MG, configuramos:
// SEFAZ_HABILITADA=true
// SEFAZ_NFCE_AUTORIZACAO_URL=endpoint homologação/produção correto

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

function gtinValido(v) {
  const gtin = somenteDigitos(v || "");

  // GTIN aceitos no leiaute fiscal: GTIN-8, GTIN-12, GTIN-13 e GTIN-14.
  if (![8, 12, 13, 14].includes(gtin.length)) return false;

  const corpo = gtin.slice(0, -1);
  const digitoInformado = Number(gtin.slice(-1));

  let soma = 0;
  let peso = 3;

  // Cálculo GS1 da direita para a esquerda, alternando pesos 3 e 1.
  for (let i = corpo.length - 1; i >= 0; i--) {
    soma += Number(corpo[i]) * peso;
    peso = peso === 3 ? 1 : 3;
  }

  const digitoCalculado = (10 - (soma % 10)) % 10;
  return digitoCalculado === digitoInformado;
}

function tagEAN(v) {
  const valorOriginal = String(v || "").trim().toUpperCase();

  if (!valorOriginal || valorOriginal === "SEM GTIN") {
    return "SEM GTIN";
  }

  const ean = somenteDigitos(valorOriginal);
  return gtinValido(ean) ? ean : "SEM GTIN";
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
  // O tipo qrCode do XSD aceita o hash em hexadecimal maiúsculo.
  return crypto
    .createHash("sha1")
    .update(String(valor), "utf8")
    .digest("hex")
    .toUpperCase();
}

function normalizarIdCsc(valor) {
  const digitos = somenteDigitos(valor || "");
  if (!digitos) return "";
  if (digitos.length > 6) {
    throw new Error("CSC_ID inválido: informe no máximo 6 dígitos.");
  }
  return digitos.padStart(6, "0");
}

function obterUrlConsultaNfce() {
  const tpAmb = String(NFCE_CONFIG.tpAmb || "2");

  return tpAmb === "2"
    ? "https://hportalsped.fazenda.mg.gov.br/portalnfce"
    : "https://portalsped.fazenda.mg.gov.br/portalnfce";
}

function obterUrlQrCodeNfce() {
  // Em Minas Gerais, o endpoint do QR Code é o mesmo
  // nos ambientes de produção e homologação.
  return "https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml";
}

function gerarUrlQRCodeNfce(nota) {
  const chave = somenteDigitos(nota.chaveAcesso || nota.chave || "");
  const versaoQrCode = "3";
  const tpAmb = String(
    (typeof NFCE_CONFIG !== "undefined" && NFCE_CONFIG.tpAmb)
      ? NFCE_CONFIG.tpAmb
      : "2"
  );
  const urlQrCode = obterUrlQrCodeNfce();

  if (chave.length !== 44) {
    throw new Error(`Chave de acesso inválida para QR Code: esperado 44 dígitos, recebido ${chave.length}.`);
  }

  if (!/^[12]$/.test(tpAmb)) {
    throw new Error(`tpAmb inválido para QR Code: ${tpAmb}. Esperado 1 ou 2.`);
  }

  // QR Code 3.0 em emissão normal/online:
  // chave de acesso | versão 3 | ambiente.
  const parametros = `${chave}|${versaoQrCode}|${tpAmb}`;

  console.log(`✔ QR Code NFC-e v3 preparado | ambiente ${tpAmb}.`);
  return `${urlQrCode}?p=${parametros}`;
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

function compactarXmlAntesDaAssinatura(xml) {
  const original = String(xml || "");

  // Remove somente espaços, tabs e quebras de linha existentes ENTRE tags.
  // Conteúdos de campos, CDATA do QR Code e valores de atributos são preservados.
  const compacto = original
    .replace(/>\s+</g, "><")
    .trim();

  console.log("✔ XML preparado para assinatura.");

  return compacto;
}

function assinarXmlNFe(xml) {
  const cert = carregarCertificadoFiscal();
  const xmlCompacto = compactarXmlAntesDaAssinatura(xml);
  const id = obterIdInfNFe(xmlCompacto);

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

  sig.computeSignature(xmlCompacto, {
    location: {
      reference: "//*[local-name(.)='NFe']",
      action: "append"
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

// ================= UTILITÁRIOS =================

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

function normalizarFormaPagamentoTexto(valor = "") {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function extrairFormaPagamentoPayload(body = {}) {
  const pagamento = body.pagamento;

  const candidatos = [
    pagamento && typeof pagamento === "object" ? pagamento.tipo : "",
    pagamento && typeof pagamento === "object" ? pagamento.forma : "",
    pagamento && typeof pagamento === "object" ? pagamento.metodo : "",
    typeof pagamento === "string" ? pagamento : "",
    body.forma_pagamento,
    body.formaPagamento,
    body.tipo_pagamento,
    body.tipoPagamento,
    body.metodo_pagamento,
    body.metodoPagamento
  ];

  const encontrado = candidatos.find(v => String(v ?? "").trim() !== "");
  return encontrado || "DINHEIRO";
}

function mapearFormaPagamentoFiscal(tipo = "") {
  const t = normalizarFormaPagamentoTexto(tipo);

  const mapaExato = new Map([
    ["DINHEIRO", "01"],
    ["CREDITO", "03"],
    ["CARTAO DE CREDITO", "03"],
    ["CARTAO CREDITO", "03"],
    ["DEBITO", "04"],
    ["CARTAO DE DEBITO", "04"],
    ["CARTAO DEBITO", "04"],
    ["CREDIARIO", "05"],
    ["CREDIARIO NOVO", "05"],
    ["FIADO", "05"],
    ["VENDA FIADO", "05"],
    ["A PRAZO", "05"],
    ["PIX", "17"]
  ]);

  const codigo = mapaExato.get(t);
  if (codigo) return codigo;

  // Compatibilidade com rótulos maiores enviados pelo caixa.
  if (/\bPIX\b/.test(t)) return "17";
  if (/\bDINHEIRO\b/.test(t)) return "01";
  if (/\bDEBITO\b/.test(t)) return "04";
  if (/\bCREDITO\b/.test(t)) return "03";
  if (/\b(CREDIARIO|FIADO)\b/.test(t) || /\bA PRAZO\b/.test(t)) return "05";

  throw new Error(`Forma de pagamento fiscal não reconhecida: "${tipo}".`);
}

function gerarDetalhePagamentoFiscal(nota = {}) {
  const formaRecebida = nota.pagamento?.tipo || "";
  const tPag = mapearFormaPagamentoFiscal(formaRecebida);
  const vPag = dinheiro(nota.pagamento?.valor ?? nota.total);
  const exigeGrupoCard = tPag === "03" || tPag === "04" || tPag === "17";
  const indPag = tPag === "05" ? "1" : "0";

  const grupoCartao = exigeGrupoCard
    ? `<card><tpIntegra>2</tpIntegra></card>`
    : "";

  console.log(
    `[NFC-e] Pagamento recebido: ${normalizarFormaPagamentoTexto(formaRecebida)} | tPag ${tPag} | card ${exigeGrupoCard ? "SIM" : "NÃO"}`
  );

  return `<detPag><indPag>${indPag}</indPag><tPag>${tPag}</tPag><vPag>${vPag}</vPag>${grupoCartao}</detPag>`;
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
    protocolo: nota.protocolo || nota.sefaz?.nProt || "",
    cStat: nota.sefaz?.cStat || "",
    xMotivo: nota.sefaz?.xMotivo || "",
    dhRecbto: nota.sefaz?.dhRecbto || "",
    autorizado: nota.sefaz?.autorizado === true || nota.status === "autorizada",
    xmlAutorizado: nota.xml_autorizado || "",
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

async function getVendaRemota(id) {
  if (!API_BELA_SHEETS) throw new Error("API_BELA_SHEETS não configurada");

  const url = montarUrlAppsScript("getVenda", { id });
  const data = await fetchJson(url);
  return data.venda || null;
}

function sanitizarTextoFiscalReemissao(valor = "") {
  return String(valor ?? "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function prepararItemReemissao(item = {}) {
  const quantidade = numeroFiscalPadrao(item.qtd ?? item.quantidade ?? item.qty, 1);
  const valorUnitario = numeroFiscalPadrao(
    item.valorUnitario ?? item.preco ?? item.valor_unitario ?? item.valor,
    0
  );
  const valorTotalRecebido = numeroFiscalPadrao(
    item.valorTotal ?? item.total_item ?? item.totalItem,
    0
  );
  const valorTotal = valorTotalRecebido > 0
    ? valorTotalRecebido
    : Number((quantidade * valorUnitario).toFixed(2));

  const descricao = sanitizarTextoFiscalReemissao(
    item.descricao || item.nome || item.desc || "PRODUTO"
  );

  return {
    ...item,
    descricao,
    nome: descricao,
    desc: descricao,
    qtd: quantidade,
    quantidade,
    valorUnitario,
    preco: valorUnitario,
    valorTotal
  };
}

function montarPayloadReemissaoVenda(venda = {}, vendaId = "") {
  const itensOriginais = Array.isArray(venda.itens) ? venda.itens : [];

  if (!itensOriginais.length) {
    throw new Error("A venda foi encontrada, mas não possui itens para recriar a NFC-e.");
  }

  const itens = itensOriginais.map(prepararItemReemissao);
  const totalItens = itens.reduce((soma, item) => soma + Number(item.valorTotal || 0), 0);
  const totalVenda = Number(venda.total || totalItens || 0);

  console.log(
    `[NFC-e] Reemissão reconstruída: ${itens.length} item(ns) | total itens R$ ${totalItens.toFixed(2)} | total venda R$ ${totalVenda.toFixed(2)}`
  );

  return {
    vendaId: String(venda.vendaId || venda.id || vendaId),
    dataVenda: venda.dataVenda || venda.data || new Date().toISOString(),
    cliente: venda.cliente || "CONSUMIDOR NAO IDENTIFICADO",
    itens,
    total: totalVenda,
    pagamento: {
      tipo: venda.forma_pagamento || venda.formaPagamento || "DINHEIRO",
      valor: totalVenda
    }
  };
}

function notaLocalSemTransmissaoPodeSerRecriada(nota = {}) {
  const status = String(nota.status || "").trim().toLowerCase();
  const sefaz = nota.sefaz || {};
  const protocolo = String(nota.protocolo || sefaz.nProt || "").trim();
  const autorizada =
    status === "autorizada" ||
    sefaz.autorizado === true ||
    protocolo !== "";
  const transmitida = sefaz.transmitido === true;

  if (autorizada || transmitida) return false;

  return [
    "emitida_homologacao",
    "emitida",
    "pendente",
    "erro_xsd",
    "xml_invalido",
    "rejeitada_localmente"
  ].includes(status);
}

async function recriarEEmitirNfcePorVenda(vendaId) {
  const venda = await getVendaRemota(vendaId);
  if (!venda) return null;

  const payload = montarPayloadReemissaoVenda(venda, vendaId);
  const resposta = await fetch(`${BASE_URL}/nfce/emitir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const texto = await resposta.text();
  let dados = {};
  try {
    dados = texto ? JSON.parse(texto) : {};
  } catch {
    dados = { ok: false, error: "Resposta inválida ao recriar a NFC-e." };
  }

  dados.recriada = true;
  dados.vendaId = String(vendaId);
  dados.mensagem_recriacao = "A nota original não foi encontrada. Uma nova NFC-e foi gerada a partir da venda salva.";

  return {
    status: resposta.status,
    dados
  };
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
  const pagamentoObjeto = body.pagamento && typeof body.pagamento === "object" ? body.pagamento : {};
  const pagamentoValor =
    pagamentoObjeto.valor != null
      ? Number(pagamentoObjeto.valor)
      : body.valor_pagamento != null
        ? Number(body.valor_pagamento)
        : total;
  const pagamentoTipo = extrairFormaPagamentoPayload(body);

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
      tipo: normalizarFormaPagamentoTexto(pagamentoTipo),
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
    const descricaoProduto =
      String(NFCE_CONFIG.tpAmb) === "2" && idx === 0
        ? "NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL"
        : String(item.descricao || "PRODUTO");

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
        <xProd>${esc(descricaoProduto)}</xProd>
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
      ${gerarDetalhePagamentoFiscal(nota)}
    </pag>
    <infAdic>
      <infCpl>DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. ${textoHomologacao()}.</infCpl>
    </infAdic>
  </infNFe>
  <infNFeSupl>
    <qrCode><![CDATA[${qrCodeUrl}]]></qrCode>
    <urlChave>${obterUrlConsultaNfce()}</urlChave>
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
    return `
<tr>
  <td class="desc">${esc(item.descricao)}</td>
  <td class="qtd">${Number(item.quantidade || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 3 })}</td>
  <td class="vl">R$ ${moeda(item.valorTotal || 0)}</td>
</tr>
<tr>
  <td colspan="3" class="cod">${esc(item.ean || item.codigo || "-")}</td>
</tr>`;
  }).join("");

  const qtdItens = (nota.itens || []).reduce((s, item) => s + Number(item.quantidade || 0), 0);
  const chave = nota.chaveAcesso || nota.chave || nota.id || "";
  const chaveFormatada = String(chave).replace(/\D/g, "").replace(/(.{4})/g, "$1 ").trim();
  const protocolo = nota.protocolo || nota.sefaz?.nProt || "";
  const ambiente = NFCE_CONFIG.tpAmb === "1" ? "PRODUÇÃO" : "HOMOLOGAÇÃO";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>NFC-e ${nota.numero}</title>
<style>
*{box-sizing:border-box;}
body{margin:0;padding:0;background:#f4f4f4;color:#000;font-family:Arial, Helvetica, sans-serif;}
.cupom{width:80mm;max-width:80mm;margin:8px auto;background:#fff;padding:7px;font-size:11px;line-height:1.25;}
.center{text-align:center;}
.loja{font-size:20px;font-weight:900;letter-spacing:.4px;margin-bottom:3px;}
.empresa{font-size:10.5px;line-height:1.35;}
.sep{border-top:1px dashed #000;margin:7px 0;}
.titulo{text-align:center;font-size:12px;font-weight:900;line-height:1.25;margin:4px 0;}
.subtitulo{text-align:center;font-size:10px;line-height:1.25;}
.info{font-size:10.5px;line-height:1.5;}
table{width:100%;border-collapse:collapse;font-size:10.5px;}
th{border-bottom:1px solid #000;padding:3px 0;font-size:9.5px;text-align:left;}
td{padding:2px 0;vertical-align:top;}
.desc{width:auto;}
.qtd{width:35px;text-align:center;}
.vl{width:70px;text-align:right;font-weight:700;}
.cod{color:#555;font-size:9px;padding-bottom:4px;}
.linha{display:flex;justify-content:space-between;gap:10px;margin:3px 0;font-size:11px;}
.total{display:flex;justify-content:space-between;align-items:center;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:6px 0;margin:6px 0;}
.total .label{font-size:15px;font-weight:900;}
.total .valor{font-size:18px;font-weight:900;}
.pagamento{font-size:10.5px;line-height:1.45;}
.chave{text-align:center;font-size:9.5px;word-break:break-word;line-height:1.35;}
.qrcode{text-align:center;margin:8px 0 5px;}
.qrcode img{width:112px;height:112px;}
.qr-info{font-size:9.5px;text-align:center;line-height:1.35;}
.msg{text-align:center;font-size:10.5px;line-height:1.45;}
.deus{font-size:12px;font-weight:900;}
.redes{margin-top:5px;font-size:10px;font-weight:700;}
.rodape{text-align:center;font-size:9px;line-height:1.35;color:#333;}
.btns{margin:12px auto;display:flex;justify-content:center;gap:8px;}
button{border:none;background:#111;color:#fff;padding:8px 12px;border-radius:6px;cursor:pointer;font-size:12px;}
@page{size:80mm auto;margin:2mm;}
@media print{body{background:#fff;}.cupom{width:80mm;max-width:80mm;margin:0 auto;}.btns{display:none;}}
</style>
</head>
<body>
<div class="cupom">
  <div class="center">
    <div class="loja">BELA MODAS</div>
    <div class="empresa">
      ${esc(EMPRESA.razao_social)}<br>
      CNPJ ${formatarCNPJ(EMPRESA.cnpj)} &nbsp; IE ${esc(EMPRESA.ie)}<br>
      ${esc(EMPRESA.logradouro)}, ${esc(EMPRESA.numero)} - ${esc(EMPRESA.bairro)}<br>
      ${esc(EMPRESA.cidade)}/${esc(EMPRESA.uf)} - CEP ${formatarCEP(EMPRESA.cep)}<br>
      Tel ${formatarTelefone(EMPRESA.fone)}
    </div>
  </div>
  <div class="sep"></div>
  <div class="titulo">DANFE NFC-e</div>
  <div class="subtitulo">Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</div>
  <div class="sep"></div>
  <div class="info">
    <strong>Nº:</strong> ${nota.numero} &nbsp; <strong>Série:</strong> ${nota.serie}<br>
    <strong>Emissão:</strong> ${esc(nota.dataEmissaoBR)}<br>
    <strong>Cliente:</strong> ${esc(nota.cliente?.nome || "Consumidor")}
  </div>
  <div class="sep"></div>
  <table>
    <thead><tr><th>Descrição</th><th class="qtd">Qtd</th><th class="vl">Total</th></tr></thead>
    <tbody>${itens}</tbody>
  </table>
  <div class="sep"></div>
  <div class="linha"><span>Qtd. itens</span><strong>${qtdItens}</strong></div>
  <div class="linha"><span>Subtotal</span><strong>R$ ${moeda(nota.subtotal || nota.total || 0)}</strong></div>
  <div class="linha"><span>Desconto</span><strong>R$ ${moeda(nota.desconto || 0)}</strong></div>
  <div class="total"><span class="label">TOTAL</span><span class="valor">R$ ${moeda(nota.total || 0)}</span></div>
  <div class="pagamento">
    <strong>Forma de pagamento:</strong> ${esc(nota.pagamento?.tipo || "DINHEIRO")}<br>
    <strong>Valor pago:</strong> R$ ${moeda(nota.pagamento?.valor || nota.total || 0)}
  </div>
  <div class="sep"></div>
  <div class="qrcode">${nota.qrCodeUrl ? `<img src="${gerarImagemQRCodeUrl(nota.qrCodeUrl)}" alt="QR Code NFC-e">` : "QR CODE NFC-e"}</div>
  <div class="qr-info">Consulte pela chave de acesso em:<br>${esc(obterUrlConsultaNfce())}</div>
  <div class="chave"><strong>CHAVE DE ACESSO</strong><br>${esc(chaveFormatada || chave)}</div>
  <div class="qr-info" style="margin-top:5px;">${protocolo ? `Protocolo: ${esc(protocolo)}<br>` : ""}Ambiente: ${esc(ambiente)} · XML 4.00</div>
  <div class="sep"></div>
  <div class="msg">
    <div class="deus">DEUS É FIEL</div>
    Agradecemos a preferência! Volte sempre!<br>
    Aceitamos trocas em até 15 dias mediante apresentação deste cupom.
    <div class="redes">@bela_modas9169<br>@belamodaspetro<br>WhatsApp (31) 99733-7304</div>
  </div>
  <div class="sep"></div>
  <div class="rodape">
    Documento emitido por ME/EPP optante pelo Simples Nacional.<br>
    ${esc(textoHomologacao())}.<br>
    Impresso em ${esc(nota.dataEmissaoBR)}
  </div>
</div>
<div class="btns"><button onclick="window.print()">Imprimir</button><button onclick="window.close()">Fechar</button></div>
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



// ================= ESTABILIDADE NFC-E =================

function notaJaAutorizada(nota = {}) {
  return !!(
    String(nota.status || "").toLowerCase() === "autorizada" ||
    String(nota.sefaz?.cStat || "") === "100" ||
    obterProtocoloAutorizacao(nota)
  );
}

function notaJaCancelada(nota = {}) {
  const status = String(nota.status || "").toLowerCase();
  return (
    status.includes("cancel") ||
    String(nota.cancelamento?.cStat || "") === "135" ||
    String(nota.cancelamento?.cStat || "") === "155"
  );
}

function criarResumoFiscal(nota = {}) {
  return {
    status: nota.status || "",
    numero: nota.numero || "",
    serie: nota.serie || "",
    chave: nota.chaveAcesso || nota.chave || "",
    protocolo: nota.protocolo || nota.sefaz?.nProt || "",
    autorizada: notaJaAutorizada(nota),
    cancelada: notaJaCancelada(nota),
    cStat: nota.sefaz?.cStat || "",
    xMotivo: nota.sefaz?.xMotivo || ""
  };
}


// ================= SEFAZ / AUTORIZAÇÃO NFC-E =================
//
// Camada preparada para transmissão SEFAZ.
// Segurança: enquanto SEFAZ_HABILITADA=false, não envia nada.

function gerarIdLoteNfce(nota = {}) {
  const numero = String(nota.numero || Date.now()).replace(/\D+/g, "");
  const base = String(SEFAZ_CONFIG.idLotePrefixo || "1") + numero;
  return base.slice(-15).padStart(15, "0");
}

function montarEnvelopeSoapNfeAutorizacao(xmlAssinado, idLote) {
  const xmlLimpo = String(xmlAssinado || "")
    .replace(/<\?xml[^>]*\?>/i, "")
    .trim();

  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <idLote>${esc(idLote)}</idLote>
        <indSinc>1</indSinc>
        ${xmlLimpo}
      </enviNFe>
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`;
}

function httpsPostComCertificado(url, body, headers = {}) {
  return new Promise(function(resolve, reject) {
    let credenciaisTls;

    try {
      // O PFX já foi lido pelo node-forge para assinar o XML. Para a conexão
      // HTTPS, usamos a chave e o certificado em PEM, evitando que o OpenSSL
      // do Node tente interpretar novamente o PKCS#12 e gere
      // "Unsupported PKCS12 PFX data".
      credenciaisTls = carregarCertificadoFiscal();
    } catch (err) {
      return reject(new Error("Não foi possível preparar o certificado para a conexão SEFAZ: " + err.message));
    }

    const parsed = new URL(url);

    console.log(`[SEFAZ] Conectando a ${parsed.hostname}:${parsed.port || 443} com certificado A1.`);

    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      key: credenciaisTls.privateKeyPem,
      cert: credenciaisTls.certificatePem,
      rejectUnauthorized: true,
      timeout: SEFAZ_CONFIG.timeoutMs,
      headers: Object.assign({
        "Content-Type": "application/soap+xml; charset=utf-8",
        "Content-Length": Buffer.byteLength(body, "utf8")
      }, headers)
    };

    // Diagnóstico de transporte: registra exatamente o destino e os headers
    // enviados, sem expor chave privada, certificado ou senha.
    console.log("========== REQUISIÇÃO HTTPS SEFAZ ====================");
    console.log({
      method: options.method,
      url: parsed.toString(),
      protocol: options.protocol,
      hostname: options.hostname,
      port: options.port,
      path: options.path,
      timeoutMs: options.timeout,
      headers: options.headers,
      bodyBytes: Buffer.byteLength(body, "utf8")
    });
    console.log("======================================================");

    const req = https.request(options, function(res) {
      let chunks = "";
      res.setEncoding("utf8");

      res.on("data", function(chunk) {
        chunks += chunk;
      });

      res.on("end", function() {
        console.log("========== RESPOSTA HTTPS SEFAZ ======================");
        console.log({
          statusCode: res.statusCode,
          headers: res.headers,
          bodyBytes: Buffer.byteLength(chunks, "utf8")
        });
        console.log(chunks);
        console.log("======================================================");

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: chunks
        });
      });
    });

    req.on("timeout", function() {
      req.destroy(new Error("Timeout ao conectar na SEFAZ."));
    });

    req.on("error", reject);
    req.write(body, "utf8");
    req.end();
  });
}

function extrairTagXml(texto, tag) {
  const re = new RegExp("<(?:\\w+:)?" + tag + "[^>]*>([\\s\\S]*?)</(?:\\w+:)?" + tag + ">", "i");
  const m = String(texto || "").match(re);
  return m ? m[1].trim() : "";
}

function extrairRetornoSefaz(xmlRetorno) {
  const xml = String(xmlRetorno || "");

  // A resposta pode trazer dois cStat:
  // - retEnviNFe: 104 (lote processado)
  // - protNFe/infProt: 100 (NFC-e autorizada)
  // O status real da nota deve vir de infProt, não do lote.
  const protMatch = xml.match(/<(?:\w+:)?protNFe\b[\s\S]*?<\/(?:\w+:)?protNFe>/i);
  const xmlProtocolo = protMatch ? protMatch[0] : "";

  const cStatLote = extrairTagXml(xml, "cStat");
  const xMotivoLote = extrairTagXml(xml, "xMotivo");

  const cStatProtocolo = xmlProtocolo ? extrairTagXml(xmlProtocolo, "cStat") : "";
  const xMotivoProtocolo = xmlProtocolo ? extrairTagXml(xmlProtocolo, "xMotivo") : "";

  const cStat = cStatProtocolo || cStatLote;
  const xMotivo = xMotivoProtocolo || xMotivoLote;
  const nRec = extrairTagXml(xml, "nRec");
  const nProt = extrairTagXml(xmlProtocolo || xml, "nProt");
  const chNFe = extrairTagXml(xmlProtocolo || xml, "chNFe");
  const dhRecbto = extrairTagXml(xmlProtocolo || xml, "dhRecbto");

  // Só existe autorização fiscal quando o protocolo individual da nota
  // retorna cStat 100 e traz número de protocolo. O cStat 104 significa
  // apenas que o lote foi processado e nunca deve virar status autorizado.
  const autorizado = cStatProtocolo === "100" && !!nProt;

  return {
    cStat,
    xMotivo,
    cStatLote,
    xMotivoLote,
    cStatProtocolo,
    xMotivoProtocolo,
    nRec,
    nProt,
    chNFe,
    dhRecbto,
    autorizado,
    recebido: cStatLote === "103" || cStatLote === "104" || !!nRec
  };
}

function montarNfeProc(xmlAssinado, xmlRetorno) {
  const protMatch = String(xmlRetorno || "").match(/<(?:\w+:)?protNFe\b[\s\S]*?<\/(?:\w+:)?protNFe>/i);
  if (!protMatch) return "";

  const nfeSemDecl = String(xmlAssinado || "").replace(/<\?xml[^>]*\?>/i, "").trim();

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
${nfeSemDecl}
${protMatch[0]}
</nfeProc>`;
}

async function transmitirNfceSefaz(nota, xmlAssinado) {
  if (!SEFAZ_CONFIG.habilitada) {
    return {
      ok: false,
      transmitido: false,
      pendente_habilitacao: true,
      cStat: "",
      xMotivo: "SEFAZ ainda não habilitada no sistema. Configure SEFAZ_HABILITADA=true somente após liberar NFC-e na SEFAZ.",
      xmlRetorno: "",
      nfeProc: ""
    };
  }

  if (!SEFAZ_CONFIG.autorizacaoUrl) {
    return {
      ok: false,
      transmitido: false,
      pendente_configuracao: true,
      cStat: "",
      xMotivo: "SEFAZ_NFCE_AUTORIZACAO_URL não configurada no Render.",
      xmlRetorno: "",
      nfeProc: ""
    };
  }

  carregarCertificadoFiscal();

  const idLote = gerarIdLoteNfce(nota);
  const envelope = montarEnvelopeSoapNfeAutorizacao(xmlAssinado, idLote);

  const resposta = await httpsPostComCertificado(SEFAZ_CONFIG.autorizacaoUrl, envelope, {
    "SOAPAction": ""
  });

  const retorno = extrairRetornoSefaz(resposta.body);
  console.log(
    `[SEFAZ] NFC-e ${nota.numero}: HTTP ${resposta.statusCode} | cStat ${retorno.cStat || "?"} | ${retorno.xMotivo || "sem motivo"}${retorno.nProt ? ` | protocolo ${retorno.nProt}` : ""}`
  );
  const nfeProc = retorno.autorizado ? montarNfeProc(xmlAssinado, resposta.body) : "";

  return {
    ok: resposta.statusCode >= 200 && resposta.statusCode < 300,
    transmitido: true,
    idLote,
    httpStatus: resposta.statusCode,
    ...retorno,
    xmlRetorno: resposta.body,
    nfeProc
  };
}

async function salvarRetornoSefazLocal(nota, retornoSefaz) {
  const atual = await lerNotaLocal(nota.id) || nota;

  atual.sefaz = {
    transmitido: !!retornoSefaz.transmitido,
    autorizado: !!retornoSefaz.autorizado,
    cStat: retornoSefaz.cStat || "",
    xMotivo: retornoSefaz.xMotivo || "",
    nRec: retornoSefaz.nRec || "",
    nProt: retornoSefaz.nProt || "",
    chNFe: retornoSefaz.chNFe || "",
    dhRecbto: retornoSefaz.dhRecbto || "",
    httpStatus: retornoSefaz.httpStatus || "",
    atualizadoEm: new Date().toISOString()
  };

  if (retornoSefaz.autorizado) {
    atual.status = "autorizada";
    atual.protocolo = retornoSefaz.nProt || "";
    atual.xml_autorizado = retornoSefaz.nfeProc || "";
    atual.autorizada_em = new Date().toISOString();
  } else if (retornoSefaz.transmitido) {
    atual.status = retornoSefaz.cStat ? "rejeitada" : "pendente";
  }

  atual.resumoFiscal = criarResumoFiscal(atual);

  await salvarNota(atual);

  // Atualiza no Apps Script a mesma nota após o retorno da SEFAZ.
  // Isso preserva protocolo, cStat e XML autorizado para cancelamento/reimpressão.
  if (API_BELA_SHEETS) {
    let ultimoErro = null;

    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        await salvarXmlNfceRemoto(
          atual,
          atual.xml_autorizado || atual.xml || ""
        );
        ultimoErro = null;
        break;
      } catch (e) {
        ultimoErro = e;
        if (tentativa < 3) {
          await new Promise(resolve => setTimeout(resolve, tentativa * 1000));
        }
      }
    }

    if (ultimoErro) {
      console.error(
        "⚠ autorização salva localmente, mas não foi atualizada no Apps Script:",
        ultimoErro.message
      );
    }
  }

  return atual;
}





// ================= VALIDAÇÃO XSD EVENTO DE CANCELAMENTO =================


function obterUrlConsultaProtocoloSefaz() {
  if (SEFAZ_CONFIG.consultaUrl) {
    return SEFAZ_CONFIG.consultaUrl;
  }

  // Tenta aproveitar o mesmo host/caminho configurado para Recepção de Evento.
  // Exemplo:
  // .../NFeRecepcaoEvento4 -> .../NFeConsultaProtocolo4
  if (SEFAZ_CONFIG.eventoUrl) {
    const inferida = String(SEFAZ_CONFIG.eventoUrl)
      .replace(/NFeRecepcaoEvento4/gi, "NFeConsultaProtocolo4")
      .replace(/RecepcaoEvento4/gi, "NFeConsultaProtocolo4");

    if (inferida !== SEFAZ_CONFIG.eventoUrl) {
      return inferida;
    }
  }

  return "";
}

function montarEnvelopeSoapConsultaProtocolo(chave) {
  const chaveLimpa = somenteDigitos(chave || "");

  if (chaveLimpa.length !== 44) {
    throw new Error("Chave de acesso inválida para consulta na SEFAZ.");
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">
      <consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>${NFCE_CONFIG.tpAmb}</tpAmb>
        <xServ>CONSULTAR</xServ>
        <chNFe>${chaveLimpa}</chNFe>
      </consSitNFe>
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`;
}

function nomeLocalXml(no) {
  return no
    ? (no.localName || String(no.nodeName || "").split(":").pop())
    : "";
}

function textoFilhoDiretoXml(elemento, nomeTag) {
  if (!elemento) return "";

  for (let i = 0; i < elemento.childNodes.length; i++) {
    const filho = elemento.childNodes[i];
    if (filho.nodeType === 1 && nomeLocalXml(filho) === nomeTag) {
      return String(filho.textContent || "").trim();
    }
  }

  return "";
}

function primeiroDescendenteXml(elemento, nomeTag) {
  if (!elemento) return null;

  const todos = elemento.getElementsByTagName("*");
  for (let i = 0; i < todos.length; i++) {
    if (nomeLocalXml(todos[i]) === nomeTag) {
      return todos[i];
    }
  }

  return null;
}

function extrairConsultaProtocoloSefaz(xmlRetorno) {
  const xml = String(xmlRetorno || "");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const todos = doc.getElementsByTagName("*");

  let retConsSitNFe = null;

  for (let i = 0; i < todos.length; i++) {
    if (nomeLocalXml(todos[i]) === "retConsSitNFe") {
      retConsSitNFe = todos[i];
      break;
    }
  }

  if (!retConsSitNFe) {
    throw new Error("A SEFAZ respondeu sem a tag retConsSitNFe.");
  }

  const protocoloNFe = primeiroDescendenteXml(retConsSitNFe, "infProt");

  const autorizacao = protocoloNFe
    ? {
        cStat: textoFilhoDiretoXml(protocoloNFe, "cStat"),
        xMotivo: textoFilhoDiretoXml(protocoloNFe, "xMotivo"),
        chNFe: textoFilhoDiretoXml(protocoloNFe, "chNFe"),
        nProt: textoFilhoDiretoXml(protocoloNFe, "nProt"),
        dhRecbto: textoFilhoDiretoXml(protocoloNFe, "dhRecbto")
      }
    : null;

  const eventos = [];

  for (let i = 0; i < todos.length; i++) {
    if (nomeLocalXml(todos[i]) !== "procEventoNFe") continue;

    const infEvento = primeiroDescendenteXml(todos[i], "infEvento");
    if (!infEvento) continue;

    eventos.push({
      cStat: textoFilhoDiretoXml(infEvento, "cStat"),
      xMotivo: textoFilhoDiretoXml(infEvento, "xMotivo"),
      chNFe: textoFilhoDiretoXml(infEvento, "chNFe"),
      tpEvento: textoFilhoDiretoXml(infEvento, "tpEvento"),
      xEvento: textoFilhoDiretoXml(infEvento, "xEvento"),
      nSeqEvento: textoFilhoDiretoXml(infEvento, "nSeqEvento"),
      nProt: textoFilhoDiretoXml(infEvento, "nProt"),
      dhRegEvento: textoFilhoDiretoXml(infEvento, "dhRegEvento")
    });
  }

  const cancelamentos = eventos.filter(evento =>
    evento.tpEvento === "110111" ||
    String(evento.xEvento || "").toUpperCase().includes("CANCEL")
  );

  return {
    tpAmb: textoFilhoDiretoXml(retConsSitNFe, "tpAmb"),
    verAplic: textoFilhoDiretoXml(retConsSitNFe, "verAplic"),
    cStat: textoFilhoDiretoXml(retConsSitNFe, "cStat"),
    xMotivo: textoFilhoDiretoXml(retConsSitNFe, "xMotivo"),
    chNFe: textoFilhoDiretoXml(retConsSitNFe, "chNFe"),
    autorizacao,
    eventos,
    cancelamentos,
    cancelada: cancelamentos.some(evento =>
      evento.cStat === "135" || evento.cStat === "155"
    )
  };
}

async function consultarSituacaoNfceSefaz(nota = {}) {
  if (!SEFAZ_CONFIG.habilitada) {
    throw new Error("SEFAZ ainda não habilitada no sistema.");
  }

  const consultaUrl = obterUrlConsultaProtocoloSefaz();

  if (!consultaUrl) {
    throw new Error(
      "URL de consulta não configurada. Defina SEFAZ_NFCE_CONSULTA_URL no Render."
    );
  }

  const chave = somenteDigitos(nota.chaveAcesso || nota.chave || "");
  const envelope = montarEnvelopeSoapConsultaProtocolo(chave);

  console.log(`→ Consulta SEFAZ NFC-e ${nota.numero || ""} | chave ${chave}`);

  const resposta = await httpsPostComCertificado(consultaUrl, envelope, {
    "SOAPAction": ""
  });

  console.log("================ RETORNO CONSULTA SEFAZ ================");
  console.log(resposta.body);
  console.log("========================================================");

  const dados = extrairConsultaProtocoloSefaz(resposta.body);
  const httpOk = resposta.statusCode >= 200 && resposta.statusCode < 300;

  return {
    ok: httpOk,
    transmitido: true,
    httpStatus: resposta.statusCode,
    consultaUrl,
    ...dados,
    xmlRetorno: resposta.body
  };
}

// ================= CANCELAMENTO NFC-E =================
//
// Preparado para cancelamento por evento 110111.
// Segurança: enquanto SEFAZ_HABILITADA=false, não transmite cancelamento.


// Inicializa o módulo de cancelamento com as dependências já usadas pelo servidor.
// A emissão permanece no server.js sem alteração de lógica.
const {
  motivoCancelamentoValido,
  obterProtocoloAutorizacao,
  notaEstaAutorizadaParaCancelar,
  gerarXmlEventoCancelamento,
  tentarAssinarXmlEvento,
  transmitirCancelamentoSefaz,
  salvarCancelamentoLocal
} = criarServicoCancelamento({
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
});

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


app.get("/xsd/status", (req, res) => {
  try {
    carregarSchemaNfe();
    res.json({
      ok: true,
      pasta: SCHEMAS_NFE_DIR,
      schema_principal: schemaNfePathCache,
      carregado: true
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      pasta: SCHEMAS_NFE_DIR,
      carregado: false,
      error: e.message
    });
  }
});

app.get("/sefaz/status", (req, res) => {
  res.json({
    ok: true,
    uf: SEFAZ_CONFIG.uf,
    ambiente: SEFAZ_CONFIG.ambiente,
    habilitada: SEFAZ_CONFIG.habilitada,
    autorizacao_url_configurada: !!SEFAZ_CONFIG.autorizacaoUrl,
    evento_url_configurada: !!SEFAZ_CONFIG.eventoUrl,
    certificado_carregado: !!certificado,
    senha_configurada: !!CERT_PASSWORD,
    pronto_para_transmitir: !!(SEFAZ_CONFIG.habilitada && SEFAZ_CONFIG.autorizacaoUrl && certificado && CERT_PASSWORD),
    aviso: SEFAZ_CONFIG.habilitada
      ? "SEFAZ habilitada para tentativa de transmissão."
      : "SEFAZ ainda bloqueada por segurança. Configure SEFAZ_HABILITADA=true apenas quando liberar NFC-e na SEFAZ."
  });
});

app.post("/nfce/:id/enviar-sefaz", async (req, res) => {
  try {
    const nota = await lerNotaCompleta(req.params.id);
    if (!nota) {
      console.warn(`[NFC-e] Nota ${req.params.id} não encontrada. Tentando recriar pela venda original.`);

      const recriacao = await recriarEEmitirNfcePorVenda(req.params.id);
      if (!recriacao) {
        return res.status(404).json({
          ok: false,
          error: "Nota e venda original não encontradas. Não foi possível recriar a NFC-e."
        });
      }

      return res.status(recriacao.status).json(recriacao.dados);
    }

    // Se a tentativa anterior parou localmente antes de chegar à SEFAZ
    // (por exemplo, erro de XSD), não reutiliza o XML antigo. Reconstrói
    // a NFC-e pela venda original, gerando nova data, número, chave e XML.
    if (notaLocalSemTransmissaoPodeSerRecriada(nota)) {
      const vendaId = String(nota.vendaId || req.params.id);
      console.warn(
        `[NFC-e] Nota ${req.params.id} existe, mas não foi transmitida à SEFAZ. ` +
        `Descartando a tentativa local e recriando pela venda ${vendaId}.`
      );

      const recriacao = await recriarEEmitirNfcePorVenda(vendaId);
      if (recriacao) {
        recriacao.dados.tentativa_local_descartada = true;
        recriacao.dados.id_tentativa_anterior = String(req.params.id);
        return res.status(recriacao.status).json(recriacao.dados);
      }

      console.warn(
        `[NFC-e] Venda ${vendaId} não encontrada para recriação. ` +
        "Mantendo o fluxo da nota existente."
      );
    }

    const xmlOriginal = gerarXML(nota);
    const assinatura = tentarAssinarXmlNFe(xmlOriginal);

    if (!assinatura.assinado) {
      return res.status(400).json({
        ok: false,
        error: "XML não foi assinado. Não é seguro enviar para a SEFAZ.",
        erro_assinatura: assinatura.erro
      });
    }

    const validacaoXsd = validarXmlNfeContraXsd(assinatura.xml);
    if (!validacaoXsd.valido) {
      return res.status(400).json({
        ok: false,
        error: "XML assinado inválido no schema XSD. A NFC-e não foi enviada à SEFAZ.",
        erros_xsd: validacaoXsd.erros,
        schema_xsd: validacaoXsd.schema ? path.basename(validacaoXsd.schema) : ""
      });
    }

    const retornoSefaz = await transmitirNfceSefaz(nota, assinatura.xml);
    await salvarRetornoSefazLocal(nota, retornoSefaz);

    res.json({
      ok: retornoSefaz.ok,
      transmitido: retornoSefaz.transmitido,
      autorizado: retornoSefaz.autorizado,
      pendente_habilitacao: !!retornoSefaz.pendente_habilitacao,
      pendente_configuracao: !!retornoSefaz.pendente_configuracao,
      cStat: retornoSefaz.cStat,
      xMotivo: retornoSefaz.xMotivo,
      nRec: retornoSefaz.nRec,
      nProt: retornoSefaz.nProt,
      chNFe: retornoSefaz.chNFe,
      dhRecbto: retornoSefaz.dhRecbto,
      httpStatus: retornoSefaz.httpStatus || null
    });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e.message || "Erro ao enviar NFC-e para SEFAZ."
    });
  }
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

    if (!assinatura.assinado) {
      return res.status(400).json({
        ok: false,
        mensagem: "O XML foi gerado, mas não pôde ser assinado. A NFC-e não foi enviada à SEFAZ.",
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
          xml_assinado: false,
          erro_assinatura: assinatura.erro,
          erro_apps_script: erroAppsScript,
          sefaz_auto_envio: false
        }
      });
    }

    const validacaoXsd = validarXmlNfeContraXsd(xml);
    if (!validacaoXsd.valido) {
      nota.status = "rejeitada_schema_local";
      nota.erro_xsd = validacaoXsd.erros;
      await salvarNota(nota);
      return res.status(400).json({
        ok: false,
        mensagem: "O XML assinado não passou na validação XSD e não foi enviado à SEFAZ.",
        erros_xsd: validacaoXsd.erros,
        schema_xsd: validacaoXsd.schema ? path.basename(validacaoXsd.schema) : "",
        nfce: { id: nota.id, numero: nota.numero, serie: nota.serie, chave: nota.chave, status: nota.status }
      });
    }

    console.log(`→ Enviando NFC-e ${nota.numero} série ${nota.serie} para a SEFAZ...`);

    const retornoSefaz = await transmitirNfceSefaz(nota, xml);
    const notaAtualizada = await salvarRetornoSefazLocal(nota, retornoSefaz);

    console.log(
      `← SEFAZ NFC-e ${nota.numero}: cStat=${retornoSefaz.cStat || "sem cStat"} ` +
      `xMotivo=${retornoSefaz.xMotivo || "sem motivo"}`
    );

    const statusHttp = retornoSefaz.autorizado
      ? 200
      : retornoSefaz.transmitido
        ? 422
        : 503;

    return res.status(statusHttp).json({
      ok: !!retornoSefaz.autorizado,
      mensagem: retornoSefaz.autorizado
        ? "NFC-e autorizada pela SEFAZ."
        : "A NFC-e foi processada, mas não foi autorizada.",
      nfce: {
        id: notaAtualizada.id,
        numero: notaAtualizada.numero,
        serie: notaAtualizada.serie,
        chave: notaAtualizada.chave,
        status: notaAtualizada.status,
        pdf_url: notaAtualizada.pdf_url,
        xml_url: notaAtualizada.xml_url,
        numeracao_origem: numeracaoOrigem,
        xml_salvo_apps_script: xmlSalvoNoAppsScript,
        xml_assinado: true,
        erro_assinatura: null,
        erro_apps_script: erroAppsScript,
        sefaz_auto_envio: true,
        transmitido: !!retornoSefaz.transmitido,
        autorizado: !!retornoSefaz.autorizado,
        cStat: retornoSefaz.cStat || "",
        xMotivo: retornoSefaz.xMotivo || "",
        nRec: retornoSefaz.nRec || "",
        nProt: retornoSefaz.nProt || "",
        chNFe: retornoSefaz.chNFe || "",
        dhRecbto: retornoSefaz.dhRecbto || "",
        httpStatus: retornoSefaz.httpStatus || null,
        pendente_habilitacao: !!retornoSefaz.pendente_habilitacao,
        pendente_configuracao: !!retornoSefaz.pendente_configuracao
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



app.get("/nfce/:id/eventos", async (req, res) => {
  try {
    const nota = await lerNotaCompleta(req.params.id);

    if (!nota) {
      return res.status(404).json({
        ok: false,
        error: "Nota não encontrada."
      });
    }

    const consulta = await consultarSituacaoNfceSefaz(nota);

    return res.status(consulta.ok ? 200 : 502).json({
      ok: consulta.ok,
      id: nota.id,
      numero: nota.numero,
      serie: nota.serie,
      chave: consulta.chNFe || somenteDigitos(nota.chaveAcesso || nota.chave || ""),
      situacao: {
        cStat: consulta.cStat,
        xMotivo: consulta.xMotivo,
        cancelada: consulta.cancelada
      },
      autorizacao: consulta.autorizacao,
      eventos: consulta.eventos,
      cancelamentos: consulta.cancelamentos,
      httpStatus: consulta.httpStatus,
      consultaUrl: consulta.consultaUrl
    });
  } catch (e) {
    console.error("⚠ falha na consulta de eventos da NFC-e:", e.message);

    return res.status(400).json({
      ok: false,
      error: e.message || "Falha ao consultar a NFC-e na SEFAZ."
    });
  }
});


// Evita que dois cliques/requisições simultâneas enviem o mesmo evento duas vezes.
// No cancelamento, nSeqEvento=1 é correto; uma segunda transmissão pode retornar 594.
const cancelamentosEmAndamento = new Set();

app.post("/nfce/:id/cancelar", async (req, res) => {
  const idNota = String(req.params.id || "").trim();

  if (cancelamentosEmAndamento.has(idNota)) {
    return res.status(409).json({
      ok: false,
      cancelado: false,
      em_andamento: true,
      error: "O cancelamento desta NFC-e já está sendo processado. Aguarde o retorno da SEFAZ."
    });
  }

  cancelamentosEmAndamento.add(idNota);

  try {
    const notaRemota = await lerNotaCompleta(idNota);
    const notaLocal = await lerNotaLocal(idNota);

    // A leitura normal prioriza o Apps Script. Para cancelamento, o arquivo local
    // também precisa ser consultado, pois ele recebe o retorno da SEFAZ primeiro.
    const nota = notaRemota || notaLocal;
    if (!nota) {
      return res.status(404).json({ ok: false, error: "Nota não encontrada." });
    }

    if (notaLocal && notaJaCancelada(notaLocal)) {
      return res.json({
        ok: true,
        transmitido: true,
        cancelado: true,
        ja_cancelado: true,
        mensagem: "Esta NFC-e já foi cancelada pela SEFAZ.",
        cStat: notaLocal.cancelamento?.cStat || "",
        xMotivo: notaLocal.cancelamento?.xMotivo || "",
        nProt: notaLocal.cancelamento?.nProt || "",
        dhRegEvento: notaLocal.cancelamento?.dhRegEvento || "",
        httpStatus: notaLocal.cancelamento?.httpStatus || null
      });
    }

    const motivo = String(req.body?.motivo || req.body?.justificativa || "").trim();

    if (!motivoCancelamentoValido(motivo)) {
      return res.status(400).json({
        ok: false,
        error: "Informe o motivo do cancelamento com 15 a 255 caracteres."
      });
    }

    if (!notaEstaAutorizadaParaCancelar(nota)) {
      return res.status(400).json({
        ok: false,
        error: "Só é possível cancelar NFC-e autorizada e com protocolo salvo.",
        status_atual: nota.status || "",
        protocolo: obterProtocoloAutorizacao(nota) || ""
      });
    }

    const xmlEvento = gerarXmlEventoCancelamento(nota, motivo);
    const assinatura = tentarAssinarXmlEvento(xmlEvento);

    if (!assinatura.assinado) {
      return res.status(400).json({
        ok: false,
        error: "Evento de cancelamento não foi assinado.",
        erro_assinatura: assinatura.erro
      });
    }

    const retorno = await transmitirCancelamentoSefaz(nota, assinatura.xml);

    const dadosCancelamento = {
      ...retorno,
      motivo,
      xmlEvento: assinatura.xml
    };

    await salvarCancelamentoLocal(nota, dadosCancelamento);

    const respostaCancelamento = {
      ok: !!retorno.cancelado,
      transmitido: retorno.transmitido,
      cancelado: !!retorno.cancelado,
      mensagem: retorno.cancelado
        ? "Cancelamento autorizado pela SEFAZ."
        : "A SEFAZ respondeu, mas não autorizou o cancelamento.",
      error: retorno.cancelado
        ? ""
        : (retorno.xMotivo || "Cancelamento não autorizado pela SEFAZ."),
      pendente_habilitacao: !!retorno.pendente_habilitacao,
      pendente_configuracao: !!retorno.pendente_configuracao,
      cStat: retorno.cStat,
      xMotivo: retorno.xMotivo,
      nProt: retorno.nProt,
      dhRegEvento: retorno.dhRegEvento,
      httpStatus: retorno.httpStatus || null
    };

    // Retorna sucesso HTTP somente quando a SEFAZ confirmou o cancelamento.
    // Isso impede interfaces antigas de marcar a venda como cancelada
    // apenas porque a requisição recebeu uma resposta do servidor.
    const statusResposta = retorno.cancelado ? 200 : 422;
    return res.status(statusResposta).json(respostaCancelamento);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      cancelado: false,
      error: e.message || "Erro ao cancelar NFC-e."
    });
  } finally {
    cancelamentosEmAndamento.delete(idNota);
  }
});

app.get("/nfce/:id/cancelamento", async (req, res) => {
  const nota = await lerNotaCompleta(req.params.id);
  if (!nota) {
    return res.status(404).json({ ok: false, error: "Nota não encontrada." });
  }

  res.json({
    ok: true,
    id: nota.id,
    status: nota.status || "",
    protocolo_autorizacao: obterProtocoloAutorizacao(nota),
    cancelamento: nota.cancelamento || null
  });
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
    
app.get("/nfce/:id/status", async (req, res) => {
  try {
    const idConsulta = String(req.params.id || "").trim();
    let nota = null;
    let origem = "";

    // O Apps Script é a fonte persistente. O disco do Render é apenas cache.
    if (API_BELA_SHEETS) {
      try {
        nota = await getNfceNotaRemota(idConsulta);
        if (nota) {
          origem = "apps_script";

          // Recria o cache local quando o Render reiniciou ou perdeu o arquivo.
          try {
            if (nota.id) await salvarNota(nota);
          } catch (erroCache) {
            console.warn("⚠ não foi possível atualizar cache local da NFC-e:", erroCache.message);
          }
        }
      } catch (erroRemoto) {
        console.warn("⚠ consulta de status no Apps Script falhou:", erroRemoto.message);
      }
    }

    if (!nota) {
      nota = await lerNotaLocal(idConsulta);
      if (nota) origem = "local";
    }

    if (!nota) {
      return res.status(404).json({
        ok: false,
        error: "NFC-e não encontrada no Apps Script nem no armazenamento local."
      });
    }

    return res.json({
      ok: true,
      origem,
      resumoFiscal: criarResumoFiscal(nota),
      sefaz: nota.sefaz || {},
      cancelamento: nota.cancelamento || {}
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


app.listen(PORT, () => {
      console.log(`Bela Caixa API rodando na porta ${PORT}`);
  console.log(`[NFC-e] Ambiente ${NFCE_CONFIG.tpAmb === "1" ? "produção" : "homologação"} | XSD ativo | transmissão ${SEFAZ_CONFIG.habilitada ? "habilitada" : "desabilitada"}.`);
      console.log(`Apps Script configurado: ${API_BELA_SHEETS ? "sim" : "não"}`);
    });
  })
  .catch(err => {
    console.error("Falha ao iniciar API:", err);
    process.exit(1);
  });
