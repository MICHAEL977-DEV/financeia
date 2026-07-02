// Vercel Serverless Function — api/relatorio-mensal.js
// Envia, todo dia 1º, um resumo do mês anterior por e-mail para usuários
// Premium. Disparado pelo cron da Vercel (configurado no vercel.json).
//
// Variáveis de ambiente necessárias (Vercel → Settings → Environment Variables):
//   CRON_SECRET     — string aleatória; a Vercel envia automaticamente como
//                     "Authorization: Bearer <CRON_SECRET>" nas chamadas de cron
//   RESEND_API_KEY  — chave da API do Resend (o domínio já está verificado)
//   SUPABASE_SERVICE_KEY — já existe (mesma dos outros endpoints)

const MESES_NOME = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function fmtBRL(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export default async function handler(req, res) {
  // Só o cron da Vercel (ou você, com o segredo) pode disparar
  const auth = req.headers['authorization'] || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pnntrciumzezombujhmh.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!SERVICE_KEY || !RESEND_KEY) {
    return res.status(500).json({ error: 'Variáveis de ambiente faltando (SUPABASE_SERVICE_KEY / RESEND_API_KEY).' });
  }
  const sbHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  try {
    // Mês anterior (referência: horário de Brasília ≈ UTC-3)
    const agora = new Date(Date.now() - 3 * 3600 * 1000);
    let ano = agora.getUTCFullYear();
    let mes = agora.getUTCMonth() - 1; // mês anterior (0-11)
    if (mes < 0) { mes = 11; ano -= 1; }
    // Modo de teste (protegido pelo mesmo CRON_SECRET):
    // ?teste=mes-atual → envia o relatório do mês CORRENTE, útil pra validar
    // o e-mail sem esperar o dia 1º.
    if (req.query && req.query.teste === 'mes-atual') {
      ano = agora.getUTCFullYear();
      mes = agora.getUTCMonth();
    }

    // Usuários Premium (assinantes de verdade — trial não recebe)
    const usersResp = await fetch(
      `${SUPABASE_URL}/rest/v1/perfis?plano=eq.premium&select=id,nome,email&limit=200`,
      { headers: sbHeaders }
    );
    const usuarios = await usersResp.json();
    if (!Array.isArray(usuarios) || usuarios.length === 0) {
      return res.status(200).json({ ok: true, enviados: 0, detalhe: 'Nenhum usuário premium.' });
    }

    let enviados = 0;
    const erros = [];

    for (const u of usuarios) {
      if (!u.email) continue;
      try {
        // Gastos do mês anterior
        const gResp = await fetch(
          `${SUPABASE_URL}/rest/v1/gastos?user_id=eq.${u.id}&ano=eq.${ano}&mes=eq.${mes}&select=valor,categoria,descricao`,
          { headers: sbHeaders }
        );
        const gastos = (await gResp.json()) || [];
        // Receita do mês anterior
        const rResp = await fetch(
          `${SUPABASE_URL}/rest/v1/receitas?user_id=eq.${u.id}&ano=eq.${ano}&mes=eq.${mes}&select=valor`,
          { headers: sbHeaders }
        );
        const recRows = (await rResp.json()) || [];
        const receita = recRows.reduce((a, r) => a + Number(r.valor || 0), 0);
        const totalGastos = gastos.reduce((a, g) => a + Number(g.valor || 0), 0);

        if (!gastos.length && receita === 0) continue; // sem dados, sem e-mail

        const saldo = receita - totalGastos;
        const porCat = {};
        gastos.forEach((g) => { porCat[g.categoria] = (porCat[g.categoria] || 0) + Number(g.valor || 0); });
        const topCats = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const maior = gastos.length ? gastos.reduce((a, g) => (Number(g.valor) > Number(a.valor) ? g : a), gastos[0]) : null;

        const catRows = topCats.map(([c, v]) =>
          `<tr><td style="padding:6px 0;color:#333">${c}</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#333">${fmtBRL(v)}</td></tr>`
        ).join('');

        const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;background:#F2F7F5;padding:24px;border-radius:16px">
  <div style="background:linear-gradient(135deg,#0a5c46,#0F6E56);border-radius:12px;padding:20px 24px;color:#fff;margin-bottom:16px">
    <div style="font-size:13px;opacity:.8">FinanceIA · Relatório mensal</div>
    <div style="font-size:22px;font-weight:800;margin-top:4px">${MESES_NOME[mes]} de ${ano}</div>
  </div>
  <div style="background:#fff;border-radius:12px;padding:20px 24px;margin-bottom:12px">
    <table style="width:100%;font-size:14px">
      <tr><td style="padding:6px 0;color:#555">Entradas</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#0F6E56">${fmtBRL(receita)}</td></tr>
      <tr><td style="padding:6px 0;color:#555">Gastos</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#E24B4A">${fmtBRL(totalGastos)}</td></tr>
      <tr><td style="padding:8px 0;color:#333;font-weight:700;border-top:1px solid #eee">Saldo do mês</td><td style="padding:8px 0;text-align:right;font-weight:800;border-top:1px solid #eee;color:${saldo >= 0 ? '#0F6E56' : '#E24B4A'}">${fmtBRL(saldo)}</td></tr>
    </table>
  </div>
  ${topCats.length ? `<div style="background:#fff;border-radius:12px;padding:20px 24px;margin-bottom:12px">
    <div style="font-size:14px;font-weight:700;color:#333;margin-bottom:8px">Onde o dinheiro foi</div>
    <table style="width:100%;font-size:13px">${catRows}</table>
  </div>` : ''}
  ${maior ? `<div style="background:#fff;border-radius:12px;padding:16px 24px;margin-bottom:16px;font-size:13px;color:#555">
    Maior gasto do mês: <b style="color:#333">${(maior.descricao || '').slice(0, 40)}</b> (${fmtBRL(maior.valor)})
  </div>` : ''}
  <a href="https://app.financeiaapp.com.br" style="display:block;text-align:center;background:#EF9F27;color:#412402;font-weight:700;padding:12px;border-radius:10px;text-decoration:none;font-size:14px">Abrir o FinanceIA</a>
  <div style="text-align:center;font-size:11px;color:#999;margin-top:16px">Você recebe este resumo por ser assinante Premium do FinanceIA.</div>
</div>`;

        const envio = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({
            from: 'FinanceIA <relatorio@financeiaapp.com.br>',
            to: [u.email],
            subject: `Seu resumo de ${MESES_NOME[mes]} — FinanceIA`,
            html,
          }),
        });
        if (envio.ok) enviados++;
        else erros.push(`${u.email}: ${envio.status}`);
      } catch (e) {
        erros.push(`${u.email}: ${e.message}`);
      }
    }

    console.log(`[relatorio-mensal] ${MESES_NOME[mes]}/${ano}: ${enviados} enviados, ${erros.length} erros`, erros.slice(0, 5));
    return res.status(200).json({ ok: true, mes: `${MESES_NOME[mes]}/${ano}`, enviados, erros: erros.length });
  } catch (error) {
    console.error('[relatorio-mensal] Erro:', error);
    return res.status(500).json({ error: 'Erro interno.' });
  }
}
