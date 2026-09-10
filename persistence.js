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
// - user_settings: 1 linha por usuário — nome do workspace e rótulos da tela.
// - students: cadastro global de alunos — não muda de mês.
// - student_payments: status de pagamento por aluno/mês/ano (1 linha por combinação).
// - expenses: despesas por mês/ano — despesas fixas são clonadas do histórico
//   do próprio usuário na primeira visita a um mês vazio.

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

// ---- configurações do workspace (por usuário) ----

const DEFAULT_SETTINGS = {
  workspace_title: "Meu Controle Financeiro",
  workspace_subtitle: "",
  revenue_section_title: "Receitas & Clientes",
  item_label: "Cliente / Serviço",
};

// Conta original do painel — se um dia rodar sem o backfill manual de SQL
// (ou num ambiente novo), o primeiro acesso já nasce com a identidade certa
// em vez dos rótulos neutros de conta nova.
const KNOWN_ACCOUNT_DEFAULTS = {
  "fabiagabriela13@gmail.com": {
    workspace_title: "Aulas de Inglês da Gabi",
    workspace_subtitle: "Mensalidades de alunos e despesas do mês, com baixa em tempo real.",
    revenue_section_title: "Alunos & mensalidades",
    item_label: "Aluno",
  },
};

// Busca as configurações da conta logada. Se ainda não existir nenhuma linha
// (primeiro acesso do usuário), cria com os valores padrão e devolve já
// criada — neutros pra qualquer conta nova, ou os de KNOWN_ACCOUNT_DEFAULTS
// se o e-mail bater com uma conta conhecida. Um upsert simples não serve
// aqui: sobrescreveria os valores já personalizados toda vez que a página
// carrega — por isso é select, e só insere se realmente não existir nada.
export async function getOrCreateSettings(userId, email) {
  const defaults = (email && KNOWN_ACCOUNT_DEFAULTS[email]) || DEFAULT_SETTINGS;

  if (!isSupabaseEnabled) {
    const state = readLocal();
    if (!state.settings) {
      state.settings = { user_id: userId, ...defaults };
      writeLocal(state);
    }
    return state.settings;
  }
  try {
    const { data, error } = await supabase.from("user_settings").select("*").eq("user_id", userId).maybeSingle();
    if (error) { logSupabaseError("getOrCreateSettings", { userId }, error); return { user_id: userId, ...defaults }; }
    if (data) return data;

    const { data: created, error: insertError } = await supabase
      .from("user_settings")
      .insert({ user_id: userId, ...defaults })
      .select()
      .single();
    if (insertError) { logSupabaseError("getOrCreateSettings:insert", { userId }, insertError); return { user_id: userId, ...defaults }; }
    return created;
  } catch (err) {
    logSupabaseError("getOrCreateSettings", { userId }, err);
    return { user_id: userId, ...defaults };
  }
}

// Atualiza um ou mais rótulos (título, subtítulo, nome da seção, nome do
// item) ao sair do campo editável. Devolve true se o Supabase confirmou.
export async function updateSettings(userId, patch) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.settings = { ...(state.settings || { user_id: userId, ...DEFAULT_SETTINGS }), ...patch };
    writeLocal(state);
    return true;
  }
  try {
    const { data, error } = await supabase.from("user_settings").update(patch).eq("user_id", userId).select();
    if (error) { logSupabaseError("updateSettings", { userId, patch }, error); return false; }
    if (!data || !data.length) {
      console.warn("[persistence] updateSettings não alterou nenhuma linha (id inexistente ou bloqueado por RLS)", { userId, patch });
      return false;
    }
    return true;
  } catch (err) {
    logSupabaseError("updateSettings", { userId, patch }, err);
    return false;
  }
}

// ---- alunos (cadastro global) ----

