// auth.js
// Autenticação com Supabase Auth. Sem Supabase configurado, não existe tela
// de login — o painel roda direto em modo local (ver supabaseClient.js).

import { supabase, isSupabaseEnabled } from "./supabaseClient.js";

// Sessão atual, se houver (null se deslogado ou sem Supabase configurado).
export async function getSession() {
  if (!isSupabaseEnabled) return null;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) { console.error("[auth] getSession falhou", error); return null; }
    return data.session;
  } catch (err) {
    console.error("[auth] getSession falhou", err);
    return null;
  }
}

// Login por e-mail/senha. Devolve { session } ou { error }.
export async function signIn(email, password) {
  if (!isSupabaseEnabled) return { error: { message: "Supabase não configurado." } };
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error };
    return { session: data.session };
  } catch (err) {
    return { error: err };
  }
}

// Cadastro por e-mail/senha. Se o projeto exigir confirmação de e-mail (padrão
// do Supabase), data.session vem null — needsConfirmation avisa a UI disso.
export async function signUp(email, password) {
  if (!isSupabaseEnabled) return { error: { message: "Supabase não configurado." } };
  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { error };
    return { session: data.session, needsConfirmation: !data.session };
  } catch (err) {
    return { error: err };
  }
}

export async function signOut() {
  if (!isSupabaseEnabled) return;
  try {
    const { error } = await supabase.auth.signOut();
    if (error) console.error("[auth] signOut falhou", error);
  } catch (err) {
    console.error("[auth] signOut falhou", err);
  }
}

// Chama callback(session) sempre que o estado de login mudar (login, logout,
// token renovado). Devolve uma função para cancelar a assinatura.
export function onAuthChange(callback) {
  if (!isSupabaseEnabled) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}
