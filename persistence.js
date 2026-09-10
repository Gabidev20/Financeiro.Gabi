// persistence.js
// Camada de dados: lê/escreve no Supabase quando configurado, senão usa o
// mesmo localStorage já usado pelo painel (chave "painel-gabi-v1").
//
// Toda operação contra o Supabase é envolvida em try/catch e loga o erro
// completo (message/code/details/hint do Postgres — o que costuma apontar
// direto pra causa: RLS, coluna errada, tipo errado) — nada falha em
// silêncio. Toda escrita devolve o que realmente foi confirmado pelo banco
// (a linha com o id gerado, ou true/false), para a UI nunca depender de um
// id temporário local ou assumir sucesso sem checar.
//
// Modelo:
// - students: cadastro global de alunos — não muda de mês.
// - student_payments: status de pagamento por aluno/mês/ano (1 linha por combinação).
// - expenses: despesas por mês/ano — o modelo base (fixas + variáveis) é
//   inserido automaticamente na primeira visita a um mês vazio.

import { supabase, isSupabaseEnabled } from "./supabaseClient.js";

const LOCAL_KEY = "painel-gabi-v1";

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || { expenses: [], students: [], payments: [] }; }
  catch (e) { return { expenses: [], students: [], payments: [] }; }
}
function writeLocal(state) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch (e) {}
}
function upsertLocalPayment(state, studentId, month, year, patch) {
  state.payments = state.payments || [];
  let p = state.payments.find((p) => p.student_id === studentId && p.month === month && p.year === year);
  if (!p) {
    p = { student_id: studentId, month, year, is_paid: false, payment_date: null };
    state.payments.push(p);
  }
  Object.assign(p, patch);
  return p;
}
function logSupabaseError(op, payload, error) {
  console.error("[persistence] " + op + " falhou — confira RLS/schema no Supabase", { payload, error });
}

// ---- alunos (cadastro global) ----

async function fetchActiveStudents() {
  if (!isSupabaseEnabled) {
    return (readLocal().students || []).filter((s) => s.active !== false);
  }
  try {
    const { data, error } = await supabase.from("students").select("*").eq("active", true).order("created_at");
    if (error) { logSupabaseError("fetchActiveStudents", null, error); return []; }
    return data || [];
  } catch (err) {
    logSupabaseError("fetchActiveStudents", null, err);
    return [];
  }
}

// Insere um novo aluno no cadastro global. Devolve a linha salva (com o id
// real do Supabase) ou null se a gravação falhar. userId é o id da sessão
// ativa (session.user.id) — obrigatório para passar no RLS "own rows".
export async function insertStudent({ studentName, guardianName, monthlyFee, userId }) {
  const payload = { student_name: studentName, guardian_name: guardianName, monthly_fee: monthlyFee, active: true, user_id: userId };
  if (!isSupabaseEnabled) {
    const row = { id: crypto.randomUUID(), ...payload };
    const state = readLocal();
    state.students.push(row);
    writeLocal(state);
    return row;
  }
  try {
    const { data, error } = await supabase.from("students").insert(payload).select().single();
    if (error) { logSupabaseError("insertStudent", payload, error); return null; }
    return data;
  } catch (err) {
    logSupabaseError("insertStudent", payload, err);
    return null;
  }
}

// "Remove" um aluno via soft-delete (active = false) — some de todos os meses.
export async function removeStudent(id) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.students = state.students.filter((s) => s.id !== id);
    writeLocal(state);
    return true;
  }
  try {
    const { error } = await supabase.from("students").update({ active: false }).eq("id", id);
    if (error) { logSupabaseError("removeStudent", { id }, error); return false; }
    return true;
  } catch (err) {
    logSupabaseError("removeStudent", { id }, err);
    return false;
  }
}

// ---- pagamento dos alunos, por mês/ano ----

async function fetchPayments(month, year) {
  if (!isSupabaseEnabled) {
    return (readLocal().payments || []).filter((p) => p.month === month && p.year === year);
  }
  try {
    const { data, error } = await supabase.from("student_payments").select("*").eq("month", month).eq("year", year);
    if (error) { logSupabaseError("fetchPayments", { month, year }, error); return []; }
    return data || [];
  } catch (err) {
    logSupabaseError("fetchPayments", { month, year }, err);
    return [];
  }
}

