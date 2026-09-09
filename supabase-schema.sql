-- supabase-schema.sql
-- Rode isto no SQL Editor do Supabase (projeto novo ou existente).

create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  description text not null,
  category    text not null,
  amount      numeric(10,2) not null default 0,
  is_paid     boolean not null default false,
  month       smallint not null,      -- 1-12
  year        smallint not null,      -- ex.: 2026
  created_at  timestamptz not null default now()
);

create table if not exists public.students (
  id            uuid primary key default gen_random_uuid(),
  student_name  text not null,
  guardian_name text not null,
  monthly_fee   numeric(10,2) not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Habilita o realtime (necessário para o supabase.channel().on('postgres_changes', ...) funcionar)
alter publication supabase_realtime add table public.expenses;
alter publication supabase_realtime add table public.students;

-- RLS: app pessoal, sem login — a chave anon do client tem acesso total às
-- duas tabelas. Isso é aceitável para uso próprio, mas qualquer pessoa com a
-- URL do projeto + anon key consegue ler/escrever os dados. Se o painel for
-- compartilhado com terceiros no futuro, troque estas policies por regras
-- baseadas em auth.uid().
alter table public.expenses enable row level security;
alter table public.students enable row level security;

create policy "allow all - expenses" on public.expenses
  for all using (true) with check (true);

create policy "allow all - students" on public.students
  for all using (true) with check (true);