// Alunos ativos da conta logada. O RLS já isola por dono sozinho, mas
// filtramos por user_id aqui também, explicitamente — nunca dependemos só
// da política do banco para não misturar dados entre contas.
async function fetchActiveStudents(userId) {
  if (!isSupabaseEnabled) {
    return (readLocal().students || []).filter((s) => s.active !== false);
  }
  try {
    const { data, error } = await supabase
      .from("students").select("*").eq("active", true).eq("user_id", userId).order("created_at");
    if (error) { logSupabaseError("fetchActiveStudents", { userId }, error); return []; }
    return data || [];
  } catch (err) {
    logSupabaseError("fetchActiveStudents", { userId }, err);
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

async function fetchPayments(month, year, userId) {
  if (!isSupabaseEnabled) {
    return (readLocal().payments || []).filter((p) => p.month === month && p.year === year);
  }
  try {
    const { data, error } = await supabase
      .from("student_payments").select("*").eq("month", month).eq("year", year).eq("user_id", userId);
    if (error) { logSupabaseError("fetchPayments", { month, year, userId }, error); return []; }
    return data || [];
  } catch (err) {
    logSupabaseError("fetchPayments", { month, year, userId }, err);
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

// ---- despesas (por mês/ano, com clonagem dinâmica das despesas fixas) ----

async function fetchExpenses(month, year, userId) {
  if (!isSupabaseEnabled) {
    return (readLocal().expenses || []).filter((e) => e.month === month && e.year === year);
  }
  try {
    const { data, error } = await supabase
      .from("expenses")
      .select("*")
      .eq("month", month)
      .eq("year", year)
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    if (error) { logSupabaseError("fetchExpenses", { month, year, userId }, error); return []; }
    return data || [];
  } catch (err) {
    logSupabaseError("fetchExpenses", { month, year, userId }, err);
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
// isFixed marca a despesa para ser clonada automaticamente todo mês (ver
// cloneFixedExpensesIfEmpty) — despesas não fixas pertencem só a este mês.
export async function insertExpense({ description, category, amount, dueDate, month, year, userId, isFixed }) {
  const payload = { description, category, amount, due_date: dueDate || null, is_paid: false, is_fixed: !!isFixed, month, year, user_id: userId };
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

// Busca as despesas marcadas como fixas (is_fixed = true) que o usuário já
// cadastrou em qualquer mês anterior ao (month, year) informado. Não existe
// lista fixa nenhuma no código — tudo vem do que o próprio usuário marcou.
async function fetchFixedExpenseTemplates(month, year, userId) {
  if (!isSupabaseEnabled) {
    return (readLocal().expenses || []).filter((e) =>
      e.is_fixed && (e.year < year || (e.year === year && e.month < month))
    );
  }
  try {
    const { data, error } = await supabase
      .from("expenses")
      .select("*")
      .eq("is_fixed", true)
      .eq("user_id", userId);
    if (error) { logSupabaseError("fetchFixedExpenseTemplates", { month, year, userId }, error); return []; }
    return (data || []).filter((e) => e.year < year || (e.year === year && e.month < month));
  } catch (err) {
    logSupabaseError("fetchFixedExpenseTemplates", { month, year, userId }, err);
    return [];
  }
}

// Se a mesma despesa fixa (mesma descrição) existir em vários meses antigos
// (porque já foi clonada antes), fica só com a ocorrência mais recente — não
// insere uma cópia por mês de histórico, só a "versão atual" de cada uma.
function latestPerDescription(rows) {
  const byDescription = {};
  rows.forEach((r) => {
    const rank = r.year * 12 + r.month;
    const existing = byDescription[r.description];
    if (!existing || rank > existing._rank) byDescription[r.description] = { ...r, _rank: rank };
  });
  return Object.values(byDescription);
}

// Se o mês/ano informado ainda não tiver nenhuma despesa, clona as fixas mais
// recentes do usuário (com "Pago" zerado) para este mês. Sem nenhuma despesa
// fixa cadastrada, o mês simplesmente fica vazio — não existe modelo padrão
// fixo no código. userId é obrigatório: sem ele o insert é barrado pelo RLS.
async function cloneFixedExpensesIfEmpty(month, year, userId) {
  const current = await fetchExpenses(month, year, userId);
  if (current.length) return current;

  const templates = latestPerDescription(await fetchFixedExpenseTemplates(month, year, userId));
  if (!templates.length) return current;

  const toInsert = templates.map((e) => ({
    description: e.description,
    category: e.category,
    amount: e.amount,
    is_fixed: true,
    is_paid: false,
    due_date: null,
    month, year,
    user_id: userId,
  }));

  if (!isSupabaseEnabled) {
    const rows = toInsert.map((e) => ({ id: crypto.randomUUID(), ...e }));
    const state = readLocal();
    state.expenses = (state.expenses || []).concat(rows);
    writeLocal(state);
    return rows;
  }

  try {
    const { data, error } = await supabase.from("expenses").insert(toInsert).select();
    if (error) { logSupabaseError("cloneFixedExpensesIfEmpty", { month, year, toInsert }, error); return []; }
    return data || [];
  } catch (err) {
    logSupabaseError("cloneFixedExpensesIfEmpty", { month, year, toInsert }, err);
    return [];
  }
}

// ---- carregamento do mês ativo ----

// Chamada ao trocar de mês, ao carregar a página, e a cada evento realtime:
// - os alunos ativos são sempre os mesmos, em qualquer mês (cadastro global
//   da conta), filtrados explicitamente por user_id;
// - o status de pagamento de cada aluno vem de student_payments, filtrado por
//   month/year e user_id;
// - despesas: se o mês estiver vazio, as fixas mais recentes do usuário são
//   clonadas para cá; sem nenhuma fixa cadastrada, o mês fica vazio de verdade
//   (não existe modelo padrão embutido no código).
export async function loadMonthData(month, year, userId) {
  const [students, payments] = await Promise.all([
    fetchActiveStudents(userId),
    fetchPayments(month, year, userId),
  ]);

  const paymentByStudent = {};
  payments.forEach((p) => { paymentByStudent[p.student_id] = p; });

  const studentsWithStatus = students.map((s) => {
    const p = paymentByStudent[s.id];
    return { ...s, is_paid: p ? p.is_paid : false, payment_date: p ? p.payment_date : null };
  });

  const expenses = await cloneFixedExpensesIfEmpty(month, year, userId);

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
    .on("postgres_changes", { event: "*", schema: "public", table: "user_settings" }, onChange)
    .subscribe((status, err) => {
      if (err) console.error("[persistence] falha ao assinar o realtime", err);
    });

  return () => supabase.removeChannel(channel);
}
