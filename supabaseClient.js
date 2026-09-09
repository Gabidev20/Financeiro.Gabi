// supabaseClient.js
// Cliente único do Supabase, carregado via CDN (ESM) — sem passo de build.
// Se as chaves não estiverem definidas, isSupabaseEnabled fica false e o
// restante do app (persistence.js) cai automaticamente para localStorage.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// Defina estes valores em uma tag <script> antes de importar este módulo, ex.:
//   <script>
//     window.SUPABASE_URL = "https://SEU-PROJETO.supabase.co";
//     window.SUPABASE_ANON_KEY = "sua-chave-anon-publica";
//   </script>
//   <script type="module" src="supabaseClient.js"></script>
// A anon key é feita para ficar no client — quem protege os dados é a
// Row Level Security das tabelas (ver supabase-schema.sql), não o segredo da chave.
const SUPABASE_URL = window.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "";

export const isSupabaseEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = isSupabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;