// Define o status de pagamento de um aluno neste mês/ano (checkbox "Pago" ou
// edição direta da data). Devolve true se o Supabase confirmou a gravação.
// userId é o id da sessão ativa — necessário no upsert para passar no RLS.
export async function setStudentPayment(studentId, month, year, isPaid, paymentDate, userId) {
  const finalDate = isPaid ? (paymentDate || new Date().toISOString().slice(0, 10)) : null;
  const payload = { student_id: studentId, month, year, is_paid: isPaid, payment_date: finalDate, user_id: userId };
  if (!isSupabaseEnabled) {
    const state = readLocal();
    upsertLocalPayment(state, studentId, month, year, { is_paid: isPaid, payment_date: finalDate });
    writeLocal(state);
    return true;
  }
  try {
    const { error } = await supabase
      .from("student_payments")
      .upsert(payload, { onConflict: "student_id,month,year" });
    if (error) { logSupabaseError("setStudentPayment", payload, error); return false; }
    return true;
  } catch (err) {
    logSupabaseError("setStudentPayment", payload, err);
    return false;
  }
}

// ---- despesas (por mês/ano, com auto-população do modelo base) ----

// Modelo base do mês: entra sozinho em todo mês novo (sem nenhuma despesa
// ainda), com "Pago" zerado. As fixas já vêm com o valor de sempre; as
// variáveis entram com R$ 0,00, prontas para editar o valor daquele mês.
const BASE_EXPENSES = [
  { description: "Das - empresa",    category: "Empresa",     amount: 87.05 },
  { description: "Crédito",          category: "Celular",     amount: 30.00 },
  { description: "Lavagem de roupa", category: "Serviços",    amount: 80.00 },
  { description: "Tv - parcela",     category: "Assinaturas", amount: 60.00 },
  { description: "Cartão de crédito", category: "Cartão",  amount: 0 },
  { description: "Aluguel das casas", category: "Moradia", amount: 0 },
  { description: "Gastos extras",     category: "Extras",  amount: 0 },
];

async function fetchExpenses(month, year) {
  if (!isSupabaseEnabled) {
    return (readLocal().expenses || []).filter((e) => e.month === month && e.year === year);
  }
  try {
    const { data, error } = await supabase
      .from("expenses")
      .select("*")
      .eq("month", month)
      .eq("year", year)
      .order("created_at", { ascending: true });
    if (error) { logSupabaseError("fetchExpenses", { month, year }, error); return []; }
    return data || [];
  } catch (err) {
    logSupabaseError("fetchExpenses", { month, year }, err);
    return [];
  }
}

// Atualiza campos de uma despesa pelo id real do Supabase (nunca por índice
// de array). Devolve true só se o Supabase confirmou ter alterado a linha —
// zero linhas afetadas sem erro geralmente é RLS bloqueando ou id errado.
export async function updateExpense(id, patch) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    const exp = state.expenses.find((e) => e.id === id);
    if (exp) Object.assign(exp, patch);
    writeLocal(state);
    return true;
  }
  try {
    const { data, error } = await supabase.from("expenses").update(patch).eq("id", id).select();
    if (error) { logSupabaseError("updateExpense", { id, patch }, error); return false; }
    if (!data || !data.length) {
      console.warn("[persistence] updateExpense não alterou nenhuma linha (id inexistente ou bloqueado por RLS)", { id, patch });
      return false;
    }
    return true;
  } catch (err) {
    logSupabaseError("updateExpense", { id, patch }, err);
    return false;
  }
}

export async function togglePaid(id, isPaid) {
  return updateExpense(id, { is_paid: isPaid });
}

