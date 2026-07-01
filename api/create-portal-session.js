// Vercel Serverless Function — api/create-portal-session.js
// Cria uma sessão do Stripe Customer Portal para o usuário logado
// poder gerenciar (ou cancelar) a própria assinatura Premium.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pnntrciumzezombujhmh.supabase.co';
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

  // 1. Validar o token do usuário
  const authHeader = req.headers['authorization'] || '';
  const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!userToken) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }

  try {
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

    // 2. Buscar o stripe_customer_id salvo no perfil
    const perfilResp = await fetch(
      `${SUPABASE_URL}/rest/v1/perfis?id=eq.${user.id}&select=stripe_customer_id`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const perfilData = await perfilResp.json();
    let customerId = perfilData && perfilData[0] && perfilData[0].stripe_customer_id;

    // 3. Fallback para assinantes antigos (compraram antes de termos essa coluna):
    //    busca o customer no Stripe pelo e-mail da conta.
    //    SEGURANÇA: só aceita se o e-mail da conta foi CONFIRMADO — sem isso,
    //    alguém poderia cadastrar uma conta com e-mail alheio (não confirmado)
    //    e abrir o portal de cobrança de um cliente Stripe com aquele e-mail.
    if (!customerId && user.email && user.email_confirmed_at) {
      const custResp = await fetch(
        `https://api.stripe.com/v1/customers?email=${encodeURIComponent(user.email)}&limit=1`,
        { headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` } }
      );
      const custData = await custResp.json();
      if (custData.data && custData.data[0]) {
        customerId = custData.data[0].id;
        console.log(`[portal] Customer encontrado via fallback de e-mail: ${customerId}`);
      }
    }

    if (!customerId) {
      console.error(`[portal] Nenhum stripe_customer_id encontrado para user.id=${user.id}`);
      return res.status(404).json({ error: 'Nenhuma assinatura encontrada para esta conta.' });
    }

    // 4. Criar a sessão do Portal
    const params = new URLSearchParams();
    params.append('customer', customerId);
    params.append('return_url', 'https://app.financeiaapp.com.br');

    const portalResp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const portalData = await portalResp.json();

    if (!portalResp.ok) {
      console.error('[portal] Erro ao criar sessão do portal:', portalData);
      return res.status(500).json({ error: portalData.error?.message || 'Erro ao criar sessão do portal.' });
    }

    console.log(`[portal] Sessão criada com sucesso para customer=${customerId}`);
    return res.status(200).json({ url: portalData.url });
  } catch (error) {
    console.error('[portal] Erro inesperado:', error);
    return res.status(500).json({ error: 'Erro ao processar solicitação.' });
  }
}
