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

-- Alunos são um cadastro global: não pertencem a um mês, por isso não somem
-- ao navegar. O status de pagamento de cada mês vive em student_payments.
create table if not exists public.students (
  id            uuid primary key default gen_random_uuid(),
  student_name  text not null,
  guardian_name text not null,
  monthly_fee   numeric(10,2) not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists public.student_payments (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.students(id) on delete cascade,
  month        smallint not null,
  year         smallint not null,
  is_paid      boolean not null default false,
  payment_date date,
  created_at   timestamptz not null default now(),
  unique (student_id, month, year)
);

-- MIGRAÇÃO (rodada 3) — desfaz o month/year que tínhamos colocado direto em
-- students numa versão anterior, preservando o que já foi marcado como pago
-- ao movê-lo para student_payments (criada acima) antes de remover as colunas antigas.
insert into public.student_payments (student_id, month, year, is_paid, payment_date)
select id, month, year, coalesce(paid, false), payment_date
from public.students
where month is not null and year is not null
on conflict (student_id, month, year) do nothing;

alter table public.students alter column month drop not null;
alter table public.students alter column year drop not null;
alter table public.students drop column if exists paid;
alter table public.students drop column if exists payment_date;
alter table public.students drop column if exists month;
alter table public.students drop column if exists year;

-- Habilita o realtime (necessário para o supabase.channel().on('postgres_changes', ...) funcionar)
alter publication supabase_realtime add table public.expenses;
alter publication supabase_realtime add table public.students;
alter publication supabase_realtime add table public.student_payments;

-- RLS: app pessoal, sem login — a chave anon do client tem acesso total às
-- tabelas. Isso é aceitável para uso próprio, mas qualquer pessoa com a URL
-- do projeto + anon key consegue ler/escrever os dados. Se o painel for
-- compartilhado com terceiros no futuro, troque estas policies por regras
-- baseadas em auth.uid().
alter table public.expenses enable row level security;
alter table public.students enable row level security;
alter table public.student_payments enable row level security;

create policy "allow all - expenses" on public.expenses
  for all using (true) with check (true);

create policy "allow all - students" on public.students
  for all using (true) with check (true);

create policy "allow all - student_payments" on public.student_payments
  for all using (true) with check (true);