// Insere uma despesa nova. Devolve a linha salva (com o id real do Supabase)
// ou null se a gravação falhar — a UI deve tratar null como erro visível,
// nunca manter a linha só no estado local. userId é o id da sessão ativa.
export async function insertExpense({ description, category, amount, dueDate, month, year, userId }) {
  const payload = { description, category, amount, due_date: dueDate || null, is_paid: false, month, year, user_id: userId };
  if (!isSupabaseEnabled) {
    const row = { id: crypto.randomUUID(), ...payload };
    const state = readLocal();
    state.expenses.push(row);
    writeLocal(state);
    return row;
  }
  try {
    const { data, error } = await supabase.from("expenses").insert(payload).select().single();
    if (error) { logSupabaseError("insertExpense", payload, error); return null; }
    return data;
  } catch (err) {
    logSupabaseError("insertExpense", payload, err);
    return null;
  }
}

export async function deleteExpense(id) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.expenses = state.expenses.filter((e) => e.id !== id);
    writeLocal(state);
    return true;
  }
  try {
    const { error } = await supabase.from("expenses").delete().eq("id", id);
    if (error) { logSupabaseError("deleteExpense", { id }, error); return false; }
    return true;
  } catch (err) {
    logSupabaseError("deleteExpense", { id }, err);
    return false;
  }
}

// Se o mês/ano informado ainda não tiver nenhuma despesa, insere o modelo
// base completo (BASE_EXPENSES) em UM insert em lote e devolve as linhas já
// com o id real gerado pelo Supabase. Se a inserção falhar, loga o erro em
// detalhe e devolve [] (a tela mostra "nenhuma despesa" em vez de fantasmas).
// userId é o id da sessão ativa, obrigatório no insert para passar no RLS.
async function seedBaseExpensesIfEmpty(month, year, userId) {
  const current = await fetchExpenses(month, year);
  if (current.length) return current;

  const toInsert = BASE_EXPENSES.map((e) => ({ ...e, due_date: null, is_paid: false, month, year, user_id: userId }));

  if (!isSupabaseEnabled) {
    const rows = toInsert.map((e) => ({ id: crypto.randomUUID(), ...e }));
    const state = readLocal();
    state.expenses = (state.expenses || []).concat(rows);
    writeLocal(state);
    return rows;
  }

  try {
    const { data, error } = await supabase.from("expenses").insert(toInsert).select();
    if (error) { logSupabaseError("seedBaseExpensesIfEmpty", { month, year, toInsert }, error); return []; }
    return data || [];
  } catch (err) {
    logSupabaseError("seedBaseExpensesIfEmpty", { month, year, toInsert }, err);
    return [];
  }
}

// ---- carregamento do mês ativo ----

// Chamada ao trocar de mês, ao carregar a página, e a cada evento realtime:
// - os alunos ativos são sempre os mesmos, em qualquer mês (cadastro global);
//   a leitura já vem filtrada por dono pelo RLS — não precisa passar userId aqui;
// - o status de pagamento de cada aluno vem de student_payments, filtrado por month/year;
// - despesas: se o mês estiver vazio, o modelo base completo é inserido em lote
//   (por isso o insert PRECISA de userId) e a lista devolvida já vem com os ids reais.
export async function loadMonthData(month, year, userId) {
  const [students, payments] = await Promise.all([fetchActiveStudents(), fetchPayments(month, year)]);

  const paymentByStudent = {};
  payments.forEach((p) => { paymentByStudent[p.student_id] = p; });

  const studentsWithStatus = students.map((s) => {
    const p = paymentByStudent[s.id];
    return { ...s, is_paid: p ? p.is_paid : false, payment_date: p ? p.payment_date : null };
  });

  const expenses = await seedBaseExpensesIfEmpty(month, year, userId);

  return { students: studentsWithStatus, expenses };
}

// ---- tempo real ----

// Assina mudanças em tempo real (outro dispositivo pagou uma conta, marcou um
// aluno como pago, editou um valor etc.) e chama onChange para o app rebuscar
// o mês em exibição e redesenhar. Loga se a própria assinatura falhar (ex.:
// tabela não incluída na publication supabase_realtime).
export function subscribeRealtime(onChange) {
  if (!isSupabaseEnabled) return () => {};

  const channel = supabase
    .channel("painel-gabi-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "expenses" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "students" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "student_payments" }, onChange)
    .subscribe((status, err) => {
      if (err) console.error("[persistence] falha ao assinar o realtime", err);
    });

  return () => supabase.removeChannel(channel);
}
