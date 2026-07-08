function normalizarTexto(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function parseLinhaCSV(linha) {
  const texto = String(linha ?? "");
  const sep = texto.includes(";") ? ";" : ",";
  const out = [];
  let atual = "";
  let aspas = false;

  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];

    if (ch === '"') {
      if (aspas && texto[i + 1] === '"') {
        atual += '"';
        i++;
      } else {
        aspas = !aspas;
      }
      continue;
    }

    if (ch === sep && !aspas) {
      out.push(atual.trim());
      atual = "";
      continue;
    }

    atual += ch;
  }

  out.push(atual.trim());
  return out;
}

function numeroBR(v) {
  const s = String(v ?? "")
    .replace(/[^\d,.-]/g, "")
    .trim();

  if (!s) return 0;

  const normalizado = s.includes(",")
    ? s.replace(/\./g, "").replace(",", ".")
    : s;

  const n = Number(normalizado);
  return Number.isFinite(n) ? n : 0;
}

function indiceColuna(headers, opcoes) {
  const normalizados = headers.map(h => normalizarTexto(h));

  for (const opcao of opcoes) {
    const alvo = normalizarTexto(opcao);

    let idx = normalizados.findIndex(h => h === alvo);
    if (idx >= 0) return idx;

    idx = normalizados.findIndex(h => h.includes(alvo));
    if (idx >= 0) return idx;
  }

  return -1;
}

