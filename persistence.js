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

// Marca/desmarca a mensalidade de um aluno como paga NESTE mês/ano, registrando a data do clique.
export async function toggleStudentPaid(studentId, month, year, isPaid) {
  const payment_date = isPaid ? new Date().toISOString().slice(0, 10) : null;
  if (!isSupabaseEnabled) {
    const state = readLocal();
    upsertLocalPayment(state, studentId, month, year, { is_paid: isPaid, payment_date });
    writeLocal(state);
    return;
  }
  const { error } = await supabase
    .from("student_payments")
    .upsert({ student_id: studentId, month, year, is_paid: isPaid, payment_date }, { onConflict: "student_id,month,year" });
  if (error) console.error(error);
}

// Corrige a data de um pagamento já marcado (usuário digitou outro dia).
export async function updateStudentPaymentDate(studentId, month, year, paymentDate) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    upsertLocalPayment(state, studentId, month, year, { payment_date: paymentDate });
    writeLocal(state);
    return;
  }
  const { error } = await supabase
    .from("student_payments")
    .upsert({ student_id: studentId, month, year, payment_date: paymentDate }, { onConflict: "student_id,month,year" });
  if (error) console.error(error);
}

// ---- despesas (por mês/ano, com clonagem da base do mês anterior) ----

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

// Move um dia de vencimento para outro mês/ano, ajustando para o último dia
// do mês se ele for mais curto (ex.: dia 31 clonado para um mês de 30 dias).
function shiftDueDate(dueDate, toMonth, toYear) {
  if (!dueDate) return null;
  const day = Number(String(dueDate).split("-")[2]);
  const lastDay = new Date(toYear, toMonth, 0).getDate();
  return toYear + "-" + String(toMonth).padStart(2, "0") + "-" + String(Math.min(day, lastDay)).padStart(2, "0");
}

// Se o mês de destino ainda não tiver despesas, clona a base do mês anterior
// (descrição, categoria, valor, vencimento ajustado) com "Pago" zerado.
async function cloneExpensesIfEmpty(fromMonth, fromYear, toMonth, toYear) {
  const current = await fetchExpenses(toMonth, toYear);
  if (current.length) return current;

  const source = await fetchExpenses(fromMonth, fromYear);
  if (!source.length) return current;

  const toInsert = source.map((e) => ({
    description: e.description,
    category: e.category,
    amount: e.amount,
    due_date: shiftDueDate(e.due_date, toMonth, toYear),
    is_paid: false,
    month: toMonth,
    year: toYear,
  }));

  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.expenses = (state.expenses || []).concat(toInsert.map((e) => ({ id: crypto.randomUUID(), ...e })));
    writeLocal(state);
    return fetchExpenses(toMonth, toYear);
  }

  const { error } = await supabase.from("expenses").insert(toInsert);
  if (error) console.error(error);
  return fetchExpenses(toMonth, toYear);
}

// ---- carregamento do mês ativo ----

// Chamada ao trocar de mês, ao carregar a página, e a cada evento realtime:
// - os alunos ativos são sempre os mesmos, em qualquer mês (não são clonados);
// - o status de pagamento de cada aluno vem de student_payments, filtrado por month/year;
// - despesas são clonadas da base do mês anterior na primeira visita a um mês novo.
export async function loadMonthData(month, year) {
  const [students, payments] = await Promise.all([fetchActiveStudents(), fetchPayments(month, year)]);

  const paymentByStudent = {};
  payments.forEach((p) => { paymentByStudent[p.student_id] = p; });

  const studentsWithStatus = students.map((s) => {
    const p = paymentByStudent[s.id];
    return { ...s, is_paid: p ? p.is_paid : false, payment_date: p ? p.payment_date : null };
  });

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const expenses = await cloneExpensesIfEmpty(prevMonth, prevYear, month, year);

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
