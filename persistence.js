// persistence.js
// Camada de dados: lê/escreve no Supabase quando configurado, senão usa o
// mesmo localStorage já usado pelo painel (chave "painel-gabi-v1").
//
// Modelo:
// - students: cadastro global de alunos — não muda de mês.
// - student_payments: status de pagamento por aluno/mês/ano (1 linha por combinação).
// - expenses: despesas por mês/ano — a base é clonada do mês anterior quando o mês novo está vazio.

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

// ---- alunos (cadastro global) ----

async function fetchActiveStudents() {
  if (!isSupabaseEnabled) {
    return (readLocal().students || []).filter((s) => s.active !== false);
  }
  const { data, error } = await supabase.from("students").select("*").eq("active", true).order("created_at");
  if (error) { console.error(error); return []; }
  return data;
}

// Insere um novo aluno no cadastro global (usado pelo formulário "+ Novo aluno").
export async function insertStudent({ studentName, guardianName, monthlyFee }) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.students.push({
      id: crypto.randomUUID(),
      student_name: studentName, guardian_name: guardianName, monthly_fee: monthlyFee,
      active: true,
    });
    writeLocal(state);
    return;
  }
  const { error } = await supabase.from("students").insert({
    student_name: studentName, guardian_name: guardianName, monthly_fee: monthlyFee, active: true,
  });
  if (error) console.error(error);
}

// "Remove" um aluno via soft-delete (active = false) — some de todos os meses.
export async function removeStudent(id) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.students = state.students.filter((s) => s.id !== id);
    writeLocal(state);
    return;
  }
  const { error } = await supabase.from("students").update({ active: false }).eq("id", id);
  if (error) console.error(error);
}

// ---- pagamento dos alunos, por mês/ano ----

async function fetchPayments(month, year) {
  if (!isSupabaseEnabled) {
    return (readLocal().payments || []).filter((p) => p.month === month && p.year === year);
  }
  const { data, error } = await supabase.from("student_payments").select("*").eq("month", month).eq("year", year);
  if (error) { console.error(error); return []; }
  return data;
}

// Define o status de pagamento de um aluno neste mês/ano — usada tanto pelo
// checkbox "Pago" quanto pela edição direta do campo de data (digitar um dia
// também marca como pago; limpar o campo desmarca). Sem data explícita e
// isPaid=true, usa hoje.
export async function setStudentPayment(studentId, month, year, isPaid, paymentDate) {
  const finalDate = isPaid ? (paymentDate || new Date().toISOString().slice(0, 10)) : null;
  if (!isSupabaseEnabled) {
    const state = readLocal();
    upsertLocalPayment(state, studentId, month, year, { is_paid: isPaid, payment_date: finalDate });
    writeLocal(state);
    return;
  }
  const { error } = await supabase
    .from("student_payments")
    .upsert({ student_id: studentId, month, year, is_paid: isPaid, payment_date: finalDate }, { onConflict: "student_id,month,year" });
  if (error) console.error(error);
}

// ---- despesas (por mês/ano, com auto-população das contas fixas) ----

// Modelo base do mês: entra sozinho em todo mês novo (sem nenhuma despesa
// ainda), com "Pago" zerado. As fixas já vêm com o valor de sempre; as
// variáveis entram com R$ 0,00, prontas para editar o valor daquele mês
// (a edição inline já existente cuida disso — nenhuma linha nova de código
// de UI é necessária para isso).
const BASE_EXPENSES = [
  // fixas — valor de sempre
  { description: "Das - empresa",    category: "Empresa",     amount: 87.05 },
  { description: "Crédito",          category: "Celular",     amount: 30.00 },
  { description: "Lavagem de roupa", category: "Serviços",    amount: 80.00 },
  { description: "Tv - parcela",     category: "Assinaturas", amount: 60.00 },
  // variáveis — recorrentes todo mês, mas o valor muda; entram zeradas
  { description: "Cartão de crédito", category: "Cartão",  amount: 0 },
  { description: "Aluguel das casas", category: "Moradia", amount: 0 },
  { description: "Gastos extras",     category: "Extras",  amount: 0 },
];