function contarPendentesROI(csvText) {
  const linhas = String(csvText || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(l => String(l).trim());

  if (!linhas.length) {
    return {
      qtd: 0,
      tonelagem: 0
    };
  }

  const headers = parseLinhaCSV(linhas[0]);

  const idxCliente = indiceColuna(headers, ["Cliente", "Grupo Cliente"]);
  const idxNumeroRO = indiceColuna(headers, ["Nº RO", "N° RO", "NumeroRO", "Num RO", "RO", "ROI"]);
  const idxSituacao = indiceColuna(headers, [
    "Situação Atual RO",
    "Situacao Atual RO",
    "Situação Atual ROI",
    "Situacao Atual ROI",
    "Status",
    "Situação",
    "Situacao"
  ]);
  const idxTons = indiceColuna(headers, ["Tons", "Ton", "Reclamado Ton", "Tonelagem"]);

  let total = 0;
  let tonelagem = 0;

  for (let i = 0; i < linhas.length; i++) {
    const cols = parseLinhaCSV(linhas[i]);

    const primeiraColuna = normalizarTexto(cols[0] || "");

    if (
      i === 0 &&
      (
        primeiraColuna.includes("cliente") ||
        primeiraColuna.includes("grupo") ||
        primeiraColuna.includes("ro") ||
        primeiraColuna.includes("roi")
      )
    ) {
      continue;
    }

    const cliente = String(cols[idxCliente >= 0 ? idxCliente : 0] || "").trim();

    const numeroROI = String(
      cols[idxNumeroRO >= 0 ? idxNumeroRO : 1] ||
      cols[1] ||
      cols[0] ||
      ""
    ).trim();

    if (!numeroROI || normalizarTexto(numeroROI).includes("numero")) continue;

    const situacao = normalizarTexto(
      cols[idxSituacao >= 0 ? idxSituacao : 10] ||
      cols[10] ||
      cols[9] ||
      ""
    );

    // Mantém apenas ROIs pendentes.
    // ROIs concluídos/encerrados/fechados não entram no cartão principal.
    if (
      situacao.includes("conclu") ||
      situacao.includes("encerr") ||
      situacao.includes("fechad") ||
      situacao.includes("resolvid") ||
      situacao.includes("finaliz")
    ) {
      continue;
    }

    total++;

    const ton = numeroBR(cols[idxTons >= 0 ? idxTons : 7] || "0");
    tonelagem += ton;
  }

  return {
    qtd: total,
    tonelagem
  };
}

function decodeBase64Utf8(base64) {
  return Buffer.from(String(base64 || ""), "base64").toString("utf8");
}

function encodeBase64Utf8(texto) {
  return Buffer.from(String(texto || ""), "utf8").toString("base64");
}

async function buscarArquivoGithub({ owner, repo, branch, path, token }) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  const response = await fetch(`${apiUrl}?ref=${branch}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const erro = await response.text();
    throw new Error(`Erro ao buscar arquivo ${path}: ${erro}`);
  }

  const fileInfo = await response.json();

  return {
    sha: fileInfo.sha,
    content: decodeBase64Utf8(fileInfo.content)
  };
}

async function gravarArquivoGithub({ owner, repo, branch, path, token, content, message, sha }) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  const body = {
    message,
    content: encodeBase64Utf8(content),
    branch
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const erro = await response.text();
    throw new Error(`Erro ao gravar arquivo ${path}: ${erro}`);
  }

  return await response.json();
}

export default async function handler(req, res) {
  // ================================
  // CORS
  // ================================
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-roi-key"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        message: "Método não permitido. Use POST."
      });
    }

    // ================================
    // Validação da senha ROI
    // ================================
    const authKey = req.headers["x-roi-key"];

    if (!process.env.ROI_UPDATE_SECRET || authKey !== process.env.ROI_UPDATE_SECRET) {
      return res.status(401).json({
        ok: false,
        message: "Senha de atualização ROI inválida."
      });
    }

    // ================================
    // Recebe CSV do Dashboard ROI
    // ================================
    const body = req.body || {};
    const csvText = body.csvText;
    const fileName = body.fileName || "Base_ROIs_Import.csv";

    if (!csvText || typeof csvText !== "string") {
      return res.status(400).json({
        ok: false,
        message: "CSV não recebido."
      });
    }

    // Remove BOM invisível, mas preserva o conteúdo do CSV
    const csvFinal = String(csvText || "").replace(/^\uFEFF/, "");

    // ================================
    // Variáveis do GitHub/Vercel
    // ================================
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || "main";
    const path = process.env.ROI_GITHUB_FILE_PATH || fileName;
    const token = process.env.GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      return res.status(500).json({
        ok: false,
        message: "Variáveis do GitHub não configuradas na Vercel."
      });
    }

    // ================================
    // Busca arquivo atual para pegar SHA e contar valor anterior
    // ================================
    const arquivoAnterior = await buscarArquivoGithub({
      owner,
      repo,
      branch,
      path,
      token
    });

    const sha = arquivoAnterior?.sha || null;

    const resumoAnterior = arquivoAnterior
      ? contarPendentesROI(arquivoAnterior.content)
      : {
          qtd: 0,
          tonelagem: 0
        };

    const resumoAtual = contarPendentesROI(csvFinal);

    const dataBR = new Date().toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo"
    });

    // ================================
    // Atualiza/cria arquivo principal no GitHub
    // ================================
    await gravarArquivoGithub({
      owner,
      repo,
      branch,
      path,
      token,
      sha,
      content: csvFinal,
      message: `Atualiza base ROI - ${dataBR}`
    });

    // ================================
    // Cria/atualiza comparativo_roi.json
    // Esse arquivo será lido pela Central para mostrar:
    // Aumentou de X para Y / Diminuiu de X para Y
    // ================================
    const comparativoPath = "comparativo_roi.json";

    const arquivoComparativoAnterior = await buscarArquivoGithub({
      owner,
      repo,
      branch,
      path: comparativoPath,
      token
    }).catch(() => null);

    const comparativo = {
      tipo: "roi",
      anterior: resumoAnterior.qtd,
      atual: resumoAtual.qtd,
      diferenca: resumoAtual.qtd - resumoAnterior.qtd,
      direcao:
        resumoAtual.qtd > resumoAnterior.qtd
          ? "aumentou"
          : resumoAtual.qtd < resumoAnterior.qtd
            ? "diminuiu"
            : "manteve",
      tonelagem_anterior: Number(resumoAnterior.tonelagem.toFixed(2)),
      tonelagem_atual: Number(resumoAtual.tonelagem.toFixed(2)),
      data_anterior: null,
      data_atualizacao: new Date().toISOString(),
      arquivo: path
    };

    await gravarArquivoGithub({
      owner,
      repo,
      branch,
      path: comparativoPath,
      token,
      sha: arquivoComparativoAnterior?.sha || null,
      content: JSON.stringify(comparativo, null, 2),
      message: `Atualiza comparativo ROI - ${dataBR}`
    });

    return res.status(200).json({
      ok: true,
      message: "Base ROI atualizada com sucesso no GitHub.",
      arquivo: path,
      comparativo,
      tamanhoCaracteres: csvFinal.length
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Erro interno na API ROI.",
      detalhe: error.message
    });
  }
}
