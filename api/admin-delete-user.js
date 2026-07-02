// Vercel Serverless Function — api/admin-delete-user.js
// Exclui um usuário (conta de login + todos os dados) — EXCLUSIVO do admin.
//
// Por que isso precisa ser um endpoint no servidor:
// excluir contas do Supabase Auth exige a chave service_role, que jamais
// pode ir para o navegador. O front envia só o token do admin logado;
// TODA a verificação de permissão acontece aqui, no servidor.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pnntrciumzezombujhmh.supabase.co';
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Configuração do servidor incompleta.' });
  }

  // 1. Identificar quem está chamando (token do front)
  const authHeader = req.headers['authorization'] || '';
  const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!userToken) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }

  try {
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${userToken}` },
    });
    if (!userResp.ok) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }
    const chamador = await userResp.json();
    if (!chamador || !chamador.id) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }

    // 2. Confirmar NO SERVIDOR que quem chamou é admin (nunca confiar no front)
    const perfilResp = await fetch(
      `${SUPABASE_URL}/rest/v1/perfis?id=eq.${chamador.id}&select=perfil`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const perfilData = await perfilResp.json();
    const chamadorPerfil = Array.isArray(perfilData) ? perfilData[0] : null;
    if (!chamadorPerfil || chamadorPerfil.perfil !== 'adm') {
      return res.status(403).json({ error: 'Apenas administradores podem excluir usuários.' });
    }

    // 3. Validar o alvo
    const { userId } = req.body || {};
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!userId || !UUID_RE.test(userId)) {
      return res.status(400).json({ error: 'ID de usuário inválido.' });
    }
    if (userId === chamador.id) {
      return res.status(400).json({ error: 'Você não pode excluir a própria conta de administrador.' });
    }

    // 4. Nunca excluir outra conta admin por esta rota
    const alvoResp = await fetch(
      `${SUPABASE_URL}/rest/v1/perfis?id=eq.${userId}&select=perfil`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const alvoData = await alvoResp.json();
    const alvoPerfil = Array.isArray(alvoData) ? alvoData[0] : null;
    if (alvoPerfil && alvoPerfil.perfil === 'adm') {
      return res.status(403).json({ error: 'Contas de administrador não podem ser excluídas por aqui.' });
    }

    // 5. Apagar os dados do usuário em todas as tabelas (explícito, sem
    //    depender de ON DELETE CASCADE existir nas foreign keys)
    const tabelasUserId = ['gastos', 'receitas', 'receitas_lanc', 'dividas', 'metas', 'orcamento', 'eventos', 'investimentos'];
    for (const tabela of tabelasUserId) {
      const del = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?user_id=eq.${userId}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      });
      if (!del.ok) {
        console.error(`[admin-delete] Falha ao limpar ${tabela}:`, del.status);
        return res.status(500).json({ error: `Falha ao apagar dados (${tabela}). Nada mais foi excluído — tente novamente.` });
      }
    }
    const delPerfil = await fetch(`${SUPABASE_URL}/rest/v1/perfis?id=eq.${userId}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (!delPerfil.ok) {
      console.error('[admin-delete] Falha ao apagar perfil:', delPerfil.status);
      return res.status(500).json({ error: 'Falha ao apagar o perfil. A conta de login não foi excluída.' });
    }

    // 6. Excluir a conta de login (Supabase Auth Admin API)
    const delAuth = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (!delAuth.ok) {
      const detalhe = await delAuth.text();
      console.error('[admin-delete] Falha na Auth Admin API:', delAuth.status, detalhe);
      return res.status(500).json({ error: 'Dados apagados, mas a conta de login não pôde ser excluída. Tente novamente.' });
    }

    console.log(`[admin-delete] Usuário ${userId} excluído pelo admin ${chamador.id}`);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[admin-delete] Erro:', error);
    return res.status(500).json({ error: 'Erro interno ao excluir usuário.' });
  }
}
