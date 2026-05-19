
module.exports = function gerarXML(venda){

return `
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe versao="4.00">
      <ide>
        <cUF>31</cUF>
        <mod>65</mod>
        <serie>1</serie>
        <nNF>${venda.numero || 1}</nNF>
        <tpAmb>2</tpAmb>
      </ide>
    </infNFe>
  </NFe>
</nfeProc>
`;
}
