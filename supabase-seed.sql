-- supabase-seed.sql
-- Opcional: popula as tabelas com os dados de Setembro/2026 que já estavam no
-- painel. Rode uma única vez, depois de supabase-schema.sql, só se as tabelas
-- ainda estiverem vazias (rodar de novo duplica as linhas).

insert into public.students (student_name, guardian_name, monthly_fee, active, month, year) values
  ('Jasmine',   'Valquíria',      150, true, 9, 2026),
  ('Ravi',      'Anne Leal',      180, true, 9, 2026),
  ('Arthur',    'Cássia Lorena',  180, true, 9, 2026),
  ('Heloize',   'Hilmara',        180, true, 9, 2026),
  ('Théo',      'Andreza',        180, true, 9, 2026),
  ('Leticia',   'Tatiane',        180, true, 9, 2026),
  ('Beatriz',   'Priscila',       180, true, 9, 2026),
  ('Ana Clara', 'Francine',       210, true, 9, 2026),
  ('Tom',       'Tatá',           180, true, 9, 2026),
  ('Aninha',    'Nely',           210, true, 9, 2026),
  ('Teles',     'Wanessa',        210, true, 9, 2026),
  ('Sofia',     'Kamila',         210, true, 9, 2026);

insert into public.expenses (description, category, amount, is_paid, due_date, month, year) values
  ('Cartão de crédito',       'Cartão',      877.38, false, '2026-09-10', 9, 2026),
  ('Crédito de celular',      'Celular',      30.00, true,  '2026-09-05', 9, 2026),
  ('Aluguel das casas',       'Moradia',     125.00, false, '2026-09-05', 9, 2026),
  ('Farmácia',                'Saúde',        27.00, false, '2026-09-15', 9, 2026),
  ('DAS - empresa (Pix)',     'Empresa',      87.05, false, '2026-09-20', 9, 2026),
  ('TV parcela (Pix)',        'Assinaturas',  60.00, true,  '2026-09-08', 9, 2026),
  ('Lavagem de roupas (Pix)', 'Serviços',     80.00, false, '2026-09-12', 9, 2026),
  ('Gastos extras',           'Extras',      197.00, false, '2026-09-25', 9, 2026);
