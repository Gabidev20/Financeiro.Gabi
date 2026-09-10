-- supabase-schema.sql
-- Rode isto no SQL Editor do Supabase (projeto novo ou existente).

create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  description text not null,
  category    text not null,
  amount      numeric(10,2) not null default 0,
  is_paid     boolean not null default false,
  is_fixed    boolean not null default false, -- repete automaticamente nos próximos meses
  due_date    date,                   -- vencimento da conta
  month       smallint not null,      -- 1-12
  year        smallint not null,      -- ex.: 2026
  created_at  timestamptz not null default now()
);

-- MIGRAÇÃO (rodada 5) — despesas fixas dinâmicas (sem lista fixa no código)
alter table public.expenses add column if not exists is_fixed boolean not null default false;

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

alter table public.expenses enable row level security;
alter table public.students enable row level security;
alter table public.student_payments enable row level security;

-- MIGRAÇÃO (rodada 4) — Login com Supabase Auth
-- Cada linha passa a pertencer a um usuário (auth.users). O RLS "allow all"
-- de antes vira "só o dono enxerga/edita as próprias linhas".

drop policy if exists "allow all - expenses" on public.expenses;
drop policy if exists "allow all - students" on public.students;
drop policy if exists "allow all - student_payments" on public.student_payments;

alter table public.expenses         add column if not exists user_id uuid references auth.users(id) default auth.uid();
alter table public.students         add column if not exists user_id uuid references auth.users(id) default auth.uid();
alter table public.student_payments add column if not exists user_id uuid references auth.users(id) default auth.uid();

create policy "own rows - expenses" on public.expenses
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own rows - students" on public.students
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own rows - student_payments" on public.student_payments
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- IMPORTANTE — os dados que já existiam (de antes do login existir, ex.:
-- Setembro/2026) ficam com user_id nulo e, com a policy nova, INVISÍVEIS pra
-- todo mundo até você rodar o passo abaixo:
--
-- 1. Crie sua conta pelo próprio painel (aba "Criar conta") e confirme o e-mail.
-- 2. No Supabase: Authentication > Users > copie o "UID" da sua conta.
-- 3. Rode (trocando o texto entre aspas pelo UID copiado):
--
--    update public.students         set user_id = 'COLE-SEU-UID-AQUI' where user_id is null;
--    update public.expenses         set user_id = 'COLE-SEU-UID-AQUI' where user_id is null;
--    update public.student_payments set user_id = 'COLE-SEU-UID-AQUI' where user_id is null;

-- MIGRAÇÃO (rodada 6) — personalização de workspace por usuário
create table if not exists public.user_settings (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  workspace_title       text not null default 'Meu Controle Financeiro',
  workspace_subtitle    text not null default '',
  revenue_section_title text not null default 'Receitas & Clientes',
  item_label            text not null default 'Cliente / Serviço',
  created_at            timestamptz not null default now()
);

alter publication supabase_realtime add table public.user_settings;

alter table public.user_settings enable row level security;

create policy "own row - user_settings" on public.user_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Preserva a identidade atual da sua conta (troque o UID pelo mesmo que você
-- já usou nas migrações anteriores) — sem isso, ela nasceria com os rótulos
-- neutros como qualquer conta nova:
insert into public.user_settings (user_id, workspace_title, workspace_subtitle, revenue_section_title, item_label)
values (
  'COLE-SEU-UID-AQUI',
  'Aulas de Inglês da Gabi',
  'Mensalidades de alunos e despesas do mês, com baixa em tempo real.',
  'Alunos & mensalidades',
  'Aluno'
)
on conflict (user_id) do nothing;
