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
// - students (receitas): por mês/ano, igual expenses — as marcadas is_fixed
//   são clonadas pro próximo mês vazio; as pontuais existem só onde nasceram.
// - expenses: despesas por mês/ano — despesas fixas são clonadas do histórico
//   do próprio usuário na primeira visita a um mês vazio.

import { supabase, isSupabaseEnabled } from "./supabaseClient.js";

const LOCAL_KEY = "painel-gabi-v1";

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || { expenses: [], students: [] }; }
  catch (e) { return { expenses: [], students: [] }; }
}
function writeLocal(state) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch (e) {}
}
function logSupabaseError(op, payload, error) {
  console.error("[persistence] " + op + " falhou — confira RLS/schema no Supabase", { payload, error });
}
// Entre várias ocorrências históricas da mesma fixa (mesmo nome/descrição),
// fica só com a mais recente — não insere uma cópia por mês de histórico.
function latestByKey(rows, keyOf) {
  const byKey = {};
  rows.forEach((r) => {
    const key = keyOf(r);
    const rank = r.year * 12 + r.month;
    const existing = byKey[key];
    if (!existing || rank > existing._rank) byKey[key] = { ...r, _rank: rank };
  });
  return Object.values(byKey);
}

// ---- configurações do workspace (por usuário) ----

const DEFAULT_SETTINGS = {
  workspace_title: "Meu Controle Financeiro",
  workspace_subtitle: "",
  revenue_section_title: "Receitas & Clientes",
  item_label: "Cliente / Serviço",
  pix_key: "",
  emergency_fund: 0,
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
    pix_key: "92984959683",
    emergency_fund: 0,
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

// ---- alunos / receitas (por mês/ano, com clonagem dinâmica das fixas) ----

async function fetchStudents(month, year, userId) {
  if (!isSupabaseEnabled) {
    return (readLocal().students || []).filter((s) => s.month === month && s.year === year);
  }
  try {
    const { data, error } = await supabase
      .from("students").select("*").eq("month", month).eq("year", year).eq("user_id", userId).order("created_at");
    if (error) { logSupabaseError("fetchStudents", { month, year, userId }, error); return []; }
    return data || [];
  } catch (err) {
    logSupabaseError("fetchStudents", { month, year, userId }, err);
    return [];
  }
}

// Insere um novo aluno/receita neste mês/ano. Devolve a linha salva (com o id
// real do Supabase) ou null se a gravação falhar. userId é o id da sessão
// ativa. isFixed marca a receita para ser clonada automaticamente todo mês
// (ver ensureFixedStudents) — não fixas pertencem só a este mês.
export async function insertStudent({ studentName, guardianName, monthlyFee, phone, month, year, userId, isFixed }) {
  const payload = {
    student_name: studentName, guardian_name: guardianName, monthly_fee: monthlyFee, phone: phone || null,
    is_fixed: !!isFixed, is_paid: false, payment_date: null, month, year, user_id: userId,
  };
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

// Remove um aluno/receita (botão de excluir na linha) — some só deste mês.
// Uma fixa removida aqui não impede meses futuros de clonarem a ocorrência
// anterior mais recente que ainda existir.
export async function removeStudent(id) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    state.students = state.students.filter((s) => s.id !== id);
    writeLocal(state);
    return true;
  }
  try {
    const { error } = await supabase.from("students").delete().eq("id", id);
    if (error) { logSupabaseError("removeStudent", { id }, error); return false; }
    return true;
  } catch (err) {
    logSupabaseError("removeStudent", { id }, err);
    return false;
  }
}

// Atualiza campos de um aluno/receita pelo id real do Supabase (nunca por
// índice de array). Devolve true só se o Supabase confirmou ter alterado a
// linha — zero linhas afetadas sem erro geralmente é RLS bloqueando ou id errado.
export async function updateStudent(id, patch) {
  if (!isSupabaseEnabled) {
    const state = readLocal();
    const s = state.students.find((s) => s.id === id);
    if (s) Object.assign(s, patch);
    writeLocal(state);
    return true;
  }
  try {
    const { data, error } = await supabase.from("students").update(patch).eq("id", id).select();
    if (error) { logSupabaseError("updateStudent", { id, patch }, error); return false; }
    if (!data || !data.length) {
      console.warn("[persistence] updateStudent não alterou nenhuma linha (id inexistente ou bloqueado por RLS)", { id, patch });
      return false;
    }
    return true;
  } catch (err) {
    logSupabaseError("updateStudent", { id, patch }, err);
    return false;
  }
}

