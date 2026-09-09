// persistence.js
// Camada de dados: lê/escreve no Supabase quando configurado, senão usa o
// mesmo localStorage já usado pelo painel (chave "painel-gabi-v1").
// Alunos e despesas agora são escopados por mês/ano — cada mês é seu próprio
// conjunto de linhas, para o status "Pago" poder zerar a cada novo mês.

import { supabase, isSupabaseEnabled } from "./supabaseClient.js";

const LOCAL_KEY = "painel-gabi-v1";

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || { expenses: [], students: [] }; }
  catch (e) { return { expenses: [], students: [] }; }
}
function writeLocal(state) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch (e) {}
}

// Busca despesas e alunos ativos do mês/ano informado.
export async function fetchData(month, year) {
  if (!isSupabaseEnabled) {
    const local = readLocal();
    return {
      expenses: (local.expenses || []).filter((e) => e.month === month && e.year === year),
      students: (local.students || []).filter((s) => s.month === month && s.year === year && s.active !== false),
    };
  }

  const [{ data: expenses, error: expErr }, { data: students, error: stuErr }] = await Promise.all([
    supabase.from("expenses").select("*").eq("month", month).eq("year", year).order("created_at"),
    supabase.from("students").select("*").eq("month", month).eq("year", year).eq("active", true).order("created_at"),
  ]);
  if (expErr || stuErr) { console.error(expErr || stuErr); return { expenses: [], students: [] }; }
  return { expenses, students };
}

// Atualiza campos de uma despesa (ex.: { amount: 90.5 } ao editar o valor inline).
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

// Marca/desmarca uma despesa como paga (checkbox "Pago").
export async function togglePaid(id, isPaid) {
  return updateExpense(id, { is_paid: isPaid });
}

// Insere uma nova despesa (usado pelo formulário "+ Nova despesa").
export async function insertExpense({ description, category, amount, dueDate, month, year }) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.expenses.push({
      id: crypto.randomUUID(),
      description, category, amount, month, year,
      due_date: dueDate || null,
      is_paid: false,
    });
    writeLocal(state);
    return;
  }
  const { error } = await supabase
    .from("expenses")
    .insert({ description, category, amount, month, year, due_date: dueDate || null, is_paid: false });
  if (error) console.error(error);
}

// Remove uma despesa (botão de excluir na linha da tabela).
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

// "Remove" um aluno via soft-delete (active = false), preservando o histórico.
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

// Insere um novo aluno no mês/ano informado (usado pelo formulário "+ Novo aluno").
export async function insertStudent({ studentName, guardianName, monthlyFee, month, year }) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.students.push({
      id: crypto.randomUUID(),
      student_name: studentName,
      guardian_name: guardianName,
      monthly_fee: monthlyFee,
      active: true,
      paid: false,
      payment_date: null,
      month, year,
    });
    writeLocal(state);
    return;
  }
  const { error } = await supabase.from("students").insert({
    student_name: studentName,
    guardian_name: guardianName,
    monthly_fee: monthlyFee,
    active: true,
    paid: false,
    payment_date: null,
    month, year,
  });
  if (error) console.error(error);
}

// Marca/desmarca a mensalidade de um aluno como paga, registrando a data do pagamento.
export async function toggleStudentPaid(id, isPaid) {
  const payment_date = isPaid ? new Date().toISOString().slice(0, 10) : null;
  if (!isSupabaseEnabled) {
    const state = readLocal();
    const s = state.students.find((s) => s.id === id);
    if (s) { s.paid = isPaid; s.payment_date = payment_date; }
    writeLocal(state);
    return;
  }
  const { error } = await supabase.from("students").update({ paid: isPaid, payment_date }).eq("id", id);
  if (error) console.error(error);
}

// Move um dia de vencimento para outro mês/ano, ajustando para o último dia
// do mês se ele for mais curto (ex.: dia 31 clonado para um mês de 30 dias).
function shiftDueDate(dueDate, toMonth, toYear) {
  if (!dueDate) return null;
  const day = Number(String(dueDate).split("-")[2]);
  const lastDay = new Date(toYear, toMonth, 0).getDate();
  const clampedDay = Math.min(day, lastDay);
  return toYear + "-" + String(toMonth).padStart(2, "0") + "-" + String(clampedDay).padStart(2, "0");
}

// Se o mês de destino ainda não tiver nenhuma despesa/aluno, clona a base do
// mês anterior (nomes, categorias, valores, vencimentos) com o status "Pago"
// zerado. Se o mês de destino já tiver dados, não faz nada (evita duplicar).
export async function cloneMonthIfEmpty(fromMonth, fromYear, toMonth, toYear) {
  const current = await fetchData(toMonth, toYear);
  if (current.expenses.length || current.students.length) return current;

  const source = await fetchData(fromMonth, fromYear);
  if (!source.expenses.length && !source.students.length) return current;

  const expensesToInsert = source.expenses.map((e) => ({
    description: e.description,
    category: e.category,
    amount: e.amount,
    due_date: shiftDueDate(e.due_date, toMonth, toYear),
    is_paid: false,
    month: toMonth,
    year: toYear,
  }));
  const studentsToInsert = source.students.map((s) => ({
    student_name: s.student_name,
    guardian_name: s.guardian_name,
    monthly_fee: s.monthly_fee,
    active: true,
    paid: false,
    payment_date: null,
    month: toMonth,
    year: toYear,
  }));

  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.expenses = (state.expenses || []).concat(expensesToInsert.map((e) => ({ id: crypto.randomUUID(), ...e })));
    state.students = (state.students || []).concat(studentsToInsert.map((s) => ({ id: crypto.randomUUID(), ...s })));
    writeLocal(state);
    return fetchData(toMonth, toYear);
  }

  if (expensesToInsert.length) {
    const { error } = await supabase.from("expenses").insert(expensesToInsert);
    if (error) console.error(error);
  }
  if (studentsToInsert.length) {
    const { error } = await supabase.from("students").insert(studentsToInsert);
    if (error) console.error(error);
  }
  return fetchData(toMonth, toYear);
}

// Assina mudanças em tempo real (outro dispositivo pagou uma conta, adicionou
// aluno etc.) e chama onChange para o app re-buscar e re-renderizar.
// Retorna uma função para cancelar a assinatura (chame ao desmontar a página).
export function subscribeRealtime(onChange) {
  if (!isSupabaseEnabled) return () => {};

  const channel = supabase
    .channel("painel-gabi-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "expenses" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "students" }, onChange)
    .subscribe();

  return () => supabase.removeChannel(channel);
}
