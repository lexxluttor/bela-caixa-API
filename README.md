# Bela Caixa API

Versão corrigida com persistência em disco.

## Correção principal
Antes as notas ficavam só na memória.
Se a API reiniciasse, URLs antigas davam "Nota não encontrada".

Agora cada nota emitida é salva em:
- storage/notas/<id>.json

## Recursos
- Cupom térmico 80mm
- XML individual
- XML do mês
- XML por período
- Persistência local das notas

## Observação
Depois de subir esta versão, emita novas notas.
As notas antigas emitidas pela versão em memória não podem ser recuperadas.