async function fetchExpenses(month, year) {
  if (!isSupabaseEnabled) {
    return (readLocal().expenses || []).filter((e) => e.month === month && e.year === year);
  }
  const { data, error } = await supabase.from("expenses").select("*").eq("month", month).eq("year", year).order("created_at");
  if (error) { console.error(error); return []; }
  return data;
}

export async function updateExpense(id, patch) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    const exp = state.expenses.find((e) => e.id === id);
    if (exp) Object.assign(exp, patch);
    writeLocal(state);
    return;
  }
  const { error } = await supabase.from("expenses").update(patch).eq("id", id);
  if (error) console.error(error);
}

export async function togglePaid(id, isPaid) {
  return updateExpense(id, { is_paid: isPaid });
}

export async function insertExpense({ description, category, amount, dueDate, month, year }) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.expenses.push({ id: crypto.randomUUID(), description, category, amount, due_date: dueDate || null, is_paid: false, month, year });
    writeLocal(state);
    return;
  }
  const { error } = await supabase
    .from("expenses")
    .insert({ description, category, amount, due_date: dueDate || null, is_paid: false, month, year });
  if (error) console.error(error);
}

export async function deleteExpense(id) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.expenses = state.expenses.filter((e) => e.id !== id);
    writeLocal(state);
    return;
  }
  const { error } = await supabase.from("expenses").delete().eq("id", id);
  if (error) console.error(error);
}

// Se o mês/ano informado ainda não tiver nenhuma despesa, insere o modelo
// base completo (BASE_EXPENSES — fixas + variáveis zeradas) em lote e devolve
// a lista já atualizada. Se já houver despesas, não mexe em nada.
async function seedBaseExpensesIfEmpty(month, year) {
  const current = await fetchExpenses(month, year);
  if (current.length) return current;

  const toInsert = BASE_EXPENSES.map((e) => ({ ...e, due_date: null, is_paid: false, month, year }));

  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.expenses = (state.expenses || []).concat(toInsert.map((e) => ({ id: crypto.randomUUID(), ...e })));
    writeLocal(state);
    return fetchExpenses(month, year);
  }

  const { error } = await supabase.from("expenses").insert(toInsert);
  if (error) console.error(error);
  return fetchExpenses(month, year);
}

// ---- carregamento do mês ativo ----

// Chamada ao trocar de mês, ao carregar a página, e a cada evento realtime:
// - os alunos ativos são sempre os mesmos, em qualquer mês (cadastro global);
// - o status de pagamento de cada aluno vem de student_payments, filtrado por month/year;
// - despesas: se o mês estiver vazio, o modelo base completo (BASE_EXPENSES) é inserido em lote.
export async function loadMonthData(month, year) {
  const [students, payments] = await Promise.all([fetchActiveStudents(), fetchPayments(month, year)]);

  const paymentByStudent = {};
  payments.forEach((p) => { paymentByStudent[p.student_id] = p; });

  const studentsWithStatus = students.map((s) => {
    const p = paymentByStudent[s.id];
    return { ...s, is_paid: p ? p.is_paid : false, payment_date: p ? p.payment_date : null };
  });

  const expenses = await seedBaseExpensesIfEmpty(month, year);

  return { students: studentsWithStatus, expenses };
}

// ---- tempo real ----

// Assina mudanças em tempo real (outro dispositivo pagou uma conta, marcou um
// aluno como pago, editou um valor etc.) e chama onChange para o app rebuscar
// o mês em exibição e redesenhar.
export function subscribeRealtime(onChange) {
  if (!isSupabaseEnabled) return () => {};

  const channel = supabase
    .channel("painel-gabi-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "expenses" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "students" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "student_payments" }, onChange)
    .subscribe();

  return () => supabase.removeChannel(channel);
}
