// persistence.js
// Camada de dados: lê/escreve no Supabase quando configurado, senão usa o
// mesmo localStorage já usado pelo painel (chave "painel-gabi-v1").

import { supabase, isSupabaseEnabled } from "./supabaseClient.js";

const LOCAL_KEY = "painel-gabi-v1";

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || { expenses: [], students: [] }; }
  catch (e) { return { expenses: [], students: [] }; }
}
function writeLocal(state) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch (e) {}
}

// Busca despesas do mês/ano informado e os alunos ativos.
export async function fetchData(month, year) {
  if (!isSupabaseEnabled) return readLocal();

  const [{ data: expenses, error: expErr }, { data: students, error: stuErr }] = await Promise.all([
    supabase.from("expenses").select("*").eq("month", month).eq("year", year).order("created_at"),
    supabase.from("students").select("*").eq("active", true).order("created_at"),
  ]);
  if (expErr || stuErr) { console.error(expErr || stuErr); return readLocal(); }
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
export async function insertExpense({ description, category, amount, month, year }) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.expenses.push({
      id: crypto.randomUUID(),
      description, category, amount, month, year,
      is_paid: false,
    });
    writeLocal(state);
    return;
  }
  const { error } = await supabase
    .from("expenses")
    .insert({ description, category, amount, month, year, is_paid: false });
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

// Insere um novo aluno (usado pelo formulário "+ Novo aluno").
export async function insertStudent({ studentName, guardianName, monthlyFee }) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.students.push({
      id: crypto.randomUUID(),
      student_name: studentName,
      guardian_name: guardianName,
      monthly_fee: monthlyFee,
      active: true,
    });
    writeLocal(state);
    return;
  }
  const { error } = await supabase.from("students").insert({
    student_name: studentName,
    guardian_name: guardianName,
    monthly_fee: monthlyFee,
    active: true,
  });
  if (error) console.error(error);
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
