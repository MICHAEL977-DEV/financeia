// Vercel Serverless Function — api/ia.js
// Consultor IA — exclusivo para usuários Premium.
// Antes, qualquer pessoa podia chamar este endpoint diretamente (sem login,
// sem ser Premium) e consumir a cota da Groq API de graça. Agora validamos
// o token do usuário e o plano dele no Supabase antes de chamar a IA.

// Rate limit simples em memória (por instância da função).
// Não é uma garantia perfeita em serverless (cada instância tem seu próprio mapa),
// mas já barra scripts/abuso repetido dentro da mesma instância "quente".
// Se no futuro isso não for suficiente, o certo é migrar para um contador
// centralizado (ex: tabela no Supabase ou Upstash Redis).
const LIMITE_REQUISICOES = 15;
const JANELA_MS = 5 * 60 * 1000; // 5 minutos
const usoPorUsuario = new Map();

function excedeuLimite(userId) {
  const agora = Date.now();
  const historico = (usoPorUsuario.get(userId) || []).filter((t) => agora - t < JANELA_MS);
  historico.push(agora);
  usoPorUsuario.set(userId, historico);
  return historico.length > LIMITE_REQUISICOES;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const GROQ_KEY = process.env.GROQ_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pnntrciumzezombujhmh.supabase.co';
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!GROQ_KEY) {
    return res.status(500).json({ error: 'Chave da IA não configurada.' });
  }

  // 1. Extrair o token do usuário enviado pelo front-end
  const authHeader = req.headers['authorization'] || '';
  const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!userToken) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }

  try {
    // 2. Validar o token e descobrir quem é o usuário
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${userToken}`,
      },
    });

    if (!userResp.ok) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }

    const user = await userResp.json();
    if (!user || !user.id) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }

    // 3. Checar se o usuário é Premium (ou admin) na tabela perfis
    const perfilResp = await fetch(
      `${SUPABASE_URL}/rest/v1/perfis?id=eq.${user.id}&select=plano,perfil`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const perfilData = await perfilResp.json();
    const perfil = Array.isArray(perfilData) ? perfilData[0] : null;
    const ehPremium = perfil && (perfil.plano === 'premium' || perfil.perfil === 'adm');

    if (!ehPremium) {
      return res.status(403).json({ error: 'Recurso exclusivo do plano Premium.' });
    }

    // 3.5. Rate limit — evita abuso/custo excessivo com a Groq API
    if (excedeuLimite(user.id)) {
      return res.status(429).json({ error: 'Muitas mensagens em pouco tempo. Aguarde alguns minutos e tente novamente.' });
    }

    // 4. Tudo certo — chamar a IA
    const { messages, max_tokens } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Mensagens inválidas.' });
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: Math.min(max_tokens || 600, 1000), // limite de segurança
        messages: messages,
      }),
    });

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('[ia] Erro:', error);
    return res.status(500).json({ error: 'Erro ao conectar com a IA.' });
  }
}
