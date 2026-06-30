// Vercel Serverless Function — api/stripe-webhook.js
// Recebe eventos do Stripe e atualiza o plano do usuário no Supabase

export const config = {
  api: {
    bodyParser: false, // Stripe precisa do raw body para verificar assinatura
  },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Busca um usuário no Supabase Auth pelo e-mail.
// IMPORTANTE: a Admin API não tem parâmetro "email", e sim "filter"
// (que faz busca PARCIAL). Por isso validamos o e-mail exato no resultado.
async function findUserByEmail(SUPABASE_URL, SUPABASE_SERVICE_KEY, email) {
  const url = `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`;
  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[webhook] Erro ao buscar usuário (status ${response.status}):`, errText);
    return null;
  }

  const data = await response.json();
  const users = data.users || [];
  console.log(`[webhook] Busca por "${email}" retornou ${users.length} candidato(s)`);

  // "filter" faz busca parcial — confirmamos o e-mail exato (case-insensitive)
  const exactMatch = users.find(
    (u) => u.email && u.email.toLowerCase() === email.toLowerCase()
  );

  if (!exactMatch) {
    console.error(`[webhook] Nenhum usuário com e-mail exato "${email}" encontrado entre os candidatos`);
    return null;
  }

  console.log(`[webhook] Usuário encontrado: id=${exactMatch.id}, email=${exactMatch.email}`);
  return exactMatch;
}

async function updatePlano(SUPABASE_URL, SUPABASE_SERVICE_KEY, userId, plano) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/perfis?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ plano }),
  });

  const result = await response.json();

  if (!response.ok) {
    console.error(`[webhook] Erro ao atualizar plano (status ${response.status}):`, result);
    return false;
  }

  if (Array.isArray(result) && result.length === 0) {
    console.error(`[webhook] PATCH não afetou nenhuma linha — id=${userId} não existe em "perfis"?`);
    return false;
  }

  console.log(`[webhook] Plano atualizado para "${plano}" com sucesso:`, result);
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pnntrciumzezombujhmh.supabase.co';
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  try {
    const rawBody = await getRawBody(req);
    const sig = req.headers['stripe-signature'];

    // Verificar assinatura do Stripe (segurança)
    const crypto = await import('crypto');
    const elements = sig.split(',');
    const timestamp = elements.find((e) => e.startsWith('t=')).split('=')[1];
    const signature = elements.find((e) => e.startsWith('v1=')).split('=')[1];
    const signedPayload = `${timestamp}.${rawBody.toString()}`;
    const expectedSig = crypto
      .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
      .update(signedPayload)
      .digest('hex');

    if (expectedSig !== signature) {
      console.error('[webhook] Assinatura inválida');
      return res.status(400).json({ error: 'Assinatura inválida' });
    }

    const event = JSON.parse(rawBody.toString());
    console.log(`[webhook] Evento recebido: ${event.type}`);

    // Processar evento de pagamento concluído
    if (event.type === 'checkout.session.completed' || event.type === 'invoice.paid') {
      const session = event.data.object;
      const customerEmail = session.customer_email || session.customer_details?.email;
      console.log(`[webhook] E-mail do evento: ${customerEmail}`);

      // Para checkout.session.completed, pagamentos assíncronos (ex: boleto)
      // disparam esse evento ANTES da confirmação real do pagamento.
      // payment_status só vem como "paid" quando o dinheiro já caiu.
      if (event.type === 'checkout.session.completed' && session.payment_status !== 'paid') {
        console.log(`[webhook] Pagamento ainda não confirmado (payment_status=${session.payment_status}) — aguardando.`);
      } else if (!customerEmail) {
        console.error('[webhook] Evento sem e-mail do cliente — não há como localizar o usuário');
      } else {
        const user = await findUserByEmail(SUPABASE_URL, SUPABASE_SERVICE_KEY, customerEmail);
        if (user) {
          await updatePlano(SUPABASE_URL, SUPABASE_SERVICE_KEY, user.id, 'premium');
        }
      }
    }

    // Processar cancelamento de assinatura
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const customerResponse = await fetch(
        `https://api.stripe.com/v1/customers/${subscription.customer}`,
        { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
      );
      const customer = await customerResponse.json();
      console.log(`[webhook] Cancelamento — e-mail do cliente: ${customer.email}`);

      if (customer.email) {
        const user = await findUserByEmail(SUPABASE_URL, SUPABASE_SERVICE_KEY, customer.email);
        if (user) {
          await updatePlano(SUPABASE_URL, SUPABASE_SERVICE_KEY, user.id, 'padrao');
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('[webhook] Erro inesperado:', error);
    return res.status(400).json({ error: error.message });
  }
}
