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
    const timestamp = elements.find(e => e.startsWith('t=')).split('=')[1];
    const signature = elements.find(e => e.startsWith('v1=')).split('=')[1];
    const signedPayload = `${timestamp}.${rawBody.toString()}`;
    const expectedSig = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET)
      .update(signedPayload)
      .digest('hex');

    if (expectedSig !== signature) {
      return res.status(400).json({ error: 'Assinatura inválida' });
    }

    const event = JSON.parse(rawBody.toString());

    // Processar evento de pagamento concluído
    if (event.type === 'checkout.session.completed' || event.type === 'invoice.paid') {
      const session = event.data.object;
      const customerEmail = session.customer_email || session.customer_details?.email;

      if (customerEmail) {
        // Buscar usuário pelo e-mail e atualizar para Premium
        const userResponse = await fetch(
          `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(customerEmail)}`,
          {
            headers: {
              'apikey': SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            },
          }
        );
        const userData = await userResponse.json();
        const user = userData.users?.[0];

        if (user) {
          await fetch(`${SUPABASE_URL}/rest/v1/perfis?id=eq.${user.id}`, {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation',
            },
            body: JSON.stringify({ plano: 'premium' }),
          });
        }
      }
    }

    // Processar cancelamento de assinatura
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const customerResponse = await fetch(
        `https://api.stripe.com/v1/customers/${subscription.customer}`,
        {
          headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` },
        }
      );
      const customer = await customerResponse.json();

      if (customer.email) {
        const userResponse = await fetch(
          `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(customer.email)}`,
          {
            headers: {
              'apikey': SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            },
          }
        );
        const userData = await userResponse.json();
        const user = userData.users?.[0];

        if (user) {
          await fetch(`${SUPABASE_URL}/rest/v1/perfis?id=eq.${user.id}`, {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation',
            },
            body: JSON.stringify({ plano: 'padrao' }),
          });
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Erro no webhook:', error);
    return res.status(400).json({ error: error.message });
  }
}
