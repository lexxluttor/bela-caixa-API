export function registrarConferenciaFiscal({
  app,
  crypto,
  BELA_ADMIN_TOKEN,
  SEFAZ_CONFIG,
  SEFAZ_ENDPOINTS_MG,
  somenteDigitos,
  httpsPostComCertificado,
  extrairConsultaProtocoloSefaz,
  listarNfceNotasRemotas,
  listarNotasLocal,
  lerNotaCompleta,
  salvarNota,
  salvarCancelamentoNfceRemoto,
  extrairIdentificacaoXmlNfce
}) {
  // ============================================================
  // MÓDULO DE CONFERÊNCIA FISCAL OFICIAL
  // Somente leitura. Não altera nota, venda, numeração ou status.
  // Para remover no futuro, apague este bloco inteiro.
  // ============================================================

  function extrairXmlPersistidoConferencia(nota = {}) {
    const candidatos = [
      nota.xml_autorizado,
      nota.xmlAutorizado,
      nota.xml_assinado,
      nota.xmlAssinado,
      nota.xml_original,
      nota.xmlOriginal,
      nota.xml
    ];

    return String(
      candidatos.find(valor =>
        typeof valor === "string" &&
        valor.includes("<") &&
        (valor.includes("<NFe") || valor.includes("<nfeProc"))
      ) || ""
    );
  }

  function identificarAmbienteConferencia({ nota = {}, xml = "", ambienteInformado = "" } = {}) {
    const informado = String(ambienteInformado || "").trim();
    const ambienteXml = String(
      xml.match(/<tpAmb>\s*([12])\s*<\/tpAmb>/i)?.[1] || ""
    );
    const ambienteQr = String(
      xml.match(/[?&]p=[^<\s]*\|3\|([12])(?:[|<\s]|$)/i)?.[1] ||
      String(nota.qrCodeUrl || "").match(/\|3\|([12])(?:[|&\s]|$)/)?.[1] ||
      ""
    );
    const ambienteNota = String(
      nota.tpAmb ||
      nota.ambiente ||
      nota.sefaz?.tpAmb ||
      nota.sefaz?.ambiente ||
      ""
    ).trim();

    const valores = [ambienteXml, ambienteQr, ambienteNota]
      .filter(valor => valor === "1" || valor === "2");

    const divergencias = [];

    if (ambienteXml && ambienteQr && ambienteXml !== ambienteQr) {
      divergencias.push(
        `XML informa tpAmb=${ambienteXml}, mas o QR Code informa ambiente ${ambienteQr}.`
      );
    }

    if (informado && informado !== "auto" && !["1", "2"].includes(informado)) {
      throw new Error("Ambiente inválido. Use 1, 2 ou auto.");
    }

    const ambiente =
      informado && informado !== "auto"
        ? informado
        : ambienteXml || ambienteNota || ambienteQr || "";

    if (!ambiente) {
      throw new Error(
        "Não foi possível identificar o ambiente. Informe 1 para produção ou 2 para homologação."
      );
    }

    for (const valor of valores) {
      if (valor !== ambiente) {
        divergencias.push(
          `O ambiente escolhido (${ambiente}) diverge de uma informação salva (${valor}).`
        );
      }
    }

    return {
      ambiente,
      ambienteXml,
      ambienteQr,
      ambienteNota,
      divergencias: [...new Set(divergencias)]
    };
  }

  function montarEnvelopeConsultaConferencia(chave, ambiente) {
    const chaveLimpa = somenteDigitos(chave || "");

    if (chaveLimpa.length !== 44) {
      throw new Error("Chave de acesso inválida. A consulta exige 44 dígitos.");
    }

    if (!["1", "2"].includes(String(ambiente))) {
      throw new Error("Ambiente inválido para consulta fiscal.");
    }

    return `<?xml version="1.0" encoding="utf-8"?>
  <soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
    <soap12:Body>
      <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">
        <consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
          <tpAmb>${ambiente}</tpAmb>
          <xServ>CONSULTAR</xServ>
          <chNFe>${chaveLimpa}</chNFe>
        </consSitNFe>
      </nfeDadosMsg>
    </soap12:Body>
  </soap12:Envelope>`;
  }

  function classificarRespostaOficialConferencia(consulta = {}) {
    const autorizacao = consulta.autorizacao || null;
    const cStatAutorizacao = String(autorizacao?.cStat || "");
    const cStatConsulta = String(consulta.cStat || "");
    const motivoConsulta = String(consulta.xMotivo || "").toUpperCase();

    // A situação atual da SEFAZ prevalece sobre a autorização original.
    if (
      consulta.cancelada ||
      cStatConsulta === "101" ||
      motivoConsulta.includes("CANCELAMENTO")
    ) {
      return {
        codigo: "cancelada",
        rotulo: "CANCELADA",
        confirmado: true
      };
    }

    if (cStatAutorizacao === "100" || cStatConsulta === "100") {
      return {
        codigo: "autorizada",
        rotulo: "AUTORIZADA",
        confirmado: true
      };
    }

    if (cStatConsulta === "217") {
      return {
        codigo: "nao_encontrada",
        rotulo: "NÃO CONSTA NA BASE DA SEFAZ",
        confirmado: true
      };
    }

    if (cStatAutorizacao === "110" || cStatConsulta === "110") {
      return {
        codigo: "denegada",
        rotulo: "USO DENEGADO",
        confirmado: true
      };
    }

    return {
      codigo: "outra_situacao",
      rotulo: consulta.xMotivo || autorizacao?.xMotivo || "SITUAÇÃO NÃO CLASSIFICADA",
      confirmado: true
    };
  }

  async function consultarChaveConferenciaFiscal({ chave, ambiente }) {
    if (!SEFAZ_CONFIG.habilitada) {
      throw new Error("A comunicação com a SEFAZ está desabilitada.");
    }

    const ambienteTexto = String(ambiente);
    const consultaUrl = SEFAZ_ENDPOINTS_MG[ambienteTexto]?.consulta;

    if (!consultaUrl) {
      throw new Error("Endpoint de consulta não encontrado para o ambiente informado.");
    }

    const chaveLimpa = somenteDigitos(chave || "");
    const envelope = montarEnvelopeConsultaConferencia(chaveLimpa, ambienteTexto);

    console.log(
      `[CONFERÊNCIA FISCAL] Consultando chave ${chaveLimpa} em ` +
      `${ambienteTexto === "1" ? "PRODUÇÃO" : "HOMOLOGAÇÃO"}.`
    );

    const resposta = await httpsPostComCertificado(consultaUrl, envelope, {
      "SOAPAction": ""
    });

    const dados = extrairConsultaProtocoloSefaz(resposta.body);
    const classificacao = classificarRespostaOficialConferencia(dados);

    return {
      ok: resposta.statusCode >= 200 && resposta.statusCode < 300,
      httpStatus: resposta.statusCode,
      ambienteConsultado: ambienteTexto,
      ambienteNome: ambienteTexto === "1" ? "PRODUÇÃO" : "HOMOLOGAÇÃO",
      consultaUrl,
      chave: dados.chNFe || chaveLimpa,
      classificacao,
      xmlRetorno: resposta.body,
      ...dados
    };
  }

  function resumirNotaConferencia(nota = {}) {
    const xml = extrairXmlPersistidoConferencia(nota);
    const identificacao = extrairIdentificacaoXmlNfce(xml);
    let ambiente = "";
    let divergencias = [];

    try {
      const identificado = identificarAmbienteConferencia({ nota, xml });
      ambiente = identificado.ambiente;
      divergencias = identificado.divergencias;
    } catch {}

    return {
      id: nota.id || nota.vendaId || "",
      vendaId: nota.vendaId || "",
      numero: Number(identificacao.numero || nota.numero || 0),
      serie: Number(identificacao.serie || nota.serie || 1),
      chave: identificacao.chave || nota.chaveAcesso || nota.chave || "",
      total: Number(nota.total || 0),
      statusInterno: nota.status || "",
      protocoloInterno: nota.protocolo || nota.sefaz?.nProt || "",
      ambiente,
      ambienteNome:
        ambiente === "1" ? "PRODUÇÃO" :
        ambiente === "2" ? "HOMOLOGAÇÃO" :
        "NÃO IDENTIFICADO",
      divergencias
    };
  }

  app.get("/conferencia-fiscal/notas", protegerModuloConferencia, async (req, res) => {
    try {
      const dia = String(req.query.dia || "");
      const mes = String(req.query.mes || "");
      let notas = [];

      if (API_BELA_SHEETS) {
        notas = await listarNfceNotasRemotas({ dia, mes });
      } else {
        notas = await listarNotasLocal();
      }

      const ambienteFiltro = String(req.query.ambiente || "");
      const resultado = notas
        .map(resumirNotaConferencia)
        .filter(nota => !ambienteFiltro || nota.ambiente === ambienteFiltro)
        .sort((a, b) => Number(b.numero || 0) - Number(a.numero || 0));

      return res.json({
        ok: true,
        somenteLeitura: true,
        total: resultado.length,
        notas: resultado
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: e.message || "Falha ao listar notas para conferência."
      });
    }
  });

  app.post("/conferencia-fiscal/consultar", protegerModuloConferencia, async (req, res) => {
    try {
      const id = String(req.body?.id || "").trim();
      const chaveInformada = somenteDigitos(req.body?.chave || "");
      const ambienteInformado = String(req.body?.ambiente || "auto").trim();

      let nota = null;

      if (id) {
        nota = await lerNotaCompleta(id);
        if (!nota) {
          return res.status(404).json({
            ok: false,
            error: "Nota não encontrada no Apps Script nem no armazenamento local."
          });
        }
      }

      const xml = String(req.body?.xml || "") || extrairXmlPersistidoConferencia(nota || {});
      const identificacao = extrairIdentificacaoXmlNfce(xml);
      const chave = chaveInformada ||
        somenteDigitos(
          identificacao.chave ||
          nota?.chaveAcesso ||
          nota?.chave ||
          ""
        );

      if (chave.length !== 44) {
        throw new Error("A nota não possui uma chave válida de 44 dígitos.");
      }

      const ambiente = identificarAmbienteConferencia({
        nota: nota || {},
        xml,
        ambienteInformado
      });

      const oficial = await consultarChaveConferenciaFiscal({
        chave,
        ambiente: ambiente.ambiente
      });

      const statusInterno = String(nota?.status || "");
      const protocoloInterno = String(
        nota?.protocolo ||
        nota?.sefaz?.nProt ||
        ""
      );
      const statusOficial = oficial.classificacao.codigo;

      const divergencias = [...ambiente.divergencias];

      if (
        statusInterno.toLowerCase().includes("autoriz") &&
        statusOficial !== "autorizada"
      ) {
        divergencias.push(
          `O sistema informa "${statusInterno}", mas a SEFAZ respondeu "${oficial.classificacao.rotulo}".`
        );
      }

      if (
        protocoloInterno &&
        oficial.autorizacao?.nProt &&
        protocoloInterno !== oficial.autorizacao.nProt
      ) {
        divergencias.push("O protocolo salvo diverge do protocolo retornado pela SEFAZ.");
      }

      const protocoloCancelamento =
        oficial.cancelamentos?.find(evento => evento.nProt)?.nProt || "";
      const dataCancelamento =
        oficial.cancelamentos?.find(evento => evento.dhRegEvento)?.dhRegEvento || "";

      const resumoOficial = {
        fonte: "SEFAZ MG - NFeConsultaProtocolo4",
        ambiente: oficial.ambienteNome,
        ambienteCodigo: oficial.tpAmb || oficial.ambienteConsultado,
        situacao: oficial.classificacao.rotulo,
        codigoSituacao: oficial.classificacao.codigo,
        cStat: oficial.cStat,
        xMotivo: oficial.xMotivo,
        protocoloAutorizacao: oficial.autorizacao?.nProt || "",
        dataAutorizacao: oficial.autorizacao?.dhRecbto || "",
        protocoloCancelamento,
        dataCancelamento,
        cancelada: oficial.cancelada === true
      };

      return res.json({
        ok: oficial.ok,
        somenteLeitura: true,
        alterouDados: false,
        nota: nota ? resumirNotaConferencia(nota) : null,
        ambienteDetectado: ambiente,
        resumoOficial,
        oficial,
        divergencias: [...new Set(divergencias)]
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        somenteLeitura: true,
        alterouDados: false,
        error: e.message || "Falha na conferência fiscal."
      });
    }
  });

  app.post("/conferencia-fiscal/sincronizar-cancelamento", protegerModuloConferencia, async (req, res) => {
    try {
      const id = String(req.body?.id || "").trim();

      if (!id) {
        return res.status(400).json({
          ok: false,
          error: "Informe o ID da nota para sincronizar."
        });
      }

      const nota = await lerNotaCompleta(id);

      if (!nota) {
        return res.status(404).json({
          ok: false,
          error: "Nota não encontrada."
        });
      }

      const xml = extrairXmlPersistidoConferencia(nota);
      const identificacao = extrairIdentificacaoXmlNfce(xml);
      const chave = somenteDigitos(
        identificacao.chave ||
        nota.chaveAcesso ||
        nota.chave ||
        ""
      );

      const ambiente = identificarAmbienteConferencia({
        nota,
        xml,
        ambienteInformado: "auto"
      });

      const oficial = await consultarChaveConferenciaFiscal({
        chave,
        ambiente: ambiente.ambiente
      });

      if (
        oficial.classificacao?.codigo !== "cancelada" &&
        oficial.cancelada !== true &&
        String(oficial.cStat || "") !== "101"
      ) {
        return res.status(409).json({
          ok: false,
          sincronizado: false,
          error: "A SEFAZ não confirmou que esta NFC-e está cancelada.",
          oficial
        });
      }

      const eventoCancelamento =
        oficial.cancelamentos?.find(evento =>
          evento.tpEvento === "110111"
        ) || {};

      const dadosCancelamento = {
        cancelado: true,
        motivo:
          nota.cancelamento?.motivo ||
          nota.motivo_cancelamento ||
          "Cancelamento confirmado por consulta oficial à SEFAZ",
        cStat:
          eventoCancelamento.cStat ||
          oficial.cStat ||
          "101",
        xMotivo:
          eventoCancelamento.xMotivo ||
          oficial.xMotivo ||
          "Cancelamento de NF-e homologado",
        nProt:
          eventoCancelamento.nProt ||
          nota.cancelamento?.nProt ||
          "",
        dhRegEvento:
          eventoCancelamento.dhRegEvento ||
          nota.cancelamento?.dhRegEvento ||
          "",
        tpEvento: "110111",
        nSeqEvento: eventoCancelamento.nSeqEvento || "1",
        xmlEvento: nota.cancelamento?.xmlEvento || "",
        xmlRetorno: oficial.xmlRetorno || ""
      };

      nota.status = "cancelada";
      nota.status_nfce = "cancelada";
      nota.cancelamento = {
        ...(nota.cancelamento || {}),
        ...dadosCancelamento
      };

      await salvarNota(nota);
      await salvarCancelamentoNfceRemoto(nota, dadosCancelamento);

      return res.json({
        ok: true,
        sincronizado: true,
        alterouSefaz: false,
        mensagem:
          "Status cancelado sincronizado no Apps Script com base na consulta oficial da SEFAZ.",
        nota: {
          id: nota.id,
          numero: nota.numero,
          chave
        },
        oficial
      });
    } catch (e) {
      return res.status(400).json({
        ok: false,
        sincronizado: false,
        error: e.message || "Falha ao sincronizar o cancelamento."
      });
    }
  });

  app.get("/conferencia-fiscal", protegerModuloConferencia, (req, res) => {
    res.type("html").send(`<!doctype html>
  <html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Conferência Fiscal NFC-e</title>
    <style>
      :root{font-family:Arial,sans-serif;color:#202124;background:#f3f4f7}
      body{margin:0;padding:24px}
      .wrap{max-width:1100px;margin:auto}
      .card{background:#fff;border:1px solid #d8dbe3;border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:0 4px 18px #0000000d}
      h1{margin:0 0 6px;font-size:25px}
      h2{font-size:17px;margin:0 0 12px}
      .sub{color:#5f6368;margin-bottom:18px}
      .grid{display:grid;grid-template-columns:1fr 2fr 1.2fr 180px auto;gap:10px}
      input,select,button{padding:11px 12px;border-radius:9px;border:1px solid #c9ccd5;font-size:14px}
      button{background:#1a5276;color:#fff;border:0;font-weight:700;cursor:pointer}
      button:hover{filter:brightness(1.08)}
      .resultado{white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.45;background:#111827;color:#e5e7eb;padding:15px;border-radius:10px;min-height:90px;overflow:auto}
      .oficial{display:none;border:2px solid #d8dbe3;border-radius:14px;padding:18px;background:#fff}
      .oficial h3{margin:0 0 12px;font-size:20px}
      .oficial-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      .campo{background:#f6f7fa;border-radius:10px;padding:11px}
      .campo small{display:block;color:#6b7280;text-transform:uppercase;font-size:10px;font-weight:700;margin-bottom:4px}
      .campo strong{word-break:break-word}
      .status-grande{font-size:22px;font-weight:900}
      .ok-status{color:#137333}.cancel-status{color:#b3261e}.warn-status{color:#8a5a00}
      details{margin-top:14px}
      summary{cursor:pointer;font-weight:700;color:#1a5276}
      @media(max-width:650px){.oficial-grid{grid-template-columns:1fr}}
      .badge{display:inline-block;padding:5px 9px;border-radius:999px;font-weight:700;font-size:12px}
      .prod{background:#d5f5e3;color:#176b36}.hom{background:#fff3cd;color:#7a5200}.erro{background:#fadbd8;color:#8b1e16}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th,td{text-align:left;border-bottom:1px solid #e4e6ec;padding:9px 7px;vertical-align:top}
      th{color:#5f6368;font-size:11px;text-transform:uppercase}
      .mini{padding:6px 9px;font-size:12px}
      @media(max-width:800px){.grid{grid-template-columns:1fr}.card{overflow:auto}}
    </style>
  </head>
  <body>
  <div class="wrap">
    <div class="card">
      <h1>🔎 Conferência Fiscal NFC-e</h1>
      <div class="sub">Consulta oficial na SEFAZ. A consulta é somente leitura. A sincronização da planilha só ocorre por ação manual e após confirmação oficial da SEFAZ.</div>
      <div class="grid">
        <input id="idNota" placeholder="ID da nota ou venda">
        <input id="chave" maxlength="44" placeholder="Ou chave de acesso com 44 dígitos">
        <input id="adminToken" type="password" placeholder="Token administrativo (se configurado)">
        <select id="ambiente">
          <option value="auto">Detectar pelo XML</option>
          <option value="1">Produção</option>
          <option value="2">Homologação</option>
        </select>
        <button onclick="consultar()">Consultar SEFAZ</button>
      </div>
    </div>

    <div class="card">
      <h2>Resposta oficial da SEFAZ</h2>
      <div id="painelOficial" class="oficial"></div>
      <div id="resultado" class="resultado">Aguardando consulta...</div>
    </div>

    <div class="card">
      <h2>Notas encontradas no Apps Script</h2>
      <button class="mini" onclick="carregarNotas()">Atualizar lista</button>
      <div style="overflow:auto;margin-top:10px">
        <table>
          <thead><tr><th>Nº</th><th>Ambiente</th><th>Status interno</th><th>Chave</th><th></th></tr></thead>
          <tbody id="lista"><tr><td colspan="5">Carregando...</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
  <script>
  const resultado = document.getElementById("resultado");

  function headersAdministrativos(){
    const token = document.getElementById("adminToken")?.value.trim() || "";
    if (token) sessionStorage.setItem("belaAdminToken", token);
    const salvo = token || sessionStorage.getItem("belaAdminToken") || "";
    return salvo ? {"X-Bela-Admin-Token": salvo} : {};
  }

  window.addEventListener("DOMContentLoaded", () => {
    const salvo = sessionStorage.getItem("belaAdminToken") || "";
    const campo = document.getElementById("adminToken");
    if (campo && salvo) campo.value = salvo;
  });

  function escapar(v){
    return String(v == null ? "" : v)
      .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
  }

  async function consultar(idForcado){
    try{
      resultado.textContent = "Consultando a SEFAZ...";
      if (idForcado) document.getElementById("idNota").value = idForcado;
      const id = idForcado || document.getElementById("idNota").value.trim();
      const chave = document.getElementById("chave").value.replace(/\\D/g,"");
      const ambiente = document.getElementById("ambiente").value;

      const r = await fetch("/conferencia-fiscal/consultar",{
        method:"POST",
        headers:{"Content-Type":"application/json", ...headersAdministrativos()},
        body:JSON.stringify({id,chave,ambiente})
      });
      const data = await r.json();
      resultado.textContent = JSON.stringify(data,null,2);

      const painel = document.getElementById("painelOficial");
      const resumo = data.resumoOficial;

      if (!resumo) {
        painel.style.display = "none";
        return;
      }

      const classe =
        resumo.codigoSituacao === "autorizada" ? "ok-status" :
        resumo.codigoSituacao === "cancelada" ? "cancel-status" :
        "warn-status";

      painel.innerHTML =
        '<h3>🏛️ Resposta oficial da SEFAZ MG</h3>'+ 
        '<div class="oficial-grid">'+
          '<div class="campo"><small>Situação atual</small><strong class="status-grande '+classe+'">'+escapar(resumo.situacao)+'</strong></div>'+ 
          '<div class="campo"><small>Ambiente oficial</small><strong>'+escapar(resumo.ambiente)+' (tpAmb '+escapar(resumo.ambienteCodigo)+')</strong></div>'+ 
          '<div class="campo"><small>cStat atual</small><strong>'+escapar(resumo.cStat)+'</strong></div>'+ 
          '<div class="campo"><small>Motivo oficial</small><strong>'+escapar(resumo.xMotivo)+'</strong></div>'+ 
          '<div class="campo"><small>Protocolo de autorização</small><strong>'+escapar(resumo.protocoloAutorizacao || "não informado")+'</strong></div>'+ 
          '<div class="campo"><small>Data da autorização</small><strong>'+escapar(resumo.dataAutorizacao || "não informada")+'</strong></div>'+ 
          '<div class="campo"><small>Protocolo de cancelamento</small><strong>'+escapar(resumo.protocoloCancelamento || "não se aplica")+'</strong></div>'+ 
          '<div class="campo"><small>Data do cancelamento</small><strong>'+escapar(resumo.dataCancelamento || "não se aplica")+'</strong></div>'+ 
        '</div>'+ 
        '<details><summary>Ver resposta técnica completa</summary><p>O JSON técnico aparece no quadro escuro abaixo.</p></details>'+ 
        '<p style="margin:14px 0 0;color:#5f6368"><strong>Fonte:</strong> '+escapar(resumo.fonte)+'</p>'+
        (resumo.codigoSituacao === "cancelada"
          ? '<button style="margin-top:12px" onclick="sincronizarCancelamento()">Sincronizar cancelamento na planilha</button>'
          : '');

      painel.style.display = "block";
    }catch(e){
      document.getElementById("painelOficial").style.display = "none";
      resultado.textContent = "Erro: " + e.message;
    }
  }

  async function sincronizarCancelamento(){
    const id = document.getElementById("idNota").value.trim();

    if (!id) {
      alert("Informe ou selecione o ID da nota antes de sincronizar.");
      return;
    }

    if (!confirm("Sincronizar o status oficial de cancelamento na planilha? Nenhum evento será reenviado à SEFAZ.")) {
      return;
    }

    resultado.textContent = "Sincronizando o cancelamento no Apps Script...";

    try {
      const r = await fetch("/conferencia-fiscal/sincronizar-cancelamento", {
        method: "POST",
        headers: {"Content-Type":"application/json", ...headersAdministrativos()},
        body: JSON.stringify({ id })
      });

      const data = await r.json();
      resultado.textContent = JSON.stringify(data, null, 2);

      if (!r.ok || !data.ok) {
        alert(data.error || "Não foi possível sincronizar.");
        return;
      }

      alert("Cancelamento sincronizado na planilha com sucesso.");
      carregarNotas();
    } catch (e) {
      resultado.textContent = "Erro: " + e.message;
    }
  }

  async function carregarNotas(){
    const corpo = document.getElementById("lista");
    corpo.innerHTML = '<tr><td colspan="5">Carregando...</td></tr>';
    try{
      const r = await fetch("/conferencia-fiscal/notas", { headers: headersAdministrativos() });
      const data = await r.json();
      const notas = data.notas || [];
      corpo.innerHTML = notas.map(n => {
        const classe = n.ambiente === "1" ? "prod" : n.ambiente === "2" ? "hom" : "erro";
        return '<tr>'+
          '<td><strong>'+escapar(n.numero)+'</strong></td>'+
          '<td><span class="badge '+classe+'">'+escapar(n.ambienteNome)+'</span></td>'+
          '<td>'+escapar(n.statusInterno || "sem status")+'</td>'+
          '<td style="font-family:monospace">'+escapar(n.chave)+'</td>'+
          '<td><button class="mini" onclick="consultar(\\''+escapar(n.id)+'\\')">Consultar</button></td>'+
        '</tr>';
      }).join("") || '<tr><td colspan="5">Nenhuma nota encontrada.</td></tr>';
    }catch(e){
      corpo.innerHTML = '<tr><td colspan="5">Erro: '+escapar(e.message)+'</td></tr>';
    }
  }
  carregarNotas();
  </script>
  </body>
  </html>`);
  });

  // ================= FIM DO MÓDULO DE CONFERÊNCIA FISCAL OFICIAL =================
}
