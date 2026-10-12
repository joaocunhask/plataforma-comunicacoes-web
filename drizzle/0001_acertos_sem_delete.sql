-- sys_negocio_acertos é append-only: um acerto errado corrige-se com outro acerto.
-- O histórico é a prova para reclamar à Vodafone, que dá 12 meses de prazo.
-- Equivalente ao trigger tr_sys_negocio_acertos_sem_delete do SQL Server.
CREATE OR REPLACE FUNCTION sys_negocio_acertos_sem_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sys_negocio_acertos nao pode ser apagada: um acerto errado corrige-se com outro acerto. O historico e a prova para reclamar a Vodafone, que da 12 meses de prazo.'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tr_sys_negocio_acertos_sem_delete
  BEFORE DELETE ON sys_negocio_acertos
  FOR EACH ROW EXECUTE FUNCTION sys_negocio_acertos_sem_delete();
--> statement-breakpoint
-- O SQL Server só apanha DELETE; em Postgres TRUNCATE não dispara triggers de linha, por isso bloqueia-se à parte.
CREATE TRIGGER tr_sys_negocio_acertos_sem_truncate
  BEFORE TRUNCATE ON sys_negocio_acertos
  FOR EACH STATEMENT EXECUTE FUNCTION sys_negocio_acertos_sem_delete();