// Marca/desmarca o pagamento de um aluno/receita, registrando a data do clique.
export async function toggleStudentPaid(id, isPaid, paymentDate) {
  return updateStudent(id, {
    is_paid: isPaid,
    payment_date: isPaid ? (paymentDate || new Date().toISOString().slice(0, 10)) : null,
  });
}

// Busca os alunos/receitas marcados como fixos que o usuário já cadastrou em
// qualquer mês anterior ao (month, year) informado.
async function fetchFixedStudentTemplates(month, year, userId) {
  if (!isSupabaseEnabled) {
    return (readLocal().students || []).filter((s) =>
      s.is_fixed && (s.year < year || (s.year === year && s.month < month))
    );
  }
  try {
    const { data, error } = await supabase.from("students").select("*").eq("is_fixed", true).eq("user_id", userId);
    if (error) { logSupabaseError("fetchFixedStudentTemplates", { month, year, userId }, error); return []; }
    return (data || []).filter((s) => s.year < year || (s.year === year && s.month < month));
  } catch (err) {
    logSupabaseError("fetchFixedStudentTemplates", { month, year, userId }, err);
    return [];
  }
}

// Garante que toda receita fixa do usuário já exista neste mês/ano — não só
// quando o mês está totalmente vazio. Antes, uma parcela de cartão ou
// qualquer outro registro isolado no mês fazia a checagem de "lista vazia"
// falhar e as fixas nunca eram instanciadas; agora cada fixa é conferida por
// student_name individualmente e só a que ainda falta é inserida.
async function ensureFixedStudents(month, year, userId) {
  const current = await fetchStudents(month, year, userId);

  const templates = latestByKey(await fetchFixedStudentTemplates(month, year, userId), (s) => s.student_name);
  if (!templates.length) return current;

  const existingNames = new Set(current.map((s) => s.student_name));
  const missing = templates.filter((s) => !existingNames.has(s.student_name));
  if (!missing.length) return current;

  const toInsert = missing.map((s) => ({
    student_name: s.student_name,
    guardian_name: s.guardian_name,
    monthly_fee: s.monthly_fee,
    phone: s.phone || null,
    is_fixed: true,
    is_paid: false,
    payment_date: null,
    month, year,
    user_id: userId,
  }));

  if (!isSupabaseEnabled) {
    const rows = toInsert.map((s) => ({ id: crypto.randomUUID(), ...s }));
    const state = readLocal();
    state.students = (state.students || []).concat(rows);
    writeLocal(state);
    return current.concat(rows);
  }

  try {
    const { data, error } = await supabase.from("students").insert(toInsert).select();
    if (error) { logSupabaseError("ensureFixedStudents", { month, year, toInsert }, error); return current; }
    return current.concat(data || []);
  } catch (err) {
    logSupabaseError("ensureFixedStudents", { month, year, toInsert }, err);
    return current;
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
// ensureFixedExpenses) — despesas não fixas pertencem só a este mês.
export async function insertExpense({ description, category, amount, dueDate, month, year, userId, isFixed, categoryColor }) {
  const payload = {
    description, category, amount, due_date: dueDate || null, is_paid: false, is_fixed: !!isFixed,
    category_color: categoryColor || null, month, year, user_id: userId,
  };
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

// Move um dia (1-31) para o mês/ano informado, ajustando para o último dia
// se o mês for mais curto (ex.: dia 31 caindo num mês de 30 dias).
function dayToIsoForMonth(day, month, year) {
  if (!day) return null;
  const lastDay = new Date(year, month, 0).getDate();
  const clamped = Math.min(Math.max(1, Math.round(day)), lastDay);
  return year + "-" + String(month).padStart(2, "0") + "-" + String(clamped).padStart(2, "0");
}

// Gera uma despesa parcelada: uma linha por parcela, cada uma no seu
// mês/ano subsequente, com "(i/N)" no fim da descrição e is_fixed sempre
// false (a série tem fim — não deve entrar na clonagem de fixas). Devolve
// todas as linhas criadas (com id real) ou null se a gravação falhar.
export async function insertInstallments({ description, category, categoryColor, amount, dueDay, month, year, installments, userId }) {
  const count = Math.max(2, Math.min(60, Math.round(installments) || 2));
  const rows = [];
  let m = month, y = year;
  for (let i = 1; i <= count; i++) {
    rows.push({
      description: description + " (" + i + "/" + count + ")",
      category,
      category_color: categoryColor || null,
      amount,
      due_date: dayToIsoForMonth(dueDay, m, y),
      is_paid: false,
      is_fixed: false,
      month: m,
      year: y,
      user_id: userId,
    });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }

  if (!isSupabaseEnabled) {
    const inserted = rows.map((r) => ({ id: crypto.randomUUID(), ...r }));
    const state = readLocal();
    state.expenses = (state.expenses || []).concat(inserted);
    writeLocal(state);
    return inserted;
  }
  try {
    const { data, error } = await supabase.from("expenses").insert(rows).select();
    if (error) { logSupabaseError("insertInstallments", { rows }, error); return null; }
    return data || [];
  } catch (err) {
    logSupabaseError("insertInstallments", { rows }, err);
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

// Garante que toda despesa fixa do usuário já exista neste mês/ano — não só
// quando o mês está totalmente vazio. Antes, uma parcela de cartão de crédito
// (ou qualquer despesa avulsa) já presente no mês fazia a checagem de "lista
// vazia" falhar, e as fixas de verdade (Aluguel, Internet etc.) nunca eram
// instanciadas junto. Agora cada fixa é conferida por description
// individualmente e só a que ainda falta naquele mês é inserida.
async function ensureFixedExpenses(month, year, userId) {
  const current = await fetchExpenses(month, year, userId);

  const templates = latestByKey(await fetchFixedExpenseTemplates(month, year, userId), (e) => e.description);
  if (!templates.length) return current;

  const existingDescriptions = new Set(current.map((e) => e.description));
  const missing = templates.filter((e) => !existingDescriptions.has(e.description));
  if (!missing.length) return current;

  const toInsert = missing.map((e) => ({
    description: e.description,
    category: e.category,
    amount: e.amount,
    category_color: e.category_color || null,
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
    return current.concat(rows);
  }

  try {
    const { data, error } = await supabase.from("expenses").insert(toInsert).select();
    if (error) { logSupabaseError("ensureFixedExpenses", { month, year, toInsert }, error); return current; }
    return current.concat(data || []);
  } catch (err) {
    logSupabaseError("ensureFixedExpenses", { month, year, toInsert }, err);
    return current;
  }
}

// ---- carregamento do mês ativo ----

// Chamada ao trocar de mês, ao carregar a página, e a cada evento realtime:
// alunos/receitas e despesas seguem a mesma regra — se o mês estiver vazio,
// as fixas mais recentes do usuário são clonadas pra cá (com "Pago" zerado);
// sem nenhuma fixa cadastrada, o mês fica vazio de verdade.
export async function loadMonthData(month, year, userId) {
  const [students, expenses] = await Promise.all([
    ensureFixedStudents(month, year, userId),
    ensureFixedExpenses(month, year, userId),
  ]);
  return { students, expenses };
}

// ---- visão anual ----

function buildYearSummary(expenses, students) {
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const revenue = students.filter((s) => s.month === m).reduce((a, s) => a + Number(s.monthly_fee || 0), 0);
    const expense = expenses.filter((e) => e.month === m).reduce((a, e) => a + Number(e.amount || 0), 0);
    months.push({ month: m, revenue, expense, profit: revenue - expense });
  }
  return months;
}

// Resumo dos 12 meses do ano informado: Receitas, Despesas e Lucro líquido
// por mês, somando todos os registros existentes (pagos ou não). Devolve
// null se a busca falhar — a UI deve tratar isso como erro visível.
export async function fetchYearSummary(year, userId) {
  if (!isSupabaseEnabled) {
    const local = readLocal();
    const expenses = (local.expenses || []).filter((e) => e.year === year);
    const students = (local.students || []).filter((s) => s.year === year);
    return buildYearSummary(expenses, students);
  }
  try {
    const [{ data: expenses, error: expErr }, { data: students, error: stuErr }] = await Promise.all([
      supabase.from("expenses").select("month, amount").eq("year", year).eq("user_id", userId),
      supabase.from("students").select("month, monthly_fee").eq("year", year).eq("user_id", userId),
    ]);
    if (expErr || stuErr) { logSupabaseError("fetchYearSummary", { year, userId }, expErr || stuErr); return null; }
    return buildYearSummary(expenses || [], students || []);
  } catch (err) {
    logSupabaseError("fetchYearSummary", { year, userId }, err);
    return null;
  }
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
    .on("postgres_changes", { event: "*", schema: "public", table: "user_settings" }, onChange)
    .subscribe((status, err) => {
      if (err) console.error("[persistence] falha ao assinar o realtime", err);
    });

  return () => supabase.removeChannel(channel);
}
