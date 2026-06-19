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

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

    let sha = null;

    // ================================
    // Busca arquivo atual para pegar SHA
    // ================================
    const getFileResponse = await fetch(`${apiUrl}?ref=${branch}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    if (getFileResponse.ok) {
      const fileInfo = await getFileResponse.json();
      sha = fileInfo.sha;
    } else if (getFileResponse.status !== 404) {
      const erro = await getFileResponse.text();

      return res.status(500).json({
        ok: false,
        message: "Erro ao buscar arquivo atual no GitHub.",
        detalhe: erro
      });
    }

    // ================================
    // Converte CSV para Base64
    // ================================
    const contentBase64 = Buffer
      .from(csvFinal, "utf8")
      .toString("base64");

    const commitBody = {
      message: `Atualiza base ROI - ${new Date().toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo"
      })}`,
      content: contentBase64,
      branch: branch
    };

    if (sha) {
      commitBody.sha = sha;
    }

    // ================================
    // Atualiza/cria arquivo no GitHub
    // ================================
    const updateResponse = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify(commitBody)
    });

    if (!updateResponse.ok) {
      const erro = await updateResponse.text();

      return res.status(500).json({
        ok: false,
        message: "Erro ao atualizar arquivo ROI no GitHub.",
        detalhe: erro
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Base ROI atualizada com sucesso no GitHub.",
      arquivo: path,
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
