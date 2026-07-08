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

function contarPendentesRO(csvText) {
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
  const idxNumeroRO = indiceColuna(headers, ["Nº RO", "N° RO", "NumeroRO", "Num RO", "RO"]);
  const idxUltSts = indiceColuna(headers, ["Ult Sts", "Últ Sts", "Ultimo Status", "Último Status"]);
  const idxComentQualidade = indiceColuna(headers, ["Coment. Qualidade", "Comentario Qualidade", "Coment Qualidade"]);
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
        primeiraColuna.includes("ro")
      )
    ) {
      continue;
    }

    const cliente = String(cols[idxCliente >= 0 ? idxCliente : 0] || "").trim();

    const numeroRO = String(
      cols[idxNumeroRO >= 0 ? idxNumeroRO : 1] ||
      cols[1] ||
      cols[0] ||
      ""
    ).trim();

    if (!numeroRO || normalizarTexto(numeroRO).includes("numero")) continue;

    const ultStsRaw = String(cols[idxUltSts >= 0 ? idxUltSts : 3] || "").trim();
    const ultSts = parseInt(ultStsRaw.replace(/\D+/g, ""), 10);

    // Mantém a regra que usamos no dashboard:
    // RO pendente considerado como Ult Sts = 2.
    // Se a coluna não existir, não bloqueia a contagem.
    if (!Number.isNaN(ultSts) && ultSts !== 2) {
      continue;
    }

    const comentarioQualidade = normalizarTexto(
      cols[idxComentQualidade >= 0 ? idxComentQualidade : 9] || ""
    );

    if (
      comentarioQualidade.includes("tratativas pos vendas") ||
      comentarioQualidade.includes("tratativa pos vendas") ||
      comentarioQualidade.includes("pos vendas")
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
    "Content-Type, x-ro-key"
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
    // Validação da senha
    // ================================
    const authKey = req.headers["x-ro-key"];

    if (!process.env.UPDATE_SECRET || authKey !== process.env.UPDATE_SECRET) {
      return res.status(401).json({
        ok: false,
        message: "Senha de atualização inválida."
      });
    }

    // ================================
    // Recebe CSV do Dashboard
    // ================================
    const body = req.body || {};
    const csvText = body.csvText;
    const fileName = body.fileName || "Base_ROs_Import.csv";

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
    const path = process.env.GITHUB_FILE_PATH || fileName;
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
      ? contarPendentesRO(arquivoAnterior.content)
      : {
          qtd: 0,
          tonelagem: 0
        };

    const resumoAtual = contarPendentesRO(csvFinal);

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
      message: `Atualiza base RO - ${dataBR}`
    });

    // ================================
    // Cria/atualiza comparativo_ro.json
    // Esse arquivo será lido pela Central para mostrar:
    // Aumentou de X para Y / Diminuiu de X para Y
    // ================================
    const comparativoPath = "comparativo_ro.json";

    const arquivoComparativoAnterior = await buscarArquivoGithub({
      owner,
      repo,
      branch,
      path: comparativoPath,
      token
    }).catch(() => null);

    const comparativo = {
      tipo: "ro",
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
      message: `Atualiza comparativo RO - ${dataBR}`
    });

    return res.status(200).json({
      ok: true,
      message: "Base RO atualizada com sucesso no GitHub.",
      arquivo: path,
      comparativo,
      tamanhoCaracteres: csvFinal.length
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: "Erro interno na API.",
      detalhe: error.message
    });
  }
}
