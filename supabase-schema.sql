-- supabase-schema.sql
-- Rode isto no SQL Editor do Supabase (projeto novo ou existente).

create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  description text not null,
  category    text not null,
  amount      numeric(10,2) not null default 0,
  is_paid     boolean not null default false,
  due_date    date,                   -- vencimento da conta
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
  paid          boolean not null default false,
  payment_date  date,                 -- dia em que a mensalidade foi recebida
  month         smallint not null,    -- alunos agora são por mês/ano, para o "Pago" zerar a cada mês novo
  year          smallint not null,
  created_at    timestamptz not null default now()
);

-- MIGRAÇÃO — rode isto se as tabelas expenses/students já existiam antes desta versão:
alter table public.expenses add column if not exists due_date date;
alter table public.students add column if not exists paid boolean not null default false;
alter table public.students add column if not exists payment_date date;
alter table public.students add column if not exists month smallint;
alter table public.students add column if not exists year smallint;
-- Alunos que já existiam (sem month/year) pertencem ao mês ativo atual — ajuste se for outro:
update public.students set month = 9, year = 2026 where month is null;
alter table public.students alter column month set not null;
alter table public.students alter column year set not null;

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
